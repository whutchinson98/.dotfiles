import { createHash } from "node:crypto";

export type SupervisionMode = "off" | "advisory" | "steer";
export interface SupervisionOptions {
  intervalSeconds: number;
  cooldownSeconds: number;
  maxInterventionsPerTask: number;
  maxInterventions: number;
  maxReviews: number;
  reviewTimeoutSeconds: number;
  maxActiveSeconds: number;
  maxTokens: number;
  checkpointSeconds: number;
}
export interface SupervisionConfig {
  supervisionMode: SupervisionMode;
  supervisorAgent: string;
  supervisionOptions: SupervisionOptions;
}

export const SUPERVISION_LIMITS = freeze({
  debounceMs: 750,
  guidanceBytes: 4 * 1024,
  evidenceResponseBytes: 16 * 1024,
  reviewSnapshotBytes: 32 * 1024,
  seedBytes: 128 * 1024,
  questionDeadlineMs: 300_000,
  journalBytes: 4 * 1024 * 1024,
  journalRecordBytes: 8192,
  reasonBytes: 1024,
  identityBytes: 128,
  evidenceSequences: 32,
  // Inclusive ranges; seconds and counts are rounded down after clamping.
  optionRanges: Object.freeze({
    intervalSeconds: [1, 300], cooldownSeconds: [0, 3600],
    maxInterventionsPerTask: [0, 20], maxInterventions: [0, 200], maxReviews: [1, 200],
    reviewTimeoutSeconds: [1, 300], maxActiveSeconds: [1, 7200],
    maxTokens: [1, 2_000_000], checkpointSeconds: [0, 30],
  } as const),
});
const DEFAULT_OPTIONS: SupervisionOptions = {
  intervalSeconds: 30, cooldownSeconds: 60, maxInterventionsPerTask: 3,
  maxInterventions: 20, maxReviews: 20, reviewTimeoutSeconds: 30,
  maxActiveSeconds: 600, maxTokens: 200_000, checkpointSeconds: 5,
};

