import { randomUUID } from "node:crypto";
import {
  boundedText,
  BuildState,
  isTerminalControl,
  normalizeAttempt,
  normalizeSupervisionConfig,
  reduceControl,
  SUPERVISION_LIMITS,
  validateIdentifier,
  validateIdentity,
  type AttemptIdentity,
  type AttemptRegistration,
  type BoundedText,
  type BuildObservation,
  type BuildSnapshot,
  type ControlRecord,
  type ControlStatus,
  type ParentObservation,
  type SessionMapping,
  type SupervisionConfig,
  type TaskSnapshot,
} from "./build-state.ts";
import { type QuestionQueue } from "./question-queue.ts";
import { RpcAgent, type RpcAgentOptions, type RpcClock, type RpcCloseResult, type RpcPromptDisposition, type RpcRecord } from "./rpc-agent.ts";
import { JournalCapacityError, type RunJournal } from "./run-journal.ts";
import { createTaskEvidence, type EvidenceWorkspace, type TaskEvidence, type TaskEvidenceReader, type TaskEvidenceRequest } from "./task-evidence.ts";

export type ControllerTransport = Pick<RpcAgent, "state" | "failure" | "closed" | "onRecord" | "prompt" | "request" | "stop">;
export type ControllerJournal = Pick<RunJournal, "status" | "recordAttempt" | "recordSession" | "recordControl" | "recordDecision">;
export interface BuildControllerOptions {
  runId: string;
  supervision?: unknown;
  /** Required for advisory/steer. The caller owns journal creation and final close. */
  journal?: ControllerJournal;
  clock?: RpcClock;
  createId?: () => string;
  createTransport?: (options: RpcAgentOptions, identity: AttemptIdentity) => ControllerTransport;
  createEvidence?: (workspace: EvidenceWorkspace) => TaskEvidenceReader;
  questions?: Pick<QuestionQueue, "cancelOwner" | "close">;
  controlTimeoutMs?: number;
  sealTimeoutMs?: number;
}
export interface RegisterAttemptInput {
  taskId: string;
  attemptNumber: number;
  workspace: Omit<EvidenceWorkspace, keyof AttemptIdentity>;
  session?: Pick<SessionMapping, "sessionId" | "sessionFile">;
  /** Subscribe before the runner sends its initial prompt. Subsequent prompts belong to this controller. */
  transport?: ControllerTransport;
  rpc?: RpcAgentOptions;
}
export interface GuidanceRequest extends AttemptIdentity {
  /** Optional caller idempotency key. A duplicate is rejected, never delivered twice. */
  controlId?: string;
  origin: "manual" | "supervisor";
  guidance: string;
  reason: string;
  evidenceSequences?: number[];
}
export interface GuidanceResult extends ControlRecord {
  disposition?: RpcPromptDisposition;
  detail?: string;
  proposal?: BoundedText;
}
export interface ControllerTaskSnapshot extends TaskSnapshot {
  admissionOpen: boolean;
  settledGeneration: number;
  readyForIntegration: boolean;
  controlOutcomes: GuidanceResult[];
  controllerError?: string;
}
export interface ControllerBuildSnapshot extends BuildSnapshot {
  supervisionMode: SupervisionConfig["supervisionMode"];
  supervisionDisableReason?: string;
}
export interface IntegrationReadiness extends AttemptIdentity {
  ready: true;
  settledGeneration: number;
  stoppedAt: number;
}
export interface TaskInspection { snapshot: ControllerTaskSnapshot; evidence: TaskEvidence }
interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void }
interface ControlWork {
  record: ControlRecord;
  disposition?: RpcPromptDisposition;
  detail?: string;
  proposal?: BoundedText;
  message: string;
  sent: boolean;
  observed: boolean;
  deadline: number;
  delivery: Deferred<void>;
  receipt: Deferred<GuidanceResult>;
  finished: Promise<void>;
}
interface Attempt {
  identity: AttemptRegistration;
  transport: ControllerTransport;
  evidence: TaskEvidenceReader;
  registered: boolean;
  admissionOpen: boolean;
  cancelled: boolean;
  fault?: string;
  controls: Map<string, ControlWork>;
  inFlight: Set<ControlWork>;
  inspection: AbortController;
  changed: Set<() => void>;
  questions: Set<string>;
  completedWaitSinceProgress: number;
  generation: number;
  requiredAfter: number;
  settled: boolean;
  aborted: boolean;
  assistantCompleted: boolean;
  revision: number;
  unsubscribe: () => void;
  stopping?: Promise<RpcCloseResult>;
  joined: boolean;
  sealing?: Promise<IntegrationReadiness>;
  readiness?: IntegrationReadiness;
  session?: Pick<SessionMapping, "sessionId" | "sessionFile">;
  sessionTail: Promise<void>;
}
const CLOCK: RpcClock = {
  now: Date.now,
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
const MAX_CONTROL_IDS = 4096;
const ACTIVITY_RECORDS = new Set([
  "agent_start", "agent_end", "turn_start", "turn_end", "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end", "auto_retry_start", "auto_retry_end",
  "compaction_start", "compaction_end", "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished",
]);
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function errorText(error: unknown): string { return boundedText(error instanceof Error ? error.message : String(error), 1024).text; }
function limit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Invalid controller timeout");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function result(work: ControlWork): GuidanceResult {
  return structuredClone({ ...work.record, disposition: work.disposition, detail: work.detail, proposal: work.proposal });
}
function userText(record: RpcRecord): string | undefined {
  if (record.type !== "message_end") return undefined;
  const message = object(record.message);
  if (message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content) || message.content.some((block) => object(block).type !== "text")) return undefined;
  return message.content.map((block) => object(block).text).join("");
}

