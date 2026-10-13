import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { BuildController, type ControllerJournal, type ControllerTransport } from "../.pi/agent/extensions/planner-builder/build-controller.ts";
import { type AttemptIdentity, type ControlRecord } from "../.pi/agent/extensions/planner-builder/build-state.ts";
import { RpcAgent, type RpcClock, type RpcCloseResult, type RpcPromptResult, type RpcRecord, type RpcResponse } from "../.pi/agent/extensions/planner-builder/rpc-agent.ts";
import { JournalCapacityError, RunJournal } from "../.pi/agent/extensions/planner-builder/run-journal.ts";
import { type TaskEvidence } from "../.pi/agent/extensions/planner-builder/task-evidence.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush(): Promise<void> { for (let i = 0; i < 40; i++) await Promise.resolve(); }
class Clock implements RpcClock {
  time = 1000;
  timers = new Map<object, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, ms: number): object {
    const key = {};
    this.timers.set(key, { at: this.time + ms, callback });
    return key;
  }
  clearTimeout(key: unknown): void { this.timers.delete(key as object); }
  async advance(ms: number): Promise<void> {
    this.time += ms;
    for (const [key, timer] of this.timers) {
      if (timer.at <= this.time) { this.timers.delete(key); timer.callback(); }
    }
    await flush();
  }
}
function response(command: string, data?: unknown): RpcResponse { return { type: "response", id: "response", command, success: true, data }; }
function closeResult(): RpcCloseResult { return { code: 0, signal: null, stderr: "", stderrTruncated: false, signals: [], shutdownErrors: [] }; }
class Transport implements ControllerTransport {
  listeners = new Set<(record: RpcRecord) => void>();
  close = deferred<RpcCloseResult>();
  closed = this.close.promise;
  state = { accepting: true, isSettled: false, settledGeneration: 0, pendingRequests: 0, completionWaiters: 0, queuedWrites: 0, queuedWriteBytes: 0, pendingUi: 0 };
  calls: string[] = [];
  messages: string[] = [];
  promptHook?: (message: string) => Promise<RpcPromptResult>;
  requestHook?: () => Promise<RpcResponse>;
  stopHook?: () => Promise<RpcCloseResult>;
  failure?: Error;
  onRecord(listener: (record: RpcRecord) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(record: RpcRecord): void {
    if (record.type === "agent_start") this.state.isSettled = false;
    if (record.type === "agent_settled") { this.state.isSettled = true; this.state.settledGeneration++; }
    for (const listener of this.listeners) listener(record);
  }
  finish(stopReason = "stop"): void {
    this.emit({ type: "message_end", message: { role: "assistant", content: "done", timestamp: this.state.settledGeneration + 1, stopReason } });
    this.emit({ type: "agent_settled", aborted: stopReason === "aborted" });
  }
  deliver(message = this.messages.at(-1)!): void { this.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: message }] } }); }
  async prompt(message: string, options: { streamingBehavior?: string }): Promise<RpcPromptResult> {
    assert.equal(options.streamingBehavior, "steer");
    this.calls.push("prompt");
    this.messages.push(message);
    if (this.promptHook) return this.promptHook(message);
    return { disposition: "queued", response: response("prompt", { disposition: "queued" }), settled: Promise.resolve(null) };
  }
  async request(command: string): Promise<RpcResponse> {
    this.calls.push(command);
    if (this.requestHook) return this.requestHook();
    return response(command, { isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
  }
  stop(): Promise<RpcCloseResult> {
    if (!this.state.accepting) return this.closed;
    this.state.accepting = false;
    this.calls.push("clear_queue", "abort", "join");
    void (this.stopHook?.() ?? Promise.resolve(closeResult())).then(this.close.resolve);
    return this.closed;
  }
}
class Journal implements ControllerJournal {
  status = { bytesWritten: 0, reservedBytes: 0, pendingControls: 0, canAcceptControls: true };
  controls: ControlRecord[] = [];
  decisions: unknown[] = [];
  attempts: unknown[] = [];
  sessions: unknown[] = [];
  hook?: (control: ControlRecord) => Promise<void>;
  async recordControl(control: ControlRecord): Promise<void> { await this.hook?.(control); this.controls.push(structuredClone(control)); }
  async recordDecision(decision: unknown): Promise<void> { this.decisions.push(decision); }
  async recordAttempt(attempt: unknown): Promise<void> { this.attempts.push(attempt); }
  async recordSession(session: unknown): Promise<void> { this.sessions.push(session); }
}
async function setup(mode: "off" | "advisory" | "steer" = "steer", options = {}): Promise<{
  controller: BuildController; transport: Transport; journal: Journal; clock: Clock; identity: AttemptIdentity;
}> {
  const clock = new Clock();
  const journal = new Journal();
  const transport = new Transport();
  const controller = new BuildController({
    runId: "run", journal, clock, controlTimeoutMs: 100, sealTimeoutMs: 1000,
    supervision: { supervisionMode: mode, supervisionOptions: { cooldownSeconds: 0, checkpointSeconds: 1, ...options } },
  });
  const identity = await controller.registerAttempt({ taskId: "T04", attemptNumber: 1, transport,
    workspace: { rootPath: "/workspace", vcs: "jj", baseRevision: "a".repeat(40), protectedPaths: [] },
    session: { sessionId: "session", sessionFile: "/private/session.jsonl" },
  });
  transport.emit({ type: "agent_start" });
  return { controller, transport, journal, clock, identity };
}
function guidance(identity: AttemptIdentity, controlId = "control"): Parameters<BuildController["requestGuidance"]>[0] {
  return { ...identity, controlId, origin: "supervisor", guidance: "Run the focused tests", reason: "Verification is missing", evidenceSequences: [] };
}

test("advisory records proposals, off rejects, and neither writes a builder prompt", async () => {
  for (const mode of ["advisory", "off"] as const) {
    const { controller, identity, transport, journal } = await setup(mode);
    const result = await controller.requestGuidance({ ...guidance(identity), origin: "manual" });
    assert.equal(result.status, mode === "advisory" ? "proposed" : "rejected");
    assert.equal(transport.messages.length, 0);
    assert.equal(journal.controls.at(-1)?.status, result.status);
    if (mode === "advisory") {
      assert.equal(result.proposal?.text, "Run the focused tests");
      assert.ok(JSON.stringify(journal.decisions).includes("Run the focused tests"));
    }
    await controller.cancelBuild();
  }
});

test("acceptance precedes RPC; only exact user-message evidence proves delivery", async () => {
  const { controller, identity, transport, journal } = await setup();
  const gate = deferred<void>();
  journal.hook = async (control) => { if (control.status === "accepted") await gate.promise; };
  const receipt = controller.requestGuidance(guidance(identity));
  await flush();
  assert.equal(transport.messages.length, 0);
  gate.resolve();
  assert.equal((await receipt).status, "queued");
  assert.deepEqual(journal.controls.map((c) => c.status), ["accepted", "queued"]);
  transport.emit({ type: "queue_update", steering: [], followUp: [] });
  transport.emit({ type: "message_end", message: { role: "assistant", content: transport.messages[0] } });
  transport.deliver("prefix " + transport.messages[0]);
  await flush();
  assert.equal(controller.inspectTask(identity).controls[0].status, "queued");
  transport.deliver();
  await flush();
  assert.equal(controller.inspectTask(identity).controls[0].status, "delivered");
  assert.match(transport.messages[0], /^\[planner-builder-control:/);
  assert.ok(transport.messages[0].includes("Reason: Verification is missing"));
  await controller.cancelBuild();
});

test("bounds, evidence ownership, duplicates, cooldown and intervention limits share one path", async () => {
  const { controller, identity, transport, clock } = await setup("advisory", { cooldownSeconds: 1, maxInterventionsPerTask: 2 });
  for (const [controlId, change] of Object.entries({
    bytes: { guidance: "é".repeat(2049) }, reason: { reason: "x".repeat(1025) },
    evidence: { evidenceSequences: [999] }, count: { evidenceSequences: Array(33).fill(1) },
  })) {
    assert.equal((await controller.requestGuidance({ ...guidance(identity, controlId), ...change })).status, "rejected");
  }
  const sequence = controller.inspectBuild().events.find((e) => e.taskId === identity.taskId)!.sequence;
  assert.equal((await controller.requestGuidance({ ...guidance(identity), evidenceSequences: [sequence] })).status, "proposed");
  await assert.rejects(controller.requestGuidance(guidance(identity)), /duplicate/i);
  assert.match((await controller.requestGuidance(guidance(identity, "cooldown"))).detail!, /cooldown/i);
  await clock.advance(1000);
  assert.equal((await controller.requestGuidance({ ...guidance(identity, "second"), origin: "manual" })).status, "proposed");
  await clock.advance(1000);
  assert.match((await controller.requestGuidance(guidance(identity, "third"))).detail!, /limit/i);
  assert.equal(transport.messages.length, 0);
  await controller.cancelBuild();
});

test("seal drains a reservation made before acceptance persistence, then requires fresh completion", async () => {
  const { controller, identity, transport, journal } = await setup();
  transport.finish();
  const gate = deferred<void>();
  journal.hook = async (control) => { if (control.status === "accepted") await gate.promise; };
  const receipt = controller.requestGuidance(guidance(identity));
  const sealing = controller.sealAttemptForIntegration(identity);
  await flush();
  assert.equal(transport.calls.includes("join"), false);
  assert.match((await controller.requestGuidance(guidance(identity, "late"))).detail!, /closed/i);
  gate.resolve();
  await receipt;
  transport.deliver();
  await flush();
  assert.equal(transport.calls.includes("join"), false);
  transport.finish();
  assert.equal((await sealing).ready, true);
  assert.deepEqual(transport.calls.slice(-4), ["get_state", "clear_queue", "abort", "join"]);
});

test("fast started delivery and settlement before the prompt response are not lost", async () => {
  const { controller, identity, transport } = await setup();
  transport.finish();
  transport.promptHook = async (message) => {
    transport.emit({ type: "agent_start" });
    transport.deliver(message);
    transport.finish();
    return { disposition: "started", response: response("prompt"), settled: Promise.resolve(null) };
  };
  const result = await controller.requestGuidance(guidance(identity));
  assert.equal(result.disposition, "started");
  const ready = await controller.sealAttemptForIntegration(identity);
  assert.equal(ready.settledGeneration, 2);
  assert.equal(controller.inspectTask(identity).controls[0].status, "delivered");
});

test("handled is recorded without claiming delivery or waiting for a nonexistent run", async () => {
  const { controller, identity, transport, journal } = await setup();
  transport.finish();
  transport.promptHook = async () => ({ disposition: "handled", response: response("prompt"), settled: Promise.resolve(null) });
  const result = await controller.requestGuidance(guidance(identity));
  assert.equal(result.disposition, "handled");
  assert.equal(result.status, "rejected");
  assert.ok(JSON.stringify(journal.decisions).includes("handled"));
  assert.equal((await controller.sealAttemptForIntegration(identity)).ready, true);
});

test("unknown delivery times out and retains work rather than integrating", async () => {
  const { controller, identity, transport, clock } = await setup();
  await controller.requestGuidance(guidance(identity));
  transport.finish();
  const sealing = controller.sealAttemptForIntegration(identity);
  const rejected = assert.rejects(sealing, /delivery|timed out/i);
  await clock.advance(101);
  await rejected;
  assert.equal(controller.inspectTask(identity).controls[0].status, "delivery-unknown");
  assert.equal(transport.calls.includes("join"), true);
});

test("cancellation closes admission before async writes, cancels questions and rejects stale callbacks", async () => {
  const { controller, identity, transport, journal } = await setup();
  const gate = deferred<void>();
  journal.hook = async (control) => { if (control.status === "accepted") await gate.promise; };
  controller.beginHumanWait(identity, "question");
  const receipt = controller.requestGuidance(guidance(identity));
  controller.disableSupervision("budget exhausted");
  const cancelled = controller.cancelTask(identity);
  assert.equal(controller.beginHumanWait(identity, "late"), false);
  gate.resolve();
  await cancelled;
  assert.equal((await receipt).status, "cancelled");
  assert.equal(transport.messages.length, 0);
  assert.deepEqual(transport.calls, ["clear_queue", "abort", "join"]);
  assert.equal(controller.inspectTask(identity).humanWait.since, null);
  const next = await controller.registerAttempt({ taskId: identity.taskId, attemptNumber: 2, transport: new Transport(),
    workspace: { rootPath: "/workspace", vcs: "jj", baseRevision: "a".repeat(40), protectedPaths: [] } });
  assert.notEqual(next.attemptId, identity.attemptId);
  await assert.rejects(controller.requestGuidance(guidance(identity, "stale")), /stale/i);
  assert.equal(controller.endHumanWait(identity, "question"), false);
  await controller.cancelBuild();
});

test("only actual attempt human waits pause watchdog time, with overlapping questions counted once", async () => {
  const { controller, identity, clock } = await setup();
  await clock.advance(10);
  controller.beginHumanWait(identity, "one");
  controller.beginHumanWait(identity, "two");
  await clock.advance(50);
  assert.deepEqual(controller.watchdogState(identity), { paused: true, activeIdleMs: 10, humanWaitMs: 50 });
  controller.endHumanWait(identity, "one");
  assert.equal(controller.watchdogState(identity).paused, true);
  controller.endHumanWait(identity, "two");
  await clock.advance(20);
  assert.deepEqual(controller.watchdogState(identity), { paused: false, activeIdleMs: 30, humanWaitMs: 50 });
  controller.disableSupervision("supervisor is unavailable");
  await clock.advance(10);
  assert.equal(controller.watchdogState(identity).activeIdleMs, 40);
  await controller.cancelBuild();
});

test("journal failure prevents sending and integration, but cannot disable cancellation", async () => {
  const { controller, identity, transport, journal } = await setup();
  journal.hook = async () => { throw new Error("disk failed"); };
  const result = await controller.requestGuidance(guidance(identity));
  assert.equal(result.status, "rejected");
  assert.equal(transport.messages.length, 0);
  await assert.rejects(controller.sealAttemptForIntegration(identity), /journal|disk/i);
  await controller.cancelBuild();
});

test("a second in-flight control, wrong runs and unknown tasks cannot address a child", async () => {
  const { controller, identity, transport } = await setup();
  await controller.requestGuidance(guidance(identity));
  assert.match((await controller.requestGuidance(guidance(identity, "second"))).detail!, /in flight/i);
  await assert.rejects(controller.requestGuidance({ ...guidance(identity, "other-run"), runId: "other" }), /run/i);
  await assert.rejects(controller.requestGuidance({ ...guidance(identity, "other-task"), taskId: "missing" }), /task/i);
  assert.equal(transport.messages.length, 1);
  await controller.cancelBuild();
});

test("task and run intervention budgets include reservations and survive an attempt restart", async () => {
  const { controller, identity } = await setup("advisory", { maxInterventions: 1 });
  assert.equal((await controller.requestGuidance(guidance(identity))).status, "proposed");
  await flush();
  await controller.cancelTask(identity);
  const next = await controller.registerAttempt({ taskId: identity.taskId, attemptNumber: 2, transport: new Transport(),
    workspace: { rootPath: "/workspace", vcs: "jj", baseRevision: "a".repeat(40), protectedPaths: [] } });
  assert.match((await controller.requestGuidance(guidance(next, "next"))).detail!, /limit/i);
  const other = await controller.registerAttempt({ taskId: "other", attemptNumber: 1, transport: new Transport(),
    workspace: { rootPath: "/other", vcs: "jj", baseRevision: "a".repeat(40), protectedPaths: [] } });
  assert.match((await controller.requestGuidance(guidance(other, "other"))).detail!, /limit/i);
  const sequence = controller.inspectBuild().events.find((event) => event.taskId === other.taskId)!.sequence;
  assert.match((await controller.requestGuidance({ ...guidance(next, "wrong-evidence"), evidenceSequences: [sequence] })).detail!, /evidence/i);
  await controller.cancelBuild();
});

test("disabling supervision while acceptance is being persisted revokes unsent guidance", async () => {
  const { controller, identity, transport, journal } = await setup();
  const gate = deferred<void>();
  journal.hook = async (control) => { if (control.status === "accepted") await gate.promise; };
  const receipt = controller.requestGuidance(guidance(identity));
  controller.disableSupervision("budget exhausted");
  gate.resolve();
  assert.equal((await receipt).status, "cancelled");
  assert.equal(transport.messages.length, 0);
  transport.finish();
  assert.equal((await controller.sealAttemptForIntegration(identity)).ready, true);
});

test("settlement before message delivery cannot satisfy the new guidance turn", async () => {
  const { controller, identity, transport } = await setup();
  const gate = deferred<RpcPromptResult>();
  transport.promptHook = () => gate.promise;
  const receipt = controller.requestGuidance(guidance(identity));
  await flush();
  transport.finish();
  gate.resolve({ disposition: "started", response: response("prompt"), settled: Promise.resolve(null) });
  await receipt;
  transport.deliver();
  const sealing = controller.sealAttemptForIntegration(identity);
  await flush();
  assert.equal(transport.calls.includes("get_state"), false);
  transport.finish();
  assert.equal((await sealing).settledGeneration, 2);
});

test("a new settlement cannot reuse the previous turn's assistant completion", async () => {
  const { controller, identity, transport } = await setup();
  transport.finish();
  await controller.requestGuidance(guidance(identity));
  transport.deliver();
  transport.emit({ type: "agent_settled", aborted: false });
  await assert.rejects(controller.sealAttemptForIntegration(identity), /fresh authoritative/i);
});

test("agent_end during retry is not completion; a fresh settled generation is required", async () => {
  const { controller, identity, transport } = await setup();
  transport.emit({ type: "auto_retry_start", attempt: 1 });
  const sealing = controller.sealAttemptForIntegration(identity);
  transport.emit({ type: "agent_end", willRetry: true });
  await flush();
  assert.equal(transport.calls.length, 0);
  transport.emit({ type: "auto_retry_end", success: true });
  transport.finish();
  assert.equal((await sealing).ready, true);
});

test("settled errors, aborts, length truncation and absent outcomes cannot grant readiness", async () => {
  for (const outcome of ["error", "aborted", "length", "pending", "deferred", "toolUse"]) {
    const { controller, identity, transport } = await setup();
    transport.finish(outcome);
    await assert.rejects(controller.sealAttemptForIntegration(identity), /complete successfully/i);
    assert.equal(controller.inspectTask(identity).readyForIntegration, false);
    assert.equal(transport.calls.includes("join"), true);
  }
});

test("state confirmation must prove idle and empty queues, and revalidate after awaiting RPC", async () => {
  for (const change of ["streaming", "queue", "race"] as const) {
    const { controller, identity, transport } = await setup();
    transport.finish();
    transport.requestHook = async () => {
      if (change === "race") transport.emit({ type: "agent_start" });
      return response("get_state", { isStreaming: change === "streaming", isCompacting: false, pendingMessageCount: change === "queue" ? 1 : 0 });
    };
    await assert.rejects(controller.sealAttemptForIntegration(identity), /changed|pending/i);
    assert.equal(transport.calls.includes("join"), true);
  }
});

test("integration waits for join; an empty clear_queue event is harmless but new work is not", async () => {
  for (const newWork of [false, true]) {
    const { controller, identity, transport } = await setup();
    transport.finish();
    const join = deferred<RpcCloseResult>();
    transport.stopHook = () => join.promise;
    const sealing = controller.sealAttemptForIntegration(identity);
    const outcome = sealing.then(() => "ready", () => "retained");
    await flush();
    assert.equal(controller.inspectTask(identity).readyForIntegration, false);
    transport.emit({ type: "queue_update", steering: [], followUp: [] });
    if (newWork) transport.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "late" });
    join.resolve(closeResult());
    assert.equal(await outcome, newWork ? "retained" : "ready");
  }
});