export function normalizeSupervisionConfig(input: unknown = {}): SupervisionConfig {
  if (!isObject(input)) throw new Error("Supervision configuration must be an object");
  const mode = input.supervisionMode ?? "off";
  if (mode !== "off" && mode !== "advisory" && mode !== "steer") throw new Error("Invalid supervision mode");
  const agent = input.supervisorAgent ?? "supervisor";
  if (typeof agent !== "string" || !agent.trim() || Buffer.byteLength(agent) > 128) throw new Error("Invalid supervisor agent");
  const options = input.supervisionOptions ?? {};
  if (!isObject(options)) throw new Error("Supervision options must be an object");
  const normalized = { ...DEFAULT_OPTIONS };
  for (const key of Object.keys(DEFAULT_OPTIONS) as (keyof SupervisionOptions)[]) {
    const value = options[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be finite`);
    const [minimum, maximum] = SUPERVISION_LIMITS.optionRanges[key];
    normalized[key] = Math.floor(Math.max(minimum, Math.min(maximum, value)));
  }
  return { supervisionMode: mode, supervisorAgent: agent.trim(), supervisionOptions: normalized };
}

export interface AttemptIdentity { runId: string; taskId: string; attemptId: string }
export interface AttemptRegistration extends AttemptIdentity { attemptNumber: number; workspacePath: string }
export interface SessionMapping {
  runId: string;
  role: "builder" | "supervisor";
  taskId?: string;
  attemptId?: string;
  attemptNumber?: number;
  workspacePath?: string;
  sessionId: string;
  sessionFile?: string;
}
export type TaskPhase = "starting" | "running" | "retrying" | "compacting" | "settled" | "sealing" | "integrating" | "done" | "failed" | "cancelled";
export type AssistantOutcome = "pending" | "stop" | "toolUse" | "length" | "error" | "aborted" | "deferred";
export type ControlStatus = "proposed" | "accepted" | "queued" | "started" | "delivered" | "rejected" | "cancelled" | "delivery-unknown";
export type ControlOrigin = "manual" | "supervisor" | "runner";
export interface ControlRecord extends AttemptIdentity {
  controlId: string;
  origin: ControlOrigin;
  status: ControlStatus;
  reason: string;
  evidenceSequences: number[];
  createdAt: number;
  updatedAt: number;
  reasonTruncated?: boolean;
  evidenceTruncated?: boolean;
}
const CONTROL_TRANSITIONS: Record<ControlStatus, readonly ControlStatus[]> = {
  proposed: ["accepted", "rejected", "cancelled"],
  accepted: ["queued", "started", "delivered", "rejected", "cancelled", "delivery-unknown"],
  queued: ["started", "delivered", "cancelled", "delivery-unknown"],
  started: ["delivered", "cancelled", "delivery-unknown"],
  delivered: [], rejected: [], cancelled: [], "delivery-unknown": [],
};
export function isTerminalControl(status: ControlStatus): boolean {
  return CONTROL_TRANSITIONS[status]?.length === 0;
}
export function validateIdentifier(value: unknown, name = "Identity"): asserts value is string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > SUPERVISION_LIMITS.identityBytes || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${name} must be a bounded nonempty identifier`);
  }
}
export function validateIdentity(identity: AttemptIdentity): void {
  validateIdentifier(identity.runId, "Run ID");
  validateIdentifier(identity.taskId, "Task ID");
  validateIdentifier(identity.attemptId, "Attempt ID");
}
export function normalizeAttempt(registration: AttemptRegistration): AttemptRegistration {
  validateIdentity(registration);
  if (!Number.isSafeInteger(registration.attemptNumber) || registration.attemptNumber < 1) throw new Error("Invalid attempt number");
  if (typeof registration.workspacePath !== "string" || !registration.workspacePath || Buffer.byteLength(registration.workspacePath) > 4096) throw new Error("Invalid workspace path");
  return { runId: registration.runId, taskId: registration.taskId, attemptId: registration.attemptId, attemptNumber: registration.attemptNumber, workspacePath: registration.workspacePath };
}
function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid observation timestamp");
}
export function normalizeControl(control: ControlRecord): ControlRecord {
  validateIdentity(control);
  validateIdentifier(control.controlId, "Control ID");
  if (!Object.hasOwn(CONTROL_TRANSITIONS, control.status)) throw new Error("Invalid control status");
  if (!["manual", "supervisor", "runner"].includes(control.origin)) throw new Error("Invalid control origin");
  timestamp(control.createdAt);
  timestamp(control.updatedAt);
  if (control.updatedAt < control.createdAt) throw new Error("Control timestamp precedes creation");
  if (typeof control.reason !== "string" || !Array.isArray(control.evidenceSequences)) throw new Error("Invalid control evidence/reason");
  const reason = boundedText(control.reason, SUPERVISION_LIMITS.reasonBytes);
  const evidence = control.evidenceSequences.slice(0, SUPERVISION_LIMITS.evidenceSequences);
  if (evidence.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 1)) throw new Error("Invalid evidence sequence");
  return {
    runId: control.runId, taskId: control.taskId, attemptId: control.attemptId,
    controlId: control.controlId, origin: control.origin, status: control.status,
    reason: reason.text, evidenceSequences: evidence, createdAt: control.createdAt, updatedAt: control.updatedAt,
    reasonTruncated: reason.truncated || control.reasonTruncated === true,
    evidenceTruncated: evidence.length < control.evidenceSequences.length || control.evidenceTruncated === true,
  };
}
export function reduceControl(control: ControlRecord, status: ControlStatus, at: number): ControlRecord {
  const previous = normalizeControl(control);
  timestamp(at);
  if (at < previous.updatedAt) throw new Error("Control timestamp moved backwards");
  if (!CONTROL_TRANSITIONS[previous.status].includes(status)) throw new Error(`Invalid control transition: ${previous.status} -> ${status}`);
  return freeze({ ...previous, status, updatedAt: at });
}

export interface BoundedText { text: string; originalBytes: number; truncated: boolean }
export function boundedText(text: string, maximum: number): BoundedText {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("Invalid text byte limit");
  const originalBytes = Buffer.byteLength(text);
  if (originalBytes <= maximum) return { text, originalBytes, truncated: false };
  // stream:true discards an incomplete trailing UTF-8 code point, rather than inserting U+FFFD.
  const prefix = new TextDecoder().decode(Buffer.from(text).subarray(0, maximum), { stream: true });
  return { text: prefix, originalBytes, truncated: true };
}
/** A bounded JSON preview, not a parseable replacement for the structured snapshot when truncated. */
export function serializeSnapshot(snapshot: TaskSnapshot | BuildSnapshot, maximum = SUPERVISION_LIMITS.reviewSnapshotBytes): BoundedText {
  return boundedText(JSON.stringify(snapshot), Math.min(maximum, SUPERVISION_LIMITS.reviewSnapshotBytes));
}