/** Parent safety authority, not a VCS validator. A readiness grant only permits the runner to begin validation. */
export class BuildController {
  readonly runId: string;
  readonly config: SupervisionConfig;
  private readonly state: BuildState;
  private readonly options: BuildControllerOptions;
  private readonly clock: RpcClock;
  private readonly controlTimeoutMs: number;
  private readonly sealTimeoutMs: number;
  private readonly attempts = new Map<string, Attempt>();
  private readonly controlIds = new Set<string>();
  private readonly attemptIds = new Set<string>();
  private readonly taskBudgets = new Map<string, { count: number; lastAt: number }>();
  private readonly observers = new Set<(observation: BuildObservation) => void>();
  private interventions = 0;
  private disableReason?: string;
  private cancelled = false;
  private cancelling?: Promise<void>;

  constructor(options: BuildControllerOptions) {
    this.runId = options.runId;
    this.state = new BuildState(options.runId);
    const config = normalizeSupervisionConfig(options.supervision);
    Object.freeze(config.supervisionOptions);
    this.config = Object.freeze(config);
    if (this.config.supervisionMode !== "off" && !options.journal) throw new Error("Supervision requires a decision journal");
    this.options = options;
    this.clock = options.clock ?? CLOCK;
    this.controlTimeoutMs = limit(options.controlTimeoutMs, 30_000, 300_000);
    this.sealTimeoutMs = limit(options.sealTimeoutMs, 30 * 60_000, 30 * 60_000);
  }

  onObservation(listener: (observation: BuildObservation) => void): () => void {
    this.observers.add(listener);
    return () => { this.observers.delete(listener); };
  }

  async registerAttempt(input: RegisterAttemptInput): Promise<AttemptIdentity> {
    if (this.cancelled) throw new Error("Build is cancelled");
    validateIdentifier(input.taskId, "Task ID");
    const previous = this.attempts.get(input.taskId);
    if (previous && (!previous.joined || previous.inFlight.size)) throw new Error("Previous attempt must be stopped and drained before replacement");
    const identity = normalizeAttempt({
      runId: this.runId, taskId: input.taskId, attemptId: this.newId(), attemptNumber: input.attemptNumber, workspacePath: input.workspace.rootPath,
    });
    if (this.attemptIds.has(identity.attemptId)) throw new Error("Duplicate attempt ID");
    const evidence = (this.options.createEvidence ?? createTaskEvidence)({ ...input.workspace, ...identity });
    if (!input.transport && !input.rpc) throw new Error("Attempt requires a transport or RPC invocation");
    const transport = input.transport ?? (this.options.createTransport ?? ((rpc) => new RpcAgent(rpc)))(input.rpc!, identity);
    try { this.state.registerAttempt(identity, this.clock.now()); }
    catch (error) { await transport.stop(); throw error; }
    this.attemptIds.add(identity.attemptId);
    const attempt: Attempt = {
      identity, transport, evidence, registered: false, admissionOpen: false, cancelled: false,
      controls: new Map(), inFlight: new Set(), inspection: new AbortController(), changed: new Set(), questions: new Set(),
      completedWaitSinceProgress: 0, generation: transport.state.settledGeneration, requiredAfter: transport.state.settledGeneration,
      settled: false, aborted: false, assistantCompleted: false, revision: 0, unsubscribe: () => {}, joined: false, sessionTail: Promise.resolve(),
    };
    this.attempts.set(identity.taskId, attempt);
    attempt.unsubscribe = transport.onRecord((record) => this.observeRecord(attempt, record));
    void transport.closed.then((closed) => {
      if (!attempt.stopping) this.failAttempt(attempt, closed.error?.message ?? "Builder exited unexpectedly");
    });
    try {
      await this.persist(attempt, this.options.journal?.recordAttempt(identity));
      if (input.session) await this.recordSession(identity, input.session);
      this.checkHealthy(attempt);
      attempt.registered = true;
      attempt.admissionOpen = true;
      return { ...identity };
    } catch (error) {
      this.failAttempt(attempt, errorText(error));
      await this.stopAttempt(attempt);
      throw error;
    }
  }