test("a failed or unjoined child never grants integration readiness", async () => {
  for (const timeout of [false, true]) {
    const { controller, identity, transport, clock } = await setup();
    transport.finish();
    transport.stopHook = () => timeout ? new Promise(() => {}) : Promise.resolve({ ...closeResult(), shutdownErrors: ["clear_queue failed"] });
    const sealing = controller.sealAttemptForIntegration(identity);
    const rejected = assert.rejects(sealing, /shutdown/i);
    await flush();
    if (timeout) await clock.advance(1001);
    await rejected;
    assert.equal(controller.inspectTask(identity).readyForIntegration, false);
  }
});

test("checkpoint reasoning is bounded, does not pause the watchdog, and late guidance is rejected", async () => {
  const { controller, identity, transport, clock } = await setup();
  transport.finish();
  let signal: AbortSignal | undefined;
  const sealing = controller.sealAttemptForIntegration(identity, { checkpoint: async (value) => {
    signal = value;
    await new Promise(() => {});
  } });
  await flush();
  await clock.advance(500);
  assert.equal(controller.watchdogState(identity).paused, false);
  assert.equal(controller.watchdogState(identity).activeIdleMs, 500);
  assert.equal(transport.calls.length, 0);
  await clock.advance(501);
  assert.equal(signal?.aborted, true);
  assert.equal((await sealing).ready, true);
  const late = await controller.requestGuidance(guidance(identity, "late-review"));
  assert.equal(late.status, "rejected");
  assert.equal(transport.messages.length, 0);
});