export interface Usage {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cacheWrite1h: number; reasoning: number; totalTokens: number; cost: number;
}
function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, totalTokens: 0, cost: 0 };
}
function count(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
export function normalizeUsage(value: unknown): Usage {
  const usage = object(value);
  const result = emptyUsage();
  for (const key of Object.keys(result) as (keyof Usage)[]) result[key] = count(usage[key]);
  result.cost = count(object(usage.cost).total);
  if (typeof usage.totalTokens !== "number") result.totalTokens = result.input + result.output + result.cacheRead + result.cacheWrite;
  return result;
}
function addUsage(left: Usage, right: Usage): Usage {
  const result = emptyUsage();
  for (const key of Object.keys(result) as (keyof Usage)[]) result[key] = left[key] + right[key];
  return result;
}

export interface StateLimits {
  maxTasks: number; maxAttemptsPerTask: number; maxEvents: number; maxEventBytes: number;
  textBytes: number; evidenceBytes: number; maxBlocks: number; maxTools: number;
  maxControls: number; maxUsageEntries: number;
}
export const BUILD_STATE_LIMITS: Readonly<StateLimits> = Object.freeze({
  maxTasks: 512, maxAttemptsPerTask: 64, maxEvents: 256, maxEventBytes: 128 * 1024,
  textBytes: 8192, evidenceBytes: 4096, maxBlocks: 32, maxTools: 32,
  maxControls: 64, maxUsageEntries: 8192,
});
function stateLimits(input: Partial<StateLimits> = {}): StateLimits {
  const result = { ...BUILD_STATE_LIMITS };
  for (const key of Object.keys(result) as (keyof StateLimits)[]) {
    const value = input[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1 || value > result[key]) throw new Error(`Invalid state limit: ${key}`);
    result[key] = value;
  }
  return result;
}
interface TextBlock { index: number; content: BoundedText }
interface ObservedMessage {
  key: string;
  role: string;
  blocks: TextBlock[];
  droppedBlocks: number;
  usage: Usage;
  outcome?: AssistantOutcome;
  error?: BoundedText;
  toolCallId?: string;
  toolName?: string;
  isError: boolean;
}
export type ObservationPayload =
  | { kind: "attempt"; registration: AttemptRegistration }
  | { kind: "transport"; recordType: string }
  | { kind: "stale"; recordType: string }
  | { kind: "phase"; phase: TaskPhase }
  | { kind: "agent"; stage: "start" | "end" | "settled"; aborted: boolean; willRetry: boolean }
  | { kind: "message"; stage: "start" | "end"; message: ObservedMessage }
  | { kind: "text"; index: number; operation: "start" | "append" | "replace"; content: BoundedText; usage?: Usage }
  | { kind: "activity"; channel: "thinking" | "tool-arguments" | "other"; bytes: number; usage?: Usage }
  | { kind: "tool"; toolCallId: string; toolName: string; stage: "start" | "update" | "end"; input: BoundedText; output: BoundedText; isError: boolean; durationMs?: number }
  | { kind: "retry"; active: boolean; source: "assistant" | "summary"; attempt?: number; maxAttempts?: number; delayMs?: number; success?: boolean; error: BoundedText }
  | { kind: "compaction"; active: boolean; reason: string; usage: Usage; aborted: boolean; willRetry: boolean; error: BoundedText }
  | { kind: "usage"; key: string; usage: Usage }
  | { kind: "queues"; steering: number; followUp: number }
  | { kind: "session"; sessionId: string; sessionFile?: string }
  | { kind: "human-wait"; waiting: boolean }
  | { kind: "control"; control: ControlRecord }
  | { kind: "error"; error: BoundedText };
export type ParentObservation = Extract<ObservationPayload, { kind: "phase" | "human-wait" | "control" | "error" | "session" }>;
export interface BuildObservation extends AttemptIdentity {
  sequence: number;
  observedAt: number;
  applied: boolean;
  meaningful: boolean;
  payload: ObservationPayload;
}
export interface ToolEvidence {
  toolCallId: string; toolName: string; stage: "start" | "update" | "end";
  input: BoundedText; output: BoundedText; isError: boolean; durationMs?: number; sequence: number;
}
export interface TaskSnapshot extends AttemptRegistration {
  sequence: number;
  phase: TaskPhase;
  lastTransportAt: number | null;
  lastProgressAt: number;
  assistantText: BoundedText;
  outcome?: AssistantOutcome;
  error?: BoundedText;
  activity: { thinkingBytes: number; toolArgumentBytes: number };
  tools: ToolEvidence[];
  droppedTools: number;
  droppedBlocks: number;
  droppedControls: number;
  retries: { active: boolean; source: "assistant" | "summary"; attempt: number; count: number; maxAttempts: number; delayMs: number; success?: boolean };
  compaction: { active: boolean; count: number; reason: string; aborted: boolean; willRetry: boolean };
  humanWait: { since: number | null; totalMs: number };
  queues: { steering: number; followUp: number };
  usage: Usage;
  usageComplete: boolean;
  disableReason?: string;
  session?: SessionMapping;
  controls: ControlRecord[];
}
export interface BuildSnapshot {
  runId: string; sequence: number; tasks: TaskSnapshot[]; usage: Usage; usageComplete: boolean;
  events: BuildObservation[]; eventBytes: number; droppedEvents: number;
}

function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function object(value: unknown): Record<string, unknown> { return isObject(value) ? value : {}; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function short(value: unknown, maximum = 128): string { return boundedText(string(value), maximum).text; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function messageKey(message: Record<string, unknown>): string {
  return hash(JSON.stringify([message.role, message.timestamp, message.responseId, message.toolCallId]));
}
function textBlocks(content: unknown, limits: StateLimits): { blocks: TextBlock[]; droppedBlocks: number } {
  const source = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(source)) return { blocks: [], droppedBlocks: 0 };
  const blocks: TextBlock[] = [];
  let remaining = limits.textBytes;
  let droppedBlocks = 0;
  for (let index = 0; index < source.length; index++) {
    const block = object(source[index]);
    if (block.type !== "text") continue;
    if (blocks.length >= limits.maxBlocks) { droppedBlocks++; continue; }
    const content = boundedText(string(block.text), remaining);
    remaining -= Buffer.byteLength(content.text);
    blocks.push({ index, content });
  }
  return { blocks, droppedBlocks };
}
function joinedText(blocks: TextBlock[], maximum: number, dropped = false): BoundedText {
  const sorted = [...blocks].sort((left, right) => left.index - right.index);
  const result = boundedText(sorted.map((block) => block.content.text).join("\n"), maximum);
  result.originalBytes = sorted.reduce((total, block) => total + block.content.originalBytes, Math.max(0, sorted.length - 1));
  result.truncated ||= dropped || sorted.some((block) => block.content.truncated);
  return result;
}
function outcome(value: unknown): AssistantOutcome | undefined {
  if (["pending", "stop", "toolUse", "length", "error", "aborted", "deferred"].includes(string(value))) return value as AssistantOutcome;
  return undefined;
}

/** Whitelist the documented RPC fields. Never retain partial snapshots, thinking, images or arbitrary deltas. */
export function normalizeRpcRecord(record: Record<string, unknown>, limits: StateLimits = BUILD_STATE_LIMITS): ObservationPayload {
  const type = string(record.type);
  switch (type) {
    case "agent_start": case "agent_end": case "agent_settled":
      return { kind: "agent", stage: type.slice(6) as "start" | "end" | "settled", aborted: record.aborted === true, willRetry: record.willRetry === true };
    case "message_start": case "message_end": {
      const message = object(record.message);
      return { kind: "message", stage: type === "message_start" ? "start" : "end", message: {
        key: messageKey(message), role: short(message.role, 32), ...textBlocks(message.content, limits),
        usage: normalizeUsage(message.usage), outcome: outcome(message.stopReason),
        error: message.errorMessage ? boundedText(string(message.errorMessage), limits.evidenceBytes) : undefined,
        toolCallId: short(message.toolCallId), toolName: short(message.toolName), isError: message.isError === true,
      } };
    }
    case "message_update": {
      const event = object(record.assistantMessageEvent);
      const eventType = string(event.type);
      const usage = record.usage === undefined ? undefined : normalizeUsage(record.usage);
      if (["text_start", "text_delta", "text_end"].includes(eventType) && Number.isSafeInteger(event.contentIndex) && (event.contentIndex as number) >= 0) {
        let operation: "start" | "append" | "replace" = "start";
        if (eventType === "text_delta") operation = "append";
        if (eventType === "text_end") operation = "replace";
        return { kind: "text", index: event.contentIndex as number, operation, content: boundedText(string(event.delta ?? event.content), limits.textBytes), usage };
      }
      let channel: "thinking" | "tool-arguments" | "other" = "other";
      if (eventType.startsWith("thinking_")) channel = "thinking";
      if (eventType.startsWith("toolcall_")) channel = "tool-arguments";
      return { kind: "activity", channel, bytes: eventType.endsWith("_delta") ? Buffer.byteLength(string(event.delta)) : 0, usage };
    }
    case "tool_execution_start": case "tool_execution_update": case "tool_execution_end": {
      const result = object(record.result ?? record.partialResult);
      const content = textBlocks(result.content, { ...limits, textBytes: limits.evidenceBytes });
      return {
        kind: "tool", toolCallId: short(record.toolCallId), toolName: short(record.toolName),
        stage: type.slice(15) as "start" | "update" | "end",
        input: boundedText(record.args === undefined ? "" : JSON.stringify(record.args), limits.evidenceBytes),
        output: joinedText(content.blocks, limits.evidenceBytes, content.droppedBlocks > 0),
        isError: record.isError === true, durationMs: typeof record.durationMs === "number" ? count(record.durationMs) : undefined,
      };
    }
    case "auto_retry_start": case "auto_retry_end": case "summarization_retry_scheduled": case "summarization_retry_attempt_start": case "summarization_retry_finished":
      return {
        kind: "retry", active: !["auto_retry_end", "summarization_retry_finished"].includes(type),
        source: type.startsWith("auto_") ? "assistant" : "summary",
        attempt: record.attempt === undefined ? undefined : count(record.attempt),
        maxAttempts: record.maxAttempts === undefined ? undefined : count(record.maxAttempts),
        delayMs: record.delayMs === undefined ? undefined : count(record.delayMs),
        success: typeof record.success === "boolean" ? record.success : undefined,
        error: boundedText(string(record.errorMessage ?? record.finalError), limits.evidenceBytes),
      };
    case "compaction_start": case "compaction_end":
      return {
        kind: "compaction", active: type === "compaction_start", reason: short(record.reason), usage: normalizeUsage(object(record.result).usage),
        aborted: record.aborted === true, willRetry: record.willRetry === true, error: boundedText(string(record.errorMessage), limits.evidenceBytes),
      };
    case "entry_appended": {
      const entry = object(record.entry);
      if (entry.type === "usage" && typeof entry.id === "string") return { kind: "usage", key: `entry:${hash(entry.id)}`, usage: normalizeUsage(entry.usage) };
      break;
    }
    case "queue_update":
      return { kind: "queues", steering: Array.isArray(record.steering) ? record.steering.length : 0, followUp: Array.isArray(record.followUp) ? record.followUp.length : 0 };
    case "response": {
      const data = object(record.data);
      if (record.success === true && record.command === "get_state" && typeof data.sessionId === "string") {
        return { kind: "session", sessionId: short(data.sessionId), sessionFile: typeof data.sessionFile === "string" ? short(data.sessionFile, 4096) : undefined };
      }
      break;
    }
    case "extension_error": return { kind: "error", error: boundedText(string(record.error), limits.evidenceBytes) };
  }
  return { kind: "transport", recordType: short(type) };
}

interface TaskState {
  snapshot: TaskSnapshot;
  attemptIds: Set<string>;
  blocks: Map<number, BoundedText>;
  finalizedUsage: Usage;
  currentMessage?: { key: string; usage: Usage };
  usageKeys: Set<string>;
  completedStarts: Set<string>;
  compactionGeneration: number;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function immutable<T>(value: T): T { return freeze(structuredClone(value)); }
const CLOSED_PHASES: readonly TaskPhase[] = ["sealing", "integrating", "done", "failed", "cancelled"];
function executionPhase(snapshot: TaskSnapshot, phase: TaskPhase): void {
  if (!CLOSED_PHASES.includes(snapshot.phase)) snapshot.phase = phase;
}

/** Parent-owned observation store. Inspection is pure; only observations advance sequence/activity. */
export class BuildState {
  readonly runId: string;
  readonly limits: StateLimits;
  private sequence = 0;
  private tasks = new Map<string, TaskState>();
  private events: BuildObservation[] = [];
  private eventSizes: number[] = [];
  private eventBytes = 0;
  private droppedEvents = 0;
  private archivedUsage = emptyUsage();
  private archivedUsageComplete = true;

  constructor(runId: string, options: { limits?: Partial<StateLimits> } = {}) {
    validateIdentifier(runId, "Run ID");
    this.runId = runId;
    this.limits = Object.freeze(stateLimits(options.limits));
  }

  registerAttempt(registration: AttemptRegistration, at = Date.now()): TaskSnapshot {
    const clean = normalizeAttempt(registration);
    this.checkIdentity(clean);
    timestamp(at);
    const previous = this.tasks.get(registration.taskId);
    if (previous) {
      if (registration.attemptNumber <= previous.snapshot.attemptNumber || previous.attemptIds.has(registration.attemptId)) throw new Error("Attempt identity/number must advance");
      if (previous.attemptIds.size >= this.limits.maxAttemptsPerTask) throw new Error("Attempt identity capacity exceeded");
      if (previous.snapshot.controls.some((control) => !isTerminalControl(control.status) && control.status !== "proposed")) throw new Error("Attempt still has accepted controls");
      this.archivedUsage = addUsage(this.archivedUsage, previous.snapshot.usage);
      this.archivedUsageComplete &&= previous.snapshot.usageComplete;
    } else if (this.tasks.size >= this.limits.maxTasks) throw new Error("Task state capacity exceeded");
    const snapshot: TaskSnapshot = {
      ...clean, sequence: this.sequence + 1, phase: "starting", lastTransportAt: null, lastProgressAt: at,
      assistantText: boundedText("", this.limits.textBytes), activity: { thinkingBytes: 0, toolArgumentBytes: 0 },
      tools: [], droppedTools: 0, droppedBlocks: 0, droppedControls: 0,
      retries: { active: false, source: "assistant", attempt: 0, count: 0, maxAttempts: 0, delayMs: 0 },
      compaction: { active: false, count: 0, reason: "", aborted: false, willRetry: false },
      humanWait: { since: null, totalMs: 0 }, queues: { steering: 0, followUp: 0 },
      usage: emptyUsage(), usageComplete: true, controls: [],
    };
    const attemptIds = new Set(previous?.attemptIds);
    attemptIds.add(registration.attemptId);
    this.tasks.set(registration.taskId, { snapshot, attemptIds, blocks: new Map(), finalizedUsage: emptyUsage(), usageKeys: new Set(), completedStarts: new Set(), compactionGeneration: 0 });
    this.append(registration, { kind: "attempt", registration: clean }, at, true, true);
    return immutable(snapshot);
  }

  observeRpc(identity: AttemptIdentity, record: Record<string, unknown>, at = Date.now()): BuildObservation {
    return this.apply(identity, normalizeRpcRecord(record, this.limits), at, true);
  }

  /** Parent observations only. Raw child records must enter through observeRpc's whitelist. */
  observe(identity: AttemptIdentity, payload: ParentObservation, at = Date.now()): BuildObservation {
    let normalized: ParentObservation;
    switch (payload.kind) {
      case "control": normalized = { kind: "control", control: normalizeControl(payload.control) }; break;
      case "error": {
        const error = boundedText(payload.error.text, this.limits.evidenceBytes);
        error.originalBytes = Math.max(error.originalBytes, count(payload.error.originalBytes));
        error.truncated ||= payload.error.truncated;
        normalized = { kind: "error", error };
        break;
      }
      case "phase":
        if (!["starting", "running", "retrying", "compacting", "settled", ...CLOSED_PHASES].includes(payload.phase)) throw new Error("Invalid task phase");
        normalized = { kind: "phase", phase: payload.phase };
        break;
      case "human-wait": normalized = { kind: "human-wait", waiting: payload.waiting === true }; break;
      case "session":
        validateIdentifier(payload.sessionId, "Session ID");
        if (payload.sessionFile !== undefined && Buffer.byteLength(payload.sessionFile) > 4096) throw new Error("Session path exceeds byte limit");
        normalized = { kind: "session", sessionId: payload.sessionId, sessionFile: payload.sessionFile };
        break;
      default: throw new Error("Unsupported parent observation");
    }
    return this.apply(identity, normalized, at, false);
  }

  inspectTask(taskId: string): TaskSnapshot {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return immutable(task.snapshot);
  }

  inspectBuild(): BuildSnapshot {
    let usage = this.archivedUsage;
    let usageComplete = this.archivedUsageComplete;
    for (const task of this.tasks.values()) {
      usage = addUsage(usage, task.snapshot.usage);
      usageComplete &&= task.snapshot.usageComplete;
    }
    return immutable({ runId: this.runId, sequence: this.sequence, tasks: [...this.tasks.values()].map((task) => task.snapshot), usage, usageComplete, events: this.events, eventBytes: this.eventBytes, droppedEvents: this.droppedEvents });
  }

  private checkIdentity(identity: AttemptIdentity): void {
    validateIdentity(identity);
    if (identity.runId !== this.runId) throw new Error("Observation belongs to a different run");
  }

  private apply(identity: AttemptIdentity, payload: ObservationPayload, at: number, transport: boolean): BuildObservation {
    this.checkIdentity(identity);
    timestamp(at);
    const task = this.tasks.get(identity.taskId);
    if (!task || task.snapshot.attemptId !== identity.attemptId) return this.append(identity, { kind: "stale", recordType: payload.kind }, at, false, false);
    const meaningful = this.reduce(task, payload, at);
    if (transport) task.snapshot.lastTransportAt = Math.max(at, task.snapshot.lastTransportAt ?? 0);
    if (meaningful) task.snapshot.lastProgressAt = Math.max(at, task.snapshot.lastProgressAt);
    task.snapshot.sequence = this.sequence + 1;
    return this.append(identity, payload, at, true, meaningful);
  }

  private append(identity: AttemptIdentity, payload: ObservationPayload, at: number, applied: boolean, meaningful: boolean): BuildObservation {
    const event = immutable({ runId: identity.runId, taskId: identity.taskId, attemptId: identity.attemptId, sequence: ++this.sequence, observedAt: at, applied, meaningful, payload });
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.events.push(event);
    this.eventSizes.push(bytes);
    this.eventBytes += bytes;
    while (this.events.length > this.limits.maxEvents || this.eventBytes > this.limits.maxEventBytes) {
      this.events.shift();
      this.eventBytes -= this.eventSizes.shift()!;
      this.droppedEvents++;
    }
    return event;
  }

  private recordUsage(task: TaskState, key: string, usage: Usage): boolean {
    if (task.usageKeys.has(key)) return false;
    if (task.usageKeys.size >= this.limits.maxUsageEntries) {
      task.snapshot.usageComplete = false;
      task.snapshot.disableReason = "Usage identity capacity exceeded; supervision cannot enforce its usage budget";
      return false;
    }
    task.usageKeys.add(key);
    task.finalizedUsage = addUsage(task.finalizedUsage, usage);
    return true;
  }

  private refreshUsage(task: TaskState): void {
    task.snapshot.usage = addUsage(task.finalizedUsage, task.currentMessage?.usage ?? emptyUsage());
  }

  private refreshText(task: TaskState): void {
    task.snapshot.assistantText = joinedText([...task.blocks].map(([index, content]) => ({ index, content })), this.limits.textBytes, task.snapshot.droppedBlocks > 0);
  }

  private reduce(task: TaskState, payload: ObservationPayload, at: number): boolean {
    const snapshot = task.snapshot;
    switch (payload.kind) {
      case "phase": {
        if (["done", "failed", "cancelled"].includes(snapshot.phase) && payload.phase !== snapshot.phase) throw new Error("Terminal task phase cannot reopen");
        const changed = snapshot.phase !== payload.phase;
        snapshot.phase = payload.phase;
        return changed;
      }
      case "agent":
        if (CLOSED_PHASES.includes(snapshot.phase)) return false;
        if (payload.stage === "start") snapshot.phase = "running";
        if (payload.stage === "settled") {
          const changed = snapshot.phase !== "settled" || (payload.aborted && snapshot.outcome !== "aborted");
          snapshot.phase = "settled";
          snapshot.retries.active = false;
          snapshot.compaction.active = false;
          if (payload.aborted) snapshot.outcome = "aborted";
          return changed;
        }
        return false;
      case "message": {
        const message = payload.message;
        if (message.role === "assistant") {
          if (payload.stage === "start") {
            if (task.currentMessage?.key === message.key || task.usageKeys.has(message.key) || task.completedStarts.has(message.key)) return false;
            // A missing final event makes accounting incomplete, not silently free.
            if (task.currentMessage) {
              this.recordUsage(task, task.currentMessage.key, task.currentMessage.usage);
              snapshot.usageComplete = false;
              snapshot.disableReason = "Assistant message started before the previous authoritative ending";
            }
            task.currentMessage = { key: message.key, usage: message.usage };
            task.blocks = new Map(message.blocks.map((block) => [block.index, block.content]));
            snapshot.droppedBlocks = message.droppedBlocks;
            snapshot.outcome = "pending";
            snapshot.error = undefined;
            this.refreshText(task);
            this.refreshUsage(task);
            return false;
          }
          if (task.usageKeys.has(message.key)) return false;
          this.recordUsage(task, message.key, message.usage);
          if (task.currentMessage && task.completedStarts.size < this.limits.maxUsageEntries) task.completedStarts.add(task.currentMessage.key);
          task.currentMessage = undefined;
          task.blocks = new Map(message.blocks.map((block) => [block.index, block.content]));
          snapshot.droppedBlocks = message.droppedBlocks;
          snapshot.outcome = message.outcome;
          snapshot.error = message.error;
          this.refreshText(task);
          this.refreshUsage(task);
          return true;
        }
        if (payload.stage === "end" && message.role === "toolResult") {
          if (task.usageKeys.has(message.key)) return false;
          this.recordUsage(task, message.key, message.usage);
          this.refreshUsage(task);
          return this.reduce(task, {
            kind: "tool", toolCallId: message.toolCallId ?? "", toolName: message.toolName ?? "", stage: "end",
            input: boundedText("", 0), output: joinedText(message.blocks, this.limits.evidenceBytes, message.droppedBlocks > 0), isError: message.isError,
          }, at);
        }
        return false;
      }
      case "text": {
        if (payload.usage && task.currentMessage) { task.currentMessage.usage = payload.usage; this.refreshUsage(task); }
        if (!task.currentMessage) return false;
        const previous = task.blocks.get(payload.index);
        if (!previous && task.blocks.size >= this.limits.maxBlocks) { snapshot.droppedBlocks++; this.refreshText(task); return false; }
        let content = payload.content;
        if (payload.operation === "start") content = boundedText("", 0);
        if (payload.operation === "append" && previous) {
          content = boundedText(previous.text + content.text, this.limits.textBytes);
          content.originalBytes = previous.originalBytes + payload.content.originalBytes;
          content.truncated ||= previous.truncated || payload.content.truncated;
        }
        task.blocks.set(payload.index, content);
        this.refreshText(task);
        return payload.content.originalBytes > 0 && (payload.operation === "append" || content.text !== previous?.text);
      }
      case "activity":
        if (payload.usage && task.currentMessage) { task.currentMessage.usage = payload.usage; this.refreshUsage(task); }
        if (payload.channel === "thinking") snapshot.activity.thinkingBytes += payload.bytes;
        if (payload.channel === "tool-arguments") snapshot.activity.toolArgumentBytes += payload.bytes;
        return false;
      case "tool": {
        const index = snapshot.tools.findIndex((tool) => tool.toolCallId === payload.toolCallId);
        const previous = snapshot.tools[index];
        const { kind: _, ...evidence } = payload;
        const tool = { ...evidence, sequence: this.sequence + 1 };
        if (previous && !tool.input.text) tool.input = previous.input;
        if (previous && tool.durationMs === undefined) tool.durationMs = previous.durationMs;
        if (index >= 0) snapshot.tools.splice(index, 1);
        snapshot.tools.push(tool);
        if (snapshot.tools.length > this.limits.maxTools) { snapshot.tools.shift(); snapshot.droppedTools++; }
        return !previous || previous.stage !== tool.stage || previous.output.text !== tool.output.text;
      }
      case "retry": {
        const previous = snapshot.retries;
        const newRetry = !previous.active || previous.source !== payload.source;
        if (payload.active && (newRetry || (payload.attempt !== undefined && payload.attempt !== previous.attempt))) previous.count++;
        snapshot.retries = {
          active: payload.active, source: payload.source, count: previous.count,
          attempt: payload.attempt ?? previous.attempt, maxAttempts: payload.maxAttempts ?? previous.maxAttempts,
          delayMs: payload.delayMs ?? previous.delayMs, success: payload.success,
        };
        let phase: TaskPhase = "running";
        if (snapshot.compaction.active) phase = "compacting";
        if (payload.active) phase = "retrying";
        executionPhase(snapshot, phase);
        if (payload.error.text) snapshot.error = payload.error;
        return false;
      }
      case "compaction":
        if (payload.active && !snapshot.compaction.active) { task.compactionGeneration++; snapshot.compaction.count++; }
        snapshot.compaction.active = payload.active;
        snapshot.compaction.reason = payload.reason;
        snapshot.compaction.aborted = payload.aborted;
        snapshot.compaction.willRetry = payload.willRetry;
        executionPhase(snapshot, payload.active ? "compacting" : "running");
        if (!payload.active) {
          this.recordUsage(task, `compaction:${task.compactionGeneration}`, payload.usage);
          this.refreshUsage(task);
        }
        if (payload.error.text) snapshot.error = payload.error;
        return false;
      case "usage":
        this.recordUsage(task, payload.key, payload.usage);
        this.refreshUsage(task);
        return false;
      case "queues": snapshot.queues = { steering: payload.steering, followUp: payload.followUp }; return false;
      case "session":
        snapshot.session = { runId: snapshot.runId, taskId: snapshot.taskId, attemptId: snapshot.attemptId, attemptNumber: snapshot.attemptNumber, workspacePath: snapshot.workspacePath, role: "builder", sessionId: payload.sessionId, sessionFile: payload.sessionFile };
        return false;
      case "human-wait":
        if (payload.waiting && snapshot.humanWait.since === null) snapshot.humanWait.since = at;
        if (!payload.waiting && snapshot.humanWait.since !== null) {
          snapshot.humanWait.totalMs += Math.max(0, at - snapshot.humanWait.since);
          snapshot.humanWait.since = null;
        }
        return false;
      case "control": {
        const control = normalizeControl(payload.control);
        if (control.runId !== snapshot.runId || control.taskId !== snapshot.taskId || control.attemptId !== snapshot.attemptId) throw new Error("Control identity does not match observation");
        const index = snapshot.controls.findIndex((entry) => entry.controlId === control.controlId);
        if (index >= 0) {
          const previous = snapshot.controls[index];
          if (control.origin !== previous.origin || control.createdAt !== previous.createdAt) throw new Error("Control identity changed");
          reduceControl(previous, control.status, control.updatedAt);
          snapshot.controls[index] = control;
        } else {
          if (snapshot.controls.length >= this.limits.maxControls) {
            const terminal = snapshot.controls.findIndex((entry) => isTerminalControl(entry.status) || entry.status === "proposed");
            if (terminal < 0) throw new Error("Control state capacity exceeded");
            snapshot.controls.splice(terminal, 1);
            snapshot.droppedControls++;
          }
          snapshot.controls.push(control);
        }
        return false;
      }
      case "error": snapshot.error = payload.error; return false;
      default: return false;
    }
  }
}