  async recordSession(identity: AttemptIdentity, session: Pick<SessionMapping, "sessionId" | "sessionFile">): Promise<void> {
    const attempt = this.current(identity);
    validateIdentifier(session.sessionId, "Session ID");
    if (attempt.session && (attempt.session.sessionId !== session.sessionId ||
        (attempt.session.sessionFile && session.sessionFile && attempt.session.sessionFile !== session.sessionFile))) {
      this.failAttempt(attempt, "Builder session changed within the current attempt");
      throw new Error("Builder session changed within the current attempt");
    }
    attempt.session = { sessionId: session.sessionId, sessionFile: session.sessionFile ?? attempt.session?.sessionFile };
    const mapping: SessionMapping = { ...attempt.identity, ...attempt.session, role: "builder" };
    await this.persist(attempt, this.options.journal?.recordSession(mapping));
    this.assertCurrent(attempt);
    if (attempt.cancelled || attempt.joined) return;
    this.observe(attempt, { kind: "session", sessionId: mapping.sessionId, sessionFile: mapping.sessionFile });
  }

  inspectBuild(): ControllerBuildSnapshot {
    return { ...this.state.inspectBuild(), supervisionMode: this.config.supervisionMode, supervisionDisableReason: this.disableReason };
  }

  inspectTask(identity: AttemptIdentity): ControllerTaskSnapshot;
  inspectTask(identity: AttemptIdentity, evidence: TaskEvidenceRequest): Promise<TaskInspection>;
  inspectTask(identity: AttemptIdentity, evidence?: TaskEvidenceRequest): ControllerTaskSnapshot | Promise<TaskInspection> {
    const attempt = this.current(identity);
    if (evidence) return this.inspectEvidence(attempt, evidence);
    return {
      ...this.state.inspectTask(identity.taskId), admissionOpen: attempt.admissionOpen,
      settledGeneration: attempt.generation, readyForIntegration: !!attempt.readiness,
      controlOutcomes: [...attempt.controls.values()].map(result), controllerError: attempt.fault,
    };
  }

  private async inspectEvidence(attempt: Attempt, request: TaskEvidenceRequest): Promise<TaskInspection> {
    if (!attempt.admissionOpen) throw new Error("Attempt inspection window is closed");
    const evidence = await this.until(attempt.evidence.read(request, attempt.inspection.signal), this.clock.now() + 10_000, "Evidence inspection");
    this.assertCurrent(attempt);
    if (!attempt.admissionOpen) throw new Error("Attempt inspection window is closed");
    return { snapshot: this.inspectTask(attempt.identity), evidence };
  }

  disableSupervision(reason: string): void {
    this.disableReason ??= boundedText(reason, SUPERVISION_LIMITS.reasonBytes).text || "Supervision disabled";
  }

  async requestGuidance(input: GuidanceRequest): Promise<GuidanceResult> {
    const attempt = this.current(input);
    const controlId = input.controlId ?? this.newId();
    validateIdentifier(controlId, "Control ID");
    if (this.controlIds.has(controlId)) throw new Error("Duplicate control ID");
    if (this.controlIds.size >= MAX_CONTROL_IDS) throw new Error("Control identity capacity exceeded");
    this.controlIds.add(controlId);
    const at = this.clock.now();
    const rejection = this.authorize(attempt, input);
    const record: ControlRecord = {
      ...attempt.identity, controlId, origin: input.origin === "manual" ? "manual" : "supervisor",
      status: "accepted", reason: typeof input.reason === "string" ? boundedText(input.reason, SUPERVISION_LIMITS.reasonBytes).text : "Invalid reason",
      evidenceSequences: rejection ? [] : [...(input.evidenceSequences ?? [])], createdAt: at, updatedAt: at,
    };
    const work: ControlWork = {
      record, message: "", sent: false, observed: false, deadline: at + this.controlTimeoutMs,
      delivery: deferred(), receipt: deferred(), finished: Promise.resolve(),
    };
    attempt.controls.set(controlId, work);
    // Reserve before the first asynchronous operation, including rejection/proposal persistence.
    attempt.inFlight.add(work);
    if (!rejection) {
      const budget = this.taskBudgets.get(input.taskId) ?? { count: 0, lastAt: 0 };
      this.taskBudgets.set(input.taskId, { count: budget.count + 1, lastAt: at });
      this.interventions++;
      if (this.config.supervisionMode === "advisory") work.proposal = boundedText(input.guidance, SUPERVISION_LIMITS.guidanceBytes);
      const marker = Buffer.from(JSON.stringify(controlId)).toString("base64url");
      work.message = `[planner-builder-control:${marker}]\nReason: ${input.reason}\nEvidence sequences: ${(input.evidenceSequences ?? []).join(", ") || "none"}\nGuidance:\n${input.guidance}`;
    }
    work.finished = this.processControl(attempt, work, rejection).finally(() => {
      attempt.inFlight.delete(work);
      // Do not retain thousands of guidance bodies in snapshots or memory.
      work.message = "";
      for (const [id, previous] of attempt.controls) {
        if (attempt.controls.size <= this.state.limits.maxControls) break;
        if (!attempt.inFlight.has(previous)) attempt.controls.delete(id);
      }
      this.changed(attempt);
    });
    return work.receipt.promise;
  }