test("checkpoint guidance starts fresh work and is drained before integration", async () => {
  const { controller, identity, transport } = await setup();
  transport.finish();
  const sealing = controller.sealAttemptForIntegration(identity, { checkpoint: async () => {
    await controller.requestGuidance(guidance(identity));
  } });
  await flush();
  assert.equal(transport.messages.length, 1);
  assert.equal(transport.calls.includes("join"), false);
  transport.deliver();
  transport.finish();
  assert.equal((await sealing).ready, true);
});

test("inspection rechecks current state after a task completes and rejects results after closure", async () => {
  const evidence = deferred<TaskEvidence>();
  const transport = new Transport();
  const controller = new BuildController({ runId: "inspection", createEvidence: () => ({ read: () => evidence.promise }) });
  const identity = await controller.registerAttempt({ taskId: "T04", attemptNumber: 1, transport,
    workspace: { rootPath: "/workspace", vcs: "jj", baseRevision: "a".repeat(40), protectedPaths: [] } });
  const inspection = controller.inspectTask(identity, { kind: "file", path: "code.ts" });
  transport.finish();
  evidence.resolve({ ...identity, kind: "file", path: "code.ts", text: "code", observedAt: "now", completedAt: "now", truncated: false,
    concurrentChangesPossible: true, integrationValidation: false, notes: [] });
  assert.equal((await inspection).snapshot.phase, "settled");
  const lateInspection = controller.inspectTask(identity, { kind: "file", path: "code.ts" });
  const rejected = assert.rejects(lateInspection, /closed/i);
  const sealed = controller.sealAttemptForIntegration(identity);
  await rejected;
  await sealed;
  assert.equal(controller.inspectTask(identity).readyForIntegration, true);
});