  private authorize(attempt: Attempt, input: GuidanceRequest): string | undefined {
    if (!["manual", "supervisor"].includes(input.origin)) return "Invalid guidance origin";
    for (const [value, maximum, label] of [[input.guidance, SUPERVISION_LIMITS.guidanceBytes, "Guidance"], [input.reason, SUPERVISION_LIMITS.reasonBytes, "Reason"]] as const) {
      if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return `${label} must be nonempty bounded plain text`;
    }
    const references = input.evidenceSequences ?? [];
    if (!Array.isArray(references) || references.length > SUPERVISION_LIMITS.evidenceSequences || new Set(references).size !== references.length) return "Invalid evidence references";
    const events = this.state.inspectBuild().events;
    if (references.some((sequence) => !Number.isSafeInteger(sequence) || !events.some((event) => event.sequence === sequence && event.applied && event.taskId === input.taskId && event.attemptId === input.attemptId))) return "Evidence references are stale or belong to another attempt";
    if (this.config.supervisionMode === "off") return "Guidance is off";
    if (this.disableReason) return `Supervision disabled: ${this.disableReason}`;
    if (!attempt.admissionOpen || !attempt.registered || attempt.cancelled || attempt.fault || this.cancelled) return "Attempt guidance admission is closed";
    if (!attempt.transport.state.accepting || attempt.transport.failure) return "Builder transport is unavailable";
    if (attempt.inFlight.size) return "Another control is in flight";
    if (this.options.journal && !this.options.journal.status.canAcceptControls) return this.options.journal.status.disableReason ?? "Journal cannot accept controls";
    const budget = this.taskBudgets.get(input.taskId);
    const options = this.config.supervisionOptions;
    if (this.interventions >= options.maxInterventions || (budget?.count ?? 0) >= options.maxInterventionsPerTask) return "Intervention limit reached";
    if (budget && this.clock.now() - budget.lastAt < options.cooldownSeconds * 1000) return "Task guidance cooldown is active";
    return undefined;
  }

  private async processControl(attempt: Attempt, work: ControlWork, rejection?: string): Promise<void> {
    try {
      if (rejection) {
        work.detail = rejection;
        work.record.status = "rejected";
        const reason = boundedText(`Rejected: ${rejection}\nRequest: ${work.record.reason}`, SUPERVISION_LIMITS.reasonBytes);
        work.record.reason = reason.text;
        work.record.reasonTruncated = reason.truncated;
        if (this.options.journal && !this.options.journal.status.canAcceptControls) {
          this.disableSupervision(rejection);
          work.detail += " (journal admission closed; rejection is not durable)";
          this.observe(attempt, { kind: "control", control: work.record });
        } else await this.saveControl(attempt, work);
      } else if (this.config.supervisionMode === "advisory") {
        work.record.status = "proposed";
        await this.saveControl(attempt, work);
        // The journal stores a visibly truncated preview, not a transcript. The full
        // bounded proposal remains available in controller inspection/results.
        await this.persist(attempt, this.options.journal?.recordDecision({
          origin: work.record.origin, taskId: attempt.identity.taskId, attemptId: attempt.identity.attemptId,
          reason: `Control ${work.record.controlId} advisory proposal: ${work.proposal!.text}`, evidenceSequences: work.record.evidenceSequences,
        }), work.deadline);
      } else {
        await this.saveControl(attempt, work);
        this.assertCurrent(attempt);
        // Closure drains reservations that predate it. Cancellation, failure, and disabling
        // supervision revoke unsent reservations; mere settlement never revokes one.
        if (attempt.cancelled || attempt.fault || this.disableReason || !attempt.transport.state.accepting) {
          await this.transition(attempt, work, "cancelled", "Guidance revoked before sending");
        } else {
          const previouslySettled = attempt.settled;
          const previousRevision = attempt.revision;
          const previousRequiredAfter = attempt.requiredAfter;
          attempt.settled = false;
          attempt.requiredAfter = attempt.generation;
          work.sent = true;
          const receipt = await this.until(attempt.transport.prompt(work.message, {
            streamingBehavior: "steer", timeoutMs: this.controlTimeoutMs, completionTimeoutMs: this.sealTimeoutMs,
          }), work.deadline, "Control receipt");
          // Delivery/completion are separate. Consume transport completion errors without
          // treating a command response (or an obsolete waiter) as current settlement.
          void receipt.settled.catch((error) => {
            if (!attempt.stopping && !attempt.cancelled) this.failAttempt(attempt, errorText(error));
          });
          work.disposition = receipt.disposition;
          await this.persist(attempt, this.options.journal?.recordDecision({
            origin: work.record.origin, taskId: attempt.identity.taskId, attemptId: attempt.identity.attemptId,
            reason: `Control ${work.record.controlId}: RPC disposition ${receipt.disposition}`, evidenceSequences: work.record.evidenceSequences,
          }), work.deadline);
          if (receipt.disposition === "handled" && !work.observed) {
            if (attempt.revision === previousRevision) {
              attempt.settled = previouslySettled;
              attempt.requiredAfter = previousRequiredAfter;
            }
            await this.transition(attempt, work, "rejected", "RPC input handler consumed guidance; delivery was not observed");
          } else {
            if (!work.observed && !attempt.cancelled) await this.transition(attempt, work, receipt.disposition === "started" ? "started" : "queued");
            work.receipt.resolve(result(work));
            await this.until(work.delivery.promise, work.deadline, "Control delivery");
            if (!work.observed && attempt.fault) throw new Error(attempt.fault);
            if (work.observed) await this.transition(attempt, work, "delivered");
            else await this.transition(attempt, work, "cancelled", "Attempt cancelled before observed delivery");
          }
        }
      }
    } catch (error) {
      work.detail = errorText(error);
      if (error instanceof JournalCapacityError && !work.sent) {
        this.disableSupervision(error.message);
        work.record = { ...work.record, status: "rejected", updatedAt: this.clock.now() };
        work.detail += " (journal capacity exhausted; rejection is not durable)";
        this.observe(attempt, { kind: "control", control: work.record });
        return;
      }
      let status: ControlStatus = "rejected";
      if (work.sent) status = "delivery-unknown";
      if (attempt.cancelled) status = "cancelled";
      if (work.observed) status = "delivered";
      this.failAttempt(attempt, `Control ${work.record.controlId}: ${work.detail}`);
      if (!isTerminalControl(work.record.status)) {
        try { await this.transition(attempt, work, status, work.detail); }
        catch {
          // Persistence failure is visible and permanently prevents readiness. Never
          // claim this fallback status was durably written.
          work.record = reduceControl(work.record, status, this.clock.now());
          this.observe(attempt, { kind: "control", control: work.record });
        }
      }
    } finally {
      work.receipt.resolve(result(work));
    }
  }

  private async saveControl(attempt: Attempt, work: ControlWork): Promise<void> {
    await this.persist(attempt, this.options.journal?.recordControl(work.record), work.deadline);
    this.observe(attempt, { kind: "control", control: work.record });
  }

  private async transition(attempt: Attempt, work: ControlWork, status: ControlStatus, detail?: string): Promise<void> {
    const next = { ...reduceControl(work.record, status, this.clock.now()) };
    if (detail) {
      work.detail = detail;
      const reason = boundedText(`${detail}\nRequest: ${next.reason}`, SUPERVISION_LIMITS.reasonBytes);
      next.reason = reason.text;
      next.reasonTruncated ||= reason.truncated;
    }
    // Terminal records may use the journal's reserved capacity after admission closes.
    await this.persist(attempt, this.options.journal?.recordControl(next));
    work.record = next;
    this.observe(attempt, { kind: "control", control: next });
  }

  /** Optional review while admission remains open. The callback must honor abort; a late
   * action is still checked by requestGuidance after seal closes the window. */
  async settledCheckpoint(identity: AttemptIdentity, review: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const attempt = this.current(identity);
    if (!attempt.admissionOpen) throw new Error("Checkpoint admission is closed");
    if (!this.isSettled(attempt)) return;
    const deadline = this.clock.now() + this.config.supervisionOptions.checkpointSeconds * 1000;
    if (deadline <= this.clock.now()) return;
    const abort = new AbortController();
    const cancel = (): void => abort.abort();
    attempt.inspection.signal.addEventListener("abort", cancel, { once: true });
    try {
      await this.until(Promise.resolve().then(() => {
        this.assertCurrent(attempt);
        if (!attempt.admissionOpen || abort.signal.aborted) return;
        return review(abort.signal);
      }), deadline, "Settled checkpoint");
    } catch (error) {
      this.disableSupervision(errorText(error));
    } finally {
      abort.abort();
      attempt.inspection.signal.removeEventListener("abort", cancel);
    }
  }