test("progress during a human wait resets only active watchdog time; notifications are not waits", async () => {
  const { controller, identity, transport, clock } = await setup();
  transport.emit({ type: "extension_ui_request", id: "notification", method: "notify" });
  assert.equal(controller.watchdogState(identity).paused, false);
  await clock.advance(10);
  controller.beginHumanWait(identity, "question");
  await clock.advance(10);
  transport.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "progress" });
  await clock.advance(30);
  controller.endHumanWait(identity, "question");
  await clock.advance(20);
  assert.deepEqual(controller.watchdogState(identity), { paused: false, activeIdleMs: 20, humanWaitMs: 40 });
  await controller.cancelBuild();
});

test("task and build cancellation use question ownership even when supervision is off", async () => {
  const calls: string[] = [];
  const controller = new BuildController({ runId: "cancel", questions: {
    cancelOwner(owner) { calls.push(owner); }, async close() { calls.push("close"); },
  } });
  const identities: AttemptIdentity[] = [];
  for (const taskId of ["one", "two"]) {
    identities.push(await controller.registerAttempt({ taskId, attemptNumber: 1, transport: new Transport(),
      workspace: { rootPath: "/workspace", vcs: "jj", baseRevision: "a".repeat(40), protectedPaths: [] } }));
  }
  controller.disableSupervision("disabled");
  const stopping = controller.cancelBuild();
  assert.equal(controller.cancelBuild(), stopping);
  await stopping;
  assert.deepEqual(calls, [...identities.map((identity) => identity.attemptId), "close"]);
});