  sealAttemptForIntegration(identity: AttemptIdentity, options: { checkpoint?: (signal: AbortSignal) => Promise<void> } = {}): Promise<IntegrationReadiness> {
    const attempt = this.current(identity);
    try { this.checkHealthy(attempt); }
    catch (error) { return Promise.reject(error); }
    if (attempt.sealing) return attempt.sealing;
    // Without an optional checkpoint, admission closes synchronously in seal().
    attempt.sealing = this.seal(attempt, options.checkpoint);
    return attempt.sealing;
  }

  private async seal(attempt: Attempt, checkpoint?: (signal: AbortSignal) => Promise<void>): Promise<IntegrationReadiness> {
    const deadline = this.clock.now() + this.sealTimeoutMs;
    try {
      if (checkpoint) await this.settledCheckpoint(attempt.identity, checkpoint);
      this.closeAdmission(attempt);
      this.checkHealthy(attempt);
      while (attempt.inFlight.size) await this.until(Promise.all([...attempt.inFlight].map((work) => work.finished)), deadline, "Control drain");
      await this.until(attempt.sessionTail, deadline, "Session journal");
      await this.waitForSettlement(attempt, deadline);
      this.checkHealthy(attempt);
      this.observe(attempt, { kind: "phase", phase: "sealing" });
      const generation = attempt.generation;
      const revision = attempt.revision;
      const response = await this.until(attempt.transport.request("get_state", {}, { timeoutMs: Math.max(1, deadline - this.clock.now()) }), deadline, "Integration state confirmation");
      const data = object(response.data);
      this.checkHealthy(attempt);
      if (!response.success || data.isStreaming !== false || data.isCompacting !== false || data.pendingMessageCount !== 0 ||
          !this.isSettled(attempt) || generation !== attempt.generation || revision !== attempt.revision ||
          attempt.transport.state.pendingRequests || attempt.transport.state.queuedWrites || attempt.transport.state.pendingUi) {
        throw new Error("Builder state changed or has pending work at integration closure");
      }
      const closed = await this.stopAttempt(attempt);
      this.checkHealthy(attempt);
      if (closed.error || closed.shutdownErrors.length || closed.code !== 0 || closed.signal || generation !== attempt.generation || revision !== attempt.revision) {
        throw new Error(closed.error?.message ?? "Builder shutdown did not preserve settled work");
      }
      await this.until(attempt.sessionTail, deadline, "Final session journal");
      this.checkHealthy(attempt);
      attempt.readiness = { ...attempt.identity, ready: true, settledGeneration: generation, stoppedAt: this.clock.now() };
      this.observe(attempt, { kind: "phase", phase: "integrating" });
      this.checkHealthy(attempt);
      return { ...attempt.readiness! };
    } catch (error) {
      this.failAttempt(attempt, errorText(error));
      await this.stopAttempt(attempt);
      throw error;
    }
  }

  private isSettled(attempt: Attempt): boolean {
    const snapshot = this.state.inspectTask(attempt.identity.taskId);
    return attempt.settled && attempt.generation > attempt.requiredAfter && attempt.transport.state.isSettled &&
      !snapshot.queues.steering && !snapshot.queues.followUp && !snapshot.retries.active && !snapshot.compaction.active && !attempt.questions.size;
  }

  private async waitForSettlement(attempt: Attempt, deadline: number): Promise<void> {
    while (!this.isSettled(attempt)) {
      this.checkHealthy(attempt);
      const change = deferred<void>();
      const wake = (): void => change.resolve();
      attempt.changed.add(wake);
      try { await this.until(change.promise, deadline, "Builder settlement"); }
      finally { attempt.changed.delete(wake); }
    }
    const outcome = this.state.inspectTask(attempt.identity.taskId).outcome;
    if (!attempt.assistantCompleted) throw new Error("Builder has no fresh authoritative assistant ending");
    if (attempt.aborted || outcome !== "stop") throw new Error(`Builder did not complete successfully (${outcome ?? "no assistant outcome"})`);
  }

  async cancelTask(identity: AttemptIdentity): Promise<void> {
    const attempt = this.current(identity);
    attempt.cancelled = true;
    attempt.readiness = undefined;
    this.closeAdmission(attempt);
    this.cancelQuestions(attempt);
    if (!attempt.fault) this.observe(attempt, { kind: "phase", phase: "cancelled" });
    for (const work of attempt.inFlight) work.delivery.resolve();
    this.changed(attempt);
    const stopping = this.stopAttempt(attempt);
    await Promise.all([stopping, ...[...attempt.inFlight].map((work) => work.finished)]);
  }

  cancelBuild(): Promise<void> {
    if (this.cancelling) return this.cancelling;
    this.cancelled = true;
    this.cancelling = Promise.all([
      ...[...this.attempts.values()].map((attempt) => this.cancelTask(attempt.identity)),
      this.options.questions?.close(),
    ]).then(() => undefined);
    return this.cancelling;
  }

  /** Wire these to the shared question queue's waiting-start/end callbacks using
   * parent-bound attempt IDs. Supervisor reasoning/questions have no builder owner. */
  beginHumanWait(identity: AttemptIdentity, questionId: string): boolean {
    const attempt = this.callbackAttempt(identity);
    if (!attempt || attempt.cancelled || attempt.stopping || attempt.fault) return false;
    validateIdentifier(questionId, "Question ID");
    if (attempt.questions.has(questionId)) return false;
    if (attempt.questions.size >= 32) throw new Error("Attempt question capacity exceeded");
    attempt.questions.add(questionId);
    if (attempt.questions.size === 1) this.observe(attempt, { kind: "human-wait", waiting: true });
    this.changed(attempt);
    return true;
  }

  endHumanWait(identity: AttemptIdentity, questionId: string): boolean {
    const attempt = this.callbackAttempt(identity);
    if (!attempt || !attempt.questions.delete(questionId)) return false;
    if (!attempt.questions.size) {
      const snapshot = this.state.inspectTask(identity.taskId);
      if (snapshot.humanWait.since !== null) attempt.completedWaitSinceProgress += Math.max(0, this.clock.now() - Math.max(snapshot.humanWait.since, snapshot.lastProgressAt));
      this.observe(attempt, { kind: "human-wait", waiting: false });
    }
    this.changed(attempt);
    return true;
  }

  watchdogState(identity: AttemptIdentity): { paused: boolean; activeIdleMs: number; humanWaitMs: number } {
    const attempt = this.current(identity);
    const snapshot = this.state.inspectTask(identity.taskId);
    const now = this.clock.now();
    const since = snapshot.humanWait.since;
    const activeWait = since === null ? 0 : Math.max(0, now - since);
    const excluded = attempt.completedWaitSinceProgress + (since === null ? 0 : Math.max(0, now - Math.max(since, snapshot.lastProgressAt)));
    return { paused: since !== null, activeIdleMs: Math.max(0, now - snapshot.lastProgressAt - excluded), humanWaitMs: snapshot.humanWait.totalMs + activeWait };
  }

  private observeRecord(attempt: Attempt, record: RpcRecord): void {
    if (this.attempts.get(attempt.identity.taskId) !== attempt || attempt.cancelled || attempt.joined) return;
    const previousQueues = record.type === "queue_update" ? this.state.inspectTask(attempt.identity.taskId).queues : undefined;
    const observation = this.state.observeRpc(attempt.identity, record, this.clock.now());
    if (observation.meaningful) attempt.completedWaitSinceProgress = 0;
    if (ACTIVITY_RECORDS.has(record.type)) {
      attempt.revision++;
      attempt.settled = false;
    }
    if (previousQueues && observation.payload.kind === "queues") {
      const { steering, followUp } = observation.payload;
      if (steering || followUp || steering !== previousQueues.steering || followUp !== previousQueues.followUp) attempt.revision++;
      if (steering || followUp) attempt.settled = false;
    }
    if (record.type === "agent_settled") {
      attempt.generation = attempt.transport.state.settledGeneration;
      attempt.settled = true;
      attempt.aborted = record.aborted === true;
      attempt.revision++;
    }
    const messageRole = object(record.message).role;
    if (record.type === "agent_start" || (record.type === "message_end" && messageRole === "user") ||
        (record.type === "message_start" && messageRole === "assistant")) attempt.assistantCompleted = false;
    if (record.type === "message_end" && messageRole === "assistant") attempt.assistantCompleted = true;
    const text = userText(record);
    if (text !== undefined) {
      for (const work of attempt.inFlight) {
        if (work.sent && !work.observed && text === work.message) {
          work.observed = true;
          attempt.requiredAfter = Math.max(attempt.requiredAfter, attempt.generation);
          work.delivery.resolve();
        }
      }
    }
    if (observation.payload.kind === "session") {
      const session = observation.payload;
      attempt.sessionTail = attempt.sessionTail.then(() => this.recordSession(attempt.identity, session)).catch((error) => this.failAttempt(attempt, errorText(error)));
    }
    this.changed(attempt);
    this.publish(observation);
  }