test("unexpected exit and delivered-terminal journal failure retain uncertain work", async () => {
  const exited = await setup();
  await exited.controller.requestGuidance(guidance(exited.identity));
  exited.transport.close.resolve({ ...closeResult(), error: new Error("unexpected exit") });
  await flush();
  assert.equal(exited.controller.inspectTask(exited.identity).controls[0].status, "delivery-unknown");
  await assert.rejects(exited.controller.sealAttemptForIntegration(exited.identity), /unexpected exit/i);

  const delivered = await setup();
  await delivered.controller.requestGuidance(guidance(delivered.identity));
  delivered.journal.hook = async (control) => { if (control.status === "delivered") throw new Error("terminal disk failure"); };
  delivered.transport.deliver();
  await flush();
  assert.equal(delivered.controller.inspectTask(delivered.identity).controls[0].status, "delivered");
  await assert.rejects(delivered.controller.sealAttemptForIntegration(delivered.identity), /disk/i);
});

test("real journal records attempts, sessions, acceptance, disposition and observed delivery in order", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-journal-"));
  const journal = await RunJournal.open({ runDirectory: path.join(dir, "run"), runId: "durable", sourceRoots: [], protectedPaths: [] });
  try {
    const transport = new Transport();
    const controller = new BuildController({ runId: "durable", journal, supervision: { supervisionMode: "steer" } });
    const identity = await controller.registerAttempt({ taskId: "T04", attemptNumber: 1, transport,
      workspace: { rootPath: "/workspace", vcs: "jj", baseRevision: "a".repeat(40), protectedPaths: [] },
      session: { sessionId: "session", sessionFile: path.join(journal.runDirectory, "builder.jsonl") },
    });
    await controller.requestGuidance(guidance(identity));
    transport.deliver();
    transport.finish();
    await controller.sealAttemptForIntegration(identity);
    await journal.close();
    const records = (await fs.readFile(journal.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.kind), ["attempt", "session", "control", "decision", "control", "control"]);
    assert.deepEqual(records.filter((record) => record.kind === "control").map((record) => record.status), ["accepted", "queued", "delivered"]);
    assert.equal(journal.status.pendingControls, 0);
  } finally {
    await journal.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("journal capacity refuses unsent controls without stopping an otherwise healthy builder", async () => {
  for (const alreadyClosed of [false, true]) {
    const { controller, identity, transport, journal } = await setup();
    journal.status.canAcceptControls = !alreadyClosed;
    journal.hook = async () => { throw new JournalCapacityError(); };
    const receipt = await controller.requestGuidance(guidance(identity));
    assert.equal(receipt.status, "rejected");
    assert.match(receipt.detail!, /not durable/i);
    assert.equal(transport.calls.length, 0);
    transport.finish();
    assert.equal((await controller.sealAttemptForIntegration(identity)).ready, true);
  }
});

test("an acceptance write that outlives its deadline can never send a late prompt", async () => {
  const { controller, identity, transport, journal, clock } = await setup();
  const gate = deferred<void>();
  journal.hook = async (control) => { if (control.status === "accepted") await gate.promise; };
  const receipt = controller.requestGuidance(guidance(identity));
  await clock.advance(101);
  assert.equal((await receipt).status, "rejected");
  gate.resolve();
  await flush();
  assert.equal(transport.messages.length, 0);
  await assert.rejects(controller.sealAttemptForIntegration(identity), /journal|timed out/i);
});

test("plain-text wrappers cannot become slash commands and encode ambiguous control IDs", async () => {
  const { controller, identity, transport } = await setup();
  await controller.requestGuidance({ ...guidance(identity, "] [other-marker]"), guidance: "/dangerous-command" });
  const text = transport.messages[0];
  assert.match(text.split("\n")[0], /^\[planner-builder-control:[A-Za-z0-9_-]+\]$/);
  assert.ok(text.endsWith("Guidance:\n/dangerous-command"));
  assert.equal(text.startsWith("/"), false);
  await controller.cancelBuild();
});

test("the actual RPC adapter completes the controller barrier with no model or remote", async () => {
  const childSource = `
    let buffer = "";
    function emit(record) { process.stdout.write(JSON.stringify(record) + "\\n"); }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\\n")) !== -1) {
        const command = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        let data;
        if (command.type === "prompt") {
          emit({ type: "agent_start" });
          emit({ type: "message_end", message: { role: "user", content: command.message } });
          emit({ type: "message_end", message: { role: "assistant", content: "done", timestamp: 1, stopReason: "stop" } });
          emit({ type: "agent_settled", aborted: false });
          data = { disposition: "started" };
        }
        if (command.type === "get_state") data = { isStreaming: false, isCompacting: false, pendingMessageCount: 0, sessionId: "rpc-session" };
        if (command.type === "clear_queue") emit({ type: "queue_update", steering: [], followUp: [] });
        emit({ type: "response", id: command.id, command: command.type, success: true, data });
      }
    });
  `;
  const journal = new Journal();
  const controller = new BuildController({ runId: "rpc", journal, supervision: { supervisionMode: "steer" },
    createTransport(options, identity) {
      assert.equal(identity.runId, "rpc");
      return new RpcAgent(options);
    },
  });
  try {
    const identity = await controller.registerAttempt({ taskId: "T04", attemptNumber: 1,
      workspace: { rootPath: process.cwd(), vcs: "jj", baseRevision: "a".repeat(40), protectedPaths: [] },
      rpc: { invocation: { command: process.execPath, args: ["-e", childSource] }, cwd: process.cwd(), env: process.env },
    });
    const receipt = await controller.requestGuidance(guidance(identity));
    assert.equal(receipt.disposition, "started");
    const ready = await controller.sealAttemptForIntegration(identity);
    assert.equal(ready.ready, true);
    assert.equal(controller.inspectTask(identity).controls[0].status, "delivered");
    assert.equal(controller.inspectTask(identity).session?.sessionId, "rpc-session");
    assert.equal(journal.sessions.length, 1);
  } finally { await controller.cancelBuild(); }
});

test("a session switch cannot silently remap a live attempt", async () => {
  const { controller, identity, transport } = await setup();
  transport.emit(response("get_state", { sessionId: "different-session" }));
  await flush();
  assert.match(controller.inspectTask(identity).controllerError!, /session changed/i);
  await assert.rejects(controller.sealAttemptForIntegration(identity), /session changed/i);
  await controller.cancelBuild();
});

test("cancellation revokes cached readiness and also wins a reentrant readiness notification", async () => {
  for (const reentrant of [false, true]) {
    const { controller, identity, transport } = await setup();
    transport.finish();
    if (reentrant) {
      controller.onObservation((event) => {
        if (event.payload.kind === "phase" && event.payload.phase === "integrating") void controller.cancelTask(identity);
      });
      await assert.rejects(controller.sealAttemptForIntegration(identity), /cancelled/i);
    } else {
      assert.equal((await controller.sealAttemptForIntegration(identity)).ready, true);
      await controller.cancelTask(identity);
    }
    assert.equal(controller.inspectTask(identity).readyForIntegration, false);
    await assert.rejects(controller.sealAttemptForIntegration(identity), /cancelled/i);
  }
});