  private observe(attempt: Attempt, payload: ParentObservation): void {
    if (this.attempts.get(attempt.identity.taskId) !== attempt) return;
    const observation = this.state.observe(attempt.identity, payload, this.clock.now());
    if (observation.meaningful) attempt.completedWaitSinceProgress = 0;
    this.publish(observation);
  }

  private publish(observation: BuildObservation): void {
    for (const listener of this.observers) {
      try { listener(observation); }
      catch (error) { this.disableSupervision(`Observation callback failed: ${errorText(error)}`); }
    }
  }

  private current(identity: AttemptIdentity): Attempt {
    validateIdentity(identity);
    if (identity.runId !== this.runId) throw new Error("Wrong build run identity");
    const attempt = this.callbackAttempt(identity);
    if (!attempt) throw new Error("Unknown task or stale attempt identity");
    return attempt;
  }
  private callbackAttempt(identity: AttemptIdentity): Attempt | undefined {
    const attempt = this.attempts.get(identity.taskId);
    if (identity.runId !== this.runId || attempt?.identity.attemptId !== identity.attemptId) return undefined;
    return attempt;
  }
  private assertCurrent(attempt: Attempt): void {
    if (this.current(attempt.identity) !== attempt) throw new Error("Stale attempt");
  }
  private checkHealthy(attempt: Attempt): void {
    this.assertCurrent(attempt);
    if (attempt.cancelled || this.cancelled) throw new Error("Attempt cancelled");
    if (attempt.fault) throw new Error(attempt.fault);
    if (attempt.transport.failure) throw attempt.transport.failure;
  }
  private newId(): string {
    const id = (this.options.createId ?? randomUUID)();
    validateIdentifier(id);
    return id;
  }
  private changed(attempt: Attempt): void { for (const wake of attempt.changed) wake(); }
  private closeAdmission(attempt: Attempt): void {
    attempt.admissionOpen = false;
    attempt.inspection.abort();
  }
  private cancelQuestions(attempt: Attempt): void {
    this.options.questions?.cancelOwner(attempt.identity.attemptId);
    for (const id of attempt.questions) this.endHumanWait(attempt.identity, id);
  }
  private failAttempt(attempt: Attempt, message: string): void {
    if (this.attempts.get(attempt.identity.taskId) !== attempt) return;
    attempt.fault ??= boundedText(message, 1024).text;
    attempt.readiness = undefined;
    this.closeAdmission(attempt);
    this.cancelQuestions(attempt);
    this.observe(attempt, { kind: "error", error: boundedText(attempt.fault, 1024) });
    if (!attempt.cancelled) this.observe(attempt, { kind: "phase", phase: "failed" });
    for (const work of attempt.inFlight) work.delivery.resolve();
    this.changed(attempt);
    void this.stopAttempt(attempt);
  }
  private stopAttempt(attempt: Attempt): Promise<RpcCloseResult> {
    if (attempt.stopping) return attempt.stopping;
    const stopped = deferred<RpcCloseResult>();
    attempt.stopping = stopped.promise;
    // RpcAgent.stop closes transport admission synchronously, cancels RPC UI,
    // clears queues before abort, then joins the process and its process group.
    let shutdown: Promise<RpcCloseResult>;
    try { shutdown = attempt.transport.stop(); }
    catch (error) { shutdown = Promise.reject(error); }
    void this.until(shutdown, this.clock.now() + this.sealTimeoutMs, "Builder shutdown").then((closed) => {
      attempt.joined = !closed.error;
      attempt.unsubscribe();
      this.changed(attempt);
      stopped.resolve(closed);
    }, (error) => {
      this.failAttempt(attempt, errorText(error));
      stopped.resolve({ code: null, signal: null, error: new Error(errorText(error)), stderr: "", stderrTruncated: false, signals: [], shutdownErrors: [] });
    });
    return stopped.promise;
  }
  private async persist(attempt: Attempt, operation: Promise<void> | undefined, deadline = this.clock.now() + this.controlTimeoutMs): Promise<void> {
    try { await this.until(operation ?? Promise.resolve(), deadline, "Decision journal"); }
    catch (error) {
      this.disableSupervision(`Decision journal failed: ${errorText(error)}`);
      if (!(error instanceof JournalCapacityError)) this.failAttempt(attempt, `Decision journal failed: ${errorText(error)}`);
      throw error;
    }
  }
  private async until<T>(promise: Promise<T>, deadline: number, label: string): Promise<T> {
    let timer: unknown;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = this.clock.setTimeout(() => reject(new Error(`${label} timed out`)), Math.max(0, deadline - this.clock.now()));
      })]);
    } finally { this.clock.clearTimeout(timer); }
  }
}
