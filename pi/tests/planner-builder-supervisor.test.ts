import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { BuildController, type ControllerJournal, type ControllerTransport } from "../.pi/agent/extensions/planner-builder/build-controller.ts";
import { SUPERVISION_LIMITS, type AttemptIdentity, type BuildObservation, type SessionMapping } from "../.pi/agent/extensions/planner-builder/build-state.ts";
import type { ParentQuestion, QuestionResult } from "../.pi/agent/extensions/planner-builder/question-queue.ts";
import type { RpcAgentOptions, RpcClock, RpcCloseResult, RpcPromptResult, RpcRecord, RpcResponse, RpcSettlement } from "../.pi/agent/extensions/planner-builder/rpc-agent.ts";
import type { JournalDecision } from "../.pi/agent/extensions/planner-builder/run-journal.ts";
import { SUPERVISOR_TOOLS, type SupervisorBridgeOptions, type SupervisorToolRequest } from "../.pi/agent/extensions/planner-builder/supervisor-bridge.ts";
import { startSupervisor, type Supervisor, type SupervisorOptions } from "../.pi/agent/extensions/planner-builder/supervisor.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush(): Promise<void> { for (let i = 0; i < 100; i++) await Promise.resolve(); }
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
    const until = this.time + ms;
    for (;;) {
      const next = [...this.timers].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = until;
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
  failure?: Error;
  messages: string[] = [];
  commands: string[] = [];
  stops = 0;
  reportedTokens = 0;
  sessionId = "session";
  sessionFile = "/private/session.jsonl";
  completion?: ReturnType<typeof deferred<RpcSettlement | null>>;
  promptHook?: () => Promise<RpcPromptResult>;
  stopHook?: () => Promise<RpcCloseResult>;
  private message = 0;
  onRecord(listener: (record: RpcRecord) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(record: RpcRecord): void {
    if (record.type === "agent_start") this.state.isSettled = false;
    if (record.type === "agent_settled") { this.state.isSettled = true; this.state.settledGeneration++; }
    for (const listener of this.listeners) listener(record);
  }
  assistant(tokens = 0, stopReason = "stop", content = "No intervention needed"): void {
    this.emit({ type: "message_end", message: { role: "assistant", timestamp: ++this.message, content: [{ type: "text", text: content }], stopReason, usage: { totalTokens: tokens } } });
  }
  finish(tokens = 0, stopReason = "stop"): void {
    this.assistant(tokens, stopReason);
    this.emit({ type: "agent_end", messages: [] });
    this.emit({ type: "agent_settled", aborted: stopReason === "aborted" });
    this.completion?.resolve({ generation: this.state.settledGeneration, observedAt: 0, aborted: stopReason === "aborted" });
  }
  async prompt(message: string): Promise<RpcPromptResult> {
    this.messages.push(message);
    this.emit({ type: "agent_start" });
    if (this.promptHook) return this.promptHook();
    this.completion = deferred();
    return { disposition: "started", response: response("prompt"), settled: this.completion.promise };
  }
  async request(command: string): Promise<RpcResponse> {
    this.commands.push(command);
    if (command === "get_state") return response(command, { sessionId: this.sessionId, sessionFile: this.sessionFile, isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
    if (command === "get_session_stats") return response(command, { tokens: { total: this.reportedTokens } });
    throw new Error(`Unexpected command ${command}`);
  }
  stop(): Promise<RpcCloseResult> {
    if (this.stops++) return this.closed;
    this.state.accepting = false;
    this.commands.push("clear_queue", "abort", "join");
    this.completion?.reject(new Error("stopped"));
    void (this.stopHook?.() ?? Promise.resolve(closeResult())).then(this.close.resolve);
    return this.closed;
  }
}
class Journal implements ControllerJournal {
  runId = "run";
  runDirectory = "";
  status = { bytesWritten: 0, reservedBytes: 0, pendingControls: 0, canAcceptControls: true, disableReason: undefined as string | undefined };
  decisions: JournalDecision[] = [];
  sessions: SessionMapping[] = [];
  decisionHook?: () => Promise<void>;
  sessionHook?: () => Promise<void>;
  async recordControl(): Promise<void> {}
  async recordAttempt(): Promise<void> {}
  async recordDecision(decision: JournalDecision): Promise<void> { await this.decisionHook?.(); this.decisions.push(decision); }
  async recordSession(session: SessionMapping): Promise<void> { await this.sessionHook?.(); this.sessions.push(session); }
}
interface Fixture {
  supervisor: Supervisor; controller: BuildController; builder: Transport; child: Transport;
  identity: AttemptIdentity; clock: Clock; journal: Journal; warnings: string[];
  launches: RpcAgentOptions[]; options: SupervisorOptions; bridgeDisposals: () => number;
  emitProgress: (value?: string) => void;
  tool: (name: SupervisorToolRequest["toolName"], args: Record<string, unknown>) => Promise<unknown>;
  begin: () => Promise<void>;
  question: { ask: (question: ParentQuestion, signal?: AbortSignal) => Promise<QuestionResult>; cancelled: string[] };
}
async function setup(t: TestContext, config: Record<string, unknown> = {}, customize?: (options: SupervisorOptions, fixture: Omit<Fixture, "supervisor" | "tool" | "begin" | "emitProgress">) => void): Promise<Fixture> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-supervisor-test-"));
  const clock = new Clock();
  const journal = new Journal();
  journal.runDirectory = directory;
  const controller = new BuildController({ runId: "run", clock, journal,
    supervision: { supervisionMode: config.supervisionMode ?? "steer", supervisionOptions: { intervalSeconds: 1, cooldownSeconds: 0, ...config } } });
  const builder = new Transport();
  const identity = await controller.registerAttempt({ taskId: "T05", attemptNumber: 1, transport: builder,
    workspace: { rootPath: "/workspace", vcs: "jj", baseRevision: "a".repeat(40), protectedPaths: [] } });
  const child = new Transport();
  const warnings: string[] = [];
  const launches: RpcAgentOptions[] = [];
  const question: Fixture["question"] = { ask: async (): Promise<QuestionResult> => ({ status: "unavailable" }), cancelled: [] };
  let bridgeOptions!: SupervisorBridgeOptions;
  let disposals = 0;
  const results = new Map<string, Promise<unknown>>();
  let toolId = 0;
  const options: SupervisorOptions = {
    controller, journal,
    agent: { name: "custom", description: "custom", tools: ["bash", "subagent", "read", "verifier"], includeExtensions: true, systemPrompt: "Custom guidance", source: "user", filePath: "/custom.md" },
    context: { planText: "Plan body", constraints: "Never modify the source checkout", verificationInstructions: "node --test", acceptanceInstructions: "One atomic commit", recordedDecisions: "Use jj" },
    questions: { ask: (input, signal) => question.ask(input, signal), cancelOwner: (owner) => { question.cancelled.push(owner); } },
    onDisabled: (reason) => warnings.push(reason),
    model: "provider/model", effort: "max",
    dependencies: {
      clock, env: { PI_CODING_AGENT_DIR: path.join(directory, "credentials"), PI_SESSION_ID: "parent", PI_USER_QUESTION_BRIDGE_DIR: "/other" },
      getInvocation: (args) => ({ command: "pi", args }),
      createBridge: async (input) => {
        bridgeOptions = input;
        return { dir: "/bridge", extensionPath: "/bridge/extension.ts", cancel: () => {}, dispose: async () => { disposals++; },
          handleToolStart: async (record: unknown) => {
            const request = record as SupervisorToolRequest;
            const result = input.dispatch(request, input.identity, new AbortController().signal);
            results.set(request.toolCallId, result);
            await result;
            return true;
          } };
      },
      createTransport: (input) => {
        launches.push(input);
        child.sessionId = input.invocation.args[input.invocation.args.indexOf("--session-id") + 1];
        child.sessionFile = path.join(input.invocation.args[input.invocation.args.indexOf("--session-dir") + 1], "session.jsonl");
        return child;
      },
    },
  };
  const fixture = { controller, builder, child, identity, clock, journal, warnings, launches, options, question, bridgeDisposals: () => disposals };
  customize?.(options, fixture);
  const supervisor = await startSupervisor(options);
  function emitProgress(value = "changed"): void {
    builder.emit({ type: "tool_execution_end", toolName: "write", toolCallId: "tool", result: { content: [{ type: "text", text: value }] } });
  }
  t.after(async () => { await supervisor.stop(); await controller.cancelBuild(); await fs.rm(directory, { recursive: true, force: true }); });
  return { ...fixture, supervisor, emitProgress,
    tool: async (toolName, args) => {
      const id = `tool-${++toolId}`;
      child.emit({ type: "tool_execution_start", toolCallId: id, toolName, args });
      assert.ok(bridgeOptions);
      return results.get(id);
    },
    begin: async () => { emitProgress(); await clock.advance(750); assert.equal(child.messages.length, 1); },
  };
}

test("launch forcibly isolates custom agent tools, prompts, resources, settings and persistent session", async (t) => {
  const f = await setup(t);
  const launch = f.launches[0];
  const args = launch.invocation.args;
  for (const flag of ["--no-extensions", "--no-mcp", "--no-builtin-tools", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-approve"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--tools") + 1], SUPERVISOR_TOOLS.join(","));
  assert.equal(args.filter((arg) => arg === "--extension").length, 1);
  assert.equal(args[args.indexOf("--extension") + 1], "/bridge/extension.ts");
  assert.equal(args[args.indexOf("--thinking") + 1], "max");
  assert.equal(launch.env.PI_SESSION_ID, undefined);
  assert.equal(launch.env.PI_USER_QUESTION_BRIDGE_DIR, undefined);
  assert.notEqual(launch.cwd, "/workspace");
  const seed = await fs.readFile(args[args.indexOf("--system-prompt") + 1], "utf8");
  for (const value of Object.values(f.options.context)) assert.ok(seed.includes(value));
  assert.match(seed, /untrusted data/);
  assert.match(seed, /"mode":"steer"/);
  assert.equal(await fs.readFile(args[args.indexOf("--append-system-prompt") + 1], "utf8"), "");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(launch.env.PI_CODING_AGENT_DIR!, "settings.json"), "utf8")), { cacheWarming: "off" });
  assert.equal(f.journal.sessions.length, 1);
  assert.equal(f.journal.sessions[0].role, "supervisor");
  assert.equal(f.journal.sessions[0].sessionFile, f.child.sessionFile);
  assert.equal(f.child.messages.length, 0, "startup is not an LLM poll");
  await f.supervisor.stop();
  assert.equal(f.bridgeDisposals(), 1);
  await assert.rejects(fs.access(launch.cwd));
  await fs.access(path.dirname(f.child.sessionFile));
});

test("oversized mandatory initial context disables visibly before spawn instead of truncating", async (t) => {
  const f = await setup(t, {}, (options) => { options.context.constraints = "界".repeat(SUPERVISION_LIMITS.seedBytes); });
  assert.equal(f.launches.length, 0);
  assert.equal(f.supervisor.status.state, "disabled");
  assert.match(f.warnings[0], /not truncated/);
  assert.equal(f.builder.stops, 0);
});

test("debounces bursts, respects interval, never polls unchanged work, and keeps one persistent child", async (t) => {
  const f = await setup(t, { intervalSeconds: 3 });
  await f.clock.advance(100_000);
  assert.equal(f.child.messages.length, 0);
  f.emitProgress("one");
  await f.clock.advance(500);
  f.emitProgress("two");
  await f.clock.advance(249);
  assert.equal(f.child.messages.length, 0);
  await f.clock.advance(1);
  assert.equal(f.child.messages.length, 1);
  f.child.finish();
  await flush();
  assert.equal(f.supervisor.status.state, "idle");
  f.emitProgress("two");
  await f.clock.advance(10_000);
  assert.equal(f.child.messages.length, 1);
  f.emitProgress("three");
  await f.clock.advance(750);
  f.child.finish();
  await flush();
  f.emitProgress("four");
  await f.clock.advance(2999);
  assert.equal(f.child.messages.length, 2);
  await f.clock.advance(1);
  assert.equal(f.child.messages.length, 3);
  assert.equal(f.launches.length, 1);
  assert.equal(f.journal.sessions.length, 1);
});

test("one-review concurrency coalesces new progress without blocking builder stdout", async (t) => {
  const f = await setup(t);
  await f.begin();
  for (let i = 0; i < 200; i++) f.emitProgress(String(i));
  await f.clock.advance(2000);
  assert.equal(f.child.messages.length, 1);
  assert.match(f.controller.inspectTask(f.identity).tools[0].output.text, /199/);
  f.child.finish();
  await flush();
  await f.clock.advance(750);
  assert.equal(f.child.messages.length, 2);
});

test("structured blockers, retries, repeated failures and completion trigger reviews; thinking does not", async (t) => {
  const f = await setup(t);
  f.builder.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private" } });
  await f.clock.advance(1000);
  assert.equal(f.child.messages.length, 0);
  const cases = [
    { type: "extension_error", error: "blocked" },
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3 },
    { type: "tool_execution_end", toolName: "bash", toolCallId: "failure1", isError: true },
    { type: "tool_execution_end", toolName: "bash", toolCallId: "failure2", isError: true },
    { type: "agent_settled", aborted: false },
  ];
  for (const record of cases) {
    f.builder.emit(record);
    await f.clock.advance(1000);
    f.child.finish();
    await flush();
  }
  assert.equal(f.child.messages.length, 5);
  assert.match(f.child.messages[0], /structured blocker/);
  assert.match(f.child.messages[1], /retry/);
  assert.match(f.child.messages[3], /repeated tool failures/);
  assert.ok(!f.child.messages.join("").includes("private"));
});

test("bounded snapshots use evidence cursors and visibly mark truncation", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 40; i++) f.builder.emit({ type: "tool_execution_end", toolName: "bash", toolCallId: String(i), result: { content: [{ type: "text", text: "界".repeat(8192) }] } });
  await f.clock.advance(750);
  assert.ok(Buffer.byteLength(f.child.messages[0]) <= SUPERVISION_LIMITS.reviewSnapshotBytes);
  assert.match(f.child.messages[0], /truncated/);
  const view = await f.tool("inspect_build", {});
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < SUPERVISION_LIMITS.evidenceResponseBytes);
  assert.ok((view as { afterSequence: number }).afterSequence > 0);
  const task = await f.tool("inspect_task", { taskId: f.identity.taskId, attemptId: f.identity.attemptId });
  assert.ok(Buffer.byteLength(JSON.stringify(task)) < SUPERVISION_LIMITS.evidenceResponseBytes);
  f.child.finish();
  await flush();
  f.emitProgress("next");
  await f.clock.advance(1000);
  assert.match(f.child.messages[1], /afterSequence/);
});

test("guidance uses parent cooldown and intervention limits, never a direct builder transport", async (t) => {
  const f = await setup(t, { cooldownSeconds: 10, maxInterventionsPerTask: 2, maxInterventions: 2 });
  await f.begin();
  // Deliver the first control so the next call reaches the parent's cooldown check.
  const args = { taskId: f.identity.taskId, attemptId: f.identity.attemptId, guidance: "Run tests", reason: "Missing evidence" };
  const first = await f.tool("steer_task", args) as { status: string };
  assert.equal(first.status, "started");
  f.builder.emit({ type: "message_end", message: { role: "user", content: f.builder.messages[0] } });
  await flush();
  const second = await f.tool("steer_task", args) as { status: string; detail: string };
  assert.equal(second.status, "rejected");
  assert.match(second.detail, /cooldown/);
  await f.clock.advance(10_000);
  const third = await f.tool("steer_task", args) as { status: string };
  assert.equal(third.status, "started");
  f.builder.emit({ type: "message_end", message: { role: "user", content: f.builder.messages[1] } });
  await flush();
  const fourth = await f.tool("steer_task", args) as { detail: string };
  assert.match(fourth.detail, /Intervention limit/);
  assert.equal(f.builder.messages.length, 2);
  assert.equal(f.warnings.length, 0, "normal authorization rejection is not supervisor failure");
});

test("review-count budget disables once, stops only supervisor, and never restarts", async (t) => {
  const f = await setup(t, { maxReviews: 1 });
  await f.begin();
  f.child.finish();
  await flush();
  await f.supervisor.stop();
  assert.equal(f.supervisor.status.state, "disabled");
  assert.match(f.warnings[0], /review-count/);
  for (let i = 0; i < 10; i++) f.emitProgress(String(i));
  await f.clock.advance(100_000);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.child.stops, 1);
  assert.equal(f.launches.length, 1);
  assert.equal(f.builder.stops, 0);
});

for (const [name, config, advance] of [
  ["per-review timeout", { reviewTimeoutSeconds: 1 }, 1000],
  ["cumulative active time", { maxActiveSeconds: 1 }, 1000],
] as const) {
  test(`${name} has a deterministic deadline without polling`, async (t) => {
    const f = await setup(t, config);
    await f.begin();
    await f.clock.advance(advance);
    assert.equal(f.supervisor.status.state, "disabled");
    assert.equal(f.supervisor.status.activeMs, 1000);
    await f.supervisor.stop();
    assert.equal(f.clock.timers.size, 0);
    assert.equal(f.builder.stops, 0);
  });
}

test("active-time budget accumulates across reviews but excludes idle intervals", async (t) => {
  const f = await setup(t, { maxActiveSeconds: 2 });
  await f.begin();
  await f.clock.advance(1000);
  f.child.finish();
  await flush();
  await f.clock.advance(50_000);
  assert.equal(f.supervisor.status.activeMs, 1000);
  f.emitProgress("next");
  await f.clock.advance(750);
  await f.clock.advance(1000);
  assert.match(f.warnings[0], /active-time/);
});

test("streaming usage disables immediately and does not double count final/agent_end records", async (t) => {
  const f = await setup(t, { maxTokens: 100 });
  await f.begin();
  const message = { role: "assistant", timestamp: 50, content: [], stopReason: "pending" };
  f.child.emit({ type: "message_start", message });
  f.child.emit({ type: "message_update", usage: { totalTokens: 40 }, assistantMessageEvent: { type: "thinking_delta", delta: "private" } });
  assert.equal(f.supervisor.status.tokens, 40);
  const end = { ...message, stopReason: "error", usage: { totalTokens: 40 } };
  f.child.emit({ type: "message_end", message: end });
  f.child.emit({ type: "agent_end", messages: [end], willRetry: true });
  assert.equal(f.supervisor.status.tokens, 40);
  f.child.emit({ type: "auto_retry_start", attempt: 1 });
  f.child.emit({ type: "message_start", message: { ...message, timestamp: 51 } });
  f.child.emit({ type: "message_update", usage: { totalTokens: 60 }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "retry" } });
  assert.equal(f.supervisor.status.tokens, 100);
  assert.match(f.warnings[0], /token budget/);
});

test("automatic compaction and session-only usage count toward tokens", async (t) => {
  const f = await setup(t, { maxTokens: 100 });
  await f.begin();
  f.child.assistant(30, "error");
  f.child.emit({ type: "compaction_start", reason: "overflow" });
  f.child.emit({ type: "compaction_end", reason: "overflow", result: { usage: { totalTokens: 40 } }, willRetry: true });
  assert.equal(f.supervisor.status.tokens, 70);
  f.child.reportedTokens = 100;
  f.child.finish(10);
  await flush();
  assert.equal(f.supervisor.status.tokens, 100);
  assert.match(f.warnings[0], /token budget/);
});

test("question pauses reasoning accounting while builders continue and checkpoint expires", async (t) => {
  const f = await setup(t, { reviewTimeoutSeconds: 2, maxActiveSeconds: 2, checkpointSeconds: 1 });
  await f.begin();
  await f.clock.advance(500);
  const answer = deferred<QuestionResult>();
  f.question.ask = () => answer.promise;
  const asking = f.tool("request_user_decision", { question: "Which target?", options: ["A", "B"] });
  await flush();
  assert.equal(f.supervisor.status.state, "awaiting-human");
  let completed = false;
  const checkpoint = f.supervisor.checkpoint(f.identity).then(() => { completed = true; });
  f.emitProgress("builder still draining");
  await f.clock.advance(20_000);
  assert.equal(completed, true);
  assert.equal(f.supervisor.status.activeMs, 500);
  assert.equal(f.controller.watchdogState(f.identity).paused, false);
  assert.equal(f.builder.stops, 0);
  answer.resolve({ status: "answered", value: "A" });
  await asking;
  await checkpoint;
  const late = await f.tool("steer_task", { taskId: f.identity.taskId, attemptId: f.identity.attemptId, guidance: "late", reason: "late" }) as { status: string };
  assert.equal(late.status, "rejected");
  assert.equal(f.builder.messages.length, 0);
  await f.clock.advance(1500);
  assert.match(f.warnings[0], /timed out/);
  assert.ok(f.journal.decisions.some((entry) => entry.reason.includes('"value":"A"')));
});

test("human question has a separate finite deadline and only its owner is cancelled", async (t) => {
  const f = await setup(t, { reviewTimeoutSeconds: 1 });
  await f.begin();
  let questionSignal: AbortSignal | undefined;
  f.question.ask = (_question, signal) => { questionSignal = signal; return new Promise(() => {}); };
  const asking = f.tool("request_user_decision", { question: "Missing choice" });
  void asking.catch(() => {});
  await flush();
  await f.clock.advance(SUPERVISION_LIMITS.questionDeadlineMs - 1);
  assert.equal(f.supervisor.status.state, "awaiting-human");
  await f.clock.advance(1);
  await assert.rejects(asking, /stopped/);
  await f.supervisor.stop();
  assert.match(f.warnings[0], /question deadline/);
  assert.equal(questionSignal?.aborted, true);
  assert.equal(f.question.cancelled.length, 1);
  assert.notEqual(f.question.cancelled[0], f.identity.attemptId);
});

test("noninteractive question returns immediately and does not pause builder watchdog", async (t) => {
  const f = await setup(t);
  await f.begin();
  assert.deepEqual(await f.tool("request_user_decision", { question: "Choice?" }), { status: "unavailable" });
  assert.equal(f.supervisor.status.state, "reviewing");
  assert.equal(f.controller.watchdogState(f.identity).paused, false);
});

test("checkpoint expires without starting a review when interval prohibits it", async (t) => {
  const f = await setup(t, { intervalSeconds: 30, checkpointSeconds: 1 });
  await f.begin();
  f.child.finish();
  await flush();
  f.builder.finish();
  const checkpoint = f.supervisor.checkpoint(f.identity);
  await f.clock.advance(1000);
  await checkpoint;
  await f.clock.advance(60_000);
  assert.equal(f.child.messages.length, 1);
  assert.equal(f.warnings.length, 0);
});

test("abort expires checkpoint synchronously and normal completed review releases it early", async (t) => {
  const f = await setup(t);
  let finished = false;
  const checkpoint = f.supervisor.checkpoint(f.identity).then(() => { finished = true; });
  await f.clock.advance(750);
  f.child.finish();
  await checkpoint;
  assert.equal(finished, true);
  f.emitProgress("later");
  const abort = new AbortController();
  const second = f.supervisor.checkpoint(f.identity, abort.signal);
  abort.abort();
  await second;
  await f.clock.advance(2000);
  assert.equal(f.child.messages.length, 1);
});

for (const failure of ["unexpected exit", "unauthorized tool", "malformed control", "journal failure", "handled prompt", "length", "missing ending"] as const) {
  test(`${failure} degrades once, joins resources and leaves builder running`, async (t) => {
    const f = await setup(t);
    if (failure === "handled prompt") f.child.promptHook = async () => ({ disposition: "handled", response: response("prompt"), settled: Promise.resolve(null) });
    await f.begin();
    switch (failure) {
      case "unexpected exit": f.child.close.resolve({ ...closeResult(), code: 1, error: new Error("crashed") }); break;
      case "unauthorized tool": f.child.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "malicious", args: {} }); break;
      case "malformed control": await assert.rejects(f.tool("inspect_build", { runId: "another-build" })); break;
      case "journal failure": f.journal.decisionHook = async () => { throw new Error("disk failed"); }; f.child.finish(); break;
      case "length": f.child.finish(0, "length"); break;
      case "missing ending": f.child.completion!.resolve({ generation: 1, observedAt: 0, aborted: false }); break;
    }
    await flush();
    await f.supervisor.stop();
    assert.equal(f.warnings.length, 1);
    assert.equal(f.supervisor.status.state, "disabled");
    assert.equal(f.child.stops, 1);
    assert.equal(f.bridgeDisposals(), 1);
    assert.equal(f.builder.stops, 0);
    assert.equal(f.clock.timers.size, 0);
    assert.equal(f.child.listeners.size, 0);
  });
}

test("journal admission failure disables before another review; stop waits for child join", async (t) => {
  const f = await setup(t);
  const joined = deferred<RpcCloseResult>();
  f.child.stopHook = () => joined.promise;
  f.journal.status.canAcceptControls = false;
  f.emitProgress();
  assert.equal(f.supervisor.status.state, "disabled");
  let done = false;
  const stopping = f.supervisor.stop().then(() => { done = true; });
  await flush();
  assert.equal(done, false);
  assert.equal(f.bridgeDisposals(), 0);
  joined.resolve(closeResult());
  await stopping;
  assert.equal(f.bridgeDisposals(), 1);
  assert.equal(f.warnings.length, 1);
});

test("duplicate observations and stale run events do not create LLM reviews", async (t) => {
  const f = await setup(t);
  let observation!: BuildObservation;
  const unsubscribe = f.controller.onObservation((value) => { observation = value; });
  await f.begin();
  f.child.finish();
  await flush();
  for (let i = 0; i < 20; i++) f.supervisor.notify(observation);
  f.supervisor.notify({ ...observation, runId: "other", sequence: 10000 });
  await f.clock.advance(10000);
  assert.equal(f.child.messages.length, 1);
  unsubscribe();
});

test("supervisor agent definition has exactly the bridge tools and extensions disabled", async () => {
  const definition = await fs.readFile(new URL("../.pi/agent/agents/supervisor.md", import.meta.url), "utf8");
  assert.match(definition, /^includeExtensions: false$/m);
  const tools = definition.match(/^tools: (.+)$/m)![1].split(",");
  assert.deepEqual(tools, [...SUPERVISOR_TOOLS]);
  assert.match(definition, /untrusted data/);
  assert.match(definition, /parent owns all safety decisions/);
});

test("off mode creates no session, bridge, subprocess, timer, or model review", async (t) => {
  const f = await setup(t, { supervisionMode: "off" });
  f.emitProgress();
  await f.supervisor.checkpoint(f.identity);
  await f.clock.advance(10000);
  assert.equal(f.launches.length, 0);
  assert.equal(f.journal.sessions.length, 0);
  assert.equal(f.child.messages.length, 0);
  assert.equal(f.clock.timers.size, 0);
});

test("advisory proposals pass through the same parent limits without delivery", async (t) => {
  const f = await setup(t, { supervisionMode: "advisory", maxInterventions: 1 });
  await f.begin();
  const args = { taskId: f.identity.taskId, attemptId: f.identity.attemptId, guidance: "Consider another test", reason: "Coverage gap" };
  const first = await f.tool("steer_task", args) as { status: string };
  const second = await f.tool("steer_task", args) as { status: string; detail: string };
  assert.equal(first.status, "proposed");
  assert.equal(second.status, "rejected");
  assert.match(second.detail, /Intervention limit/);
  assert.equal(f.builder.messages.length, 0);
  assert.ok(f.journal.decisions.some((entry) => entry.reason.includes("advisory proposal")));
  assert.equal(f.warnings.length, 0);
});

test("parent cooldown is per task, not a global supervisor pause", async (t) => {
  const f = await setup(t, { supervisionMode: "advisory", cooldownSeconds: 60 });
  await f.begin();
  const other = await f.controller.registerAttempt({ taskId: "T06", attemptNumber: 1, transport: new Transport(),
    workspace: { rootPath: "/other", vcs: "jj", baseRevision: "a".repeat(40), protectedPaths: [] } });
  for (const identity of [f.identity, other]) {
    const result = await f.tool("steer_task", { taskId: identity.taskId, attemptId: identity.attemptId, guidance: "Check tests", reason: "Missing tests" }) as { status: string };
    assert.equal(result.status, "proposed");
  }
});

test("in-flight and repeated checkpoints reuse unchanged reviews despite transport sequence churn", async (t) => {
  const f = await setup(t);
  await f.begin();
  f.builder.emit({ type: "transport_only" });
  const checkpoint = f.supervisor.checkpoint(f.identity);
  f.child.finish();
  await checkpoint;
  f.builder.emit({ type: "transport_only" });
  await f.supervisor.checkpoint(f.identity);
  await f.clock.advance(10000);
  assert.equal(f.child.messages.length, 1);
  assert.equal(f.clock.timers.size, 0);
});

test("pending review for a cancelled task is discarded before an LLM call", async (t) => {
  const f = await setup(t);
  f.emitProgress();
  await f.controller.cancelTask(f.identity);
  await f.clock.advance(10000);
  assert.equal(f.child.messages.length, 0);
});

test("session-only usage remains charged when a later review streams usage", async (t) => {
  const f = await setup(t, { maxTokens: 100 });
  await f.begin();
  f.child.reportedTokens = 80;
  f.child.finish(10);
  await flush();
  assert.equal(f.supervisor.status.tokens, 80);
  f.emitProgress("more");
  await f.clock.advance(1000);
  f.child.emit({ type: "message_start", message: { role: "assistant", timestamp: 50, content: [] } });
  f.child.emit({ type: "message_update", usage: { totalTokens: 20 }, assistantMessageEvent: { type: "thinking_delta", delta: "working" } });
  assert.equal(f.supervisor.status.tokens, 100);
  assert.equal(f.supervisor.status.state, "disabled");
});

test("retry agent_end is not completion; settlement requires a fresh authoritative ending", async (t) => {
  const f = await setup(t);
  await f.begin();
  f.child.assistant(10, "error");
  f.child.emit({ type: "agent_end", willRetry: true, messages: [] });
  f.child.emit({ type: "auto_retry_start", attempt: 1 });
  await flush();
  assert.equal(f.supervisor.status.state, "reviewing");
  f.child.emit({ type: "agent_start" });
  f.child.emit({ type: "auto_retry_end", success: true });
  f.child.finish(10);
  await flush();
  assert.equal(f.supervisor.status.state, "idle");
  assert.equal(f.supervisor.status.tokens, 20);
  f.emitProgress("more");
  await f.clock.advance(1000);
  f.child.completion!.resolve({ generation: 2, observedAt: 0, aborted: false });
  await flush();
  assert.equal(f.supervisor.status.state, "disabled", "previous review's stop is not a fresh ending");
});

test("fast settlement before prompt receipt is observed", async (t) => {
  const f = await setup(t);
  f.child.promptHook = async () => {
    f.child.finish();
    return { disposition: "started", response: response("prompt"), settled: Promise.resolve({ generation: 1, observedAt: f.clock.now(), aborted: false }) };
  };
  await f.begin();
  await flush();
  assert.equal(f.supervisor.status.state, "idle");
  assert.ok(f.journal.decisions.some((entry) => entry.reason.includes("decision:")));
});

test("stale attempt observation is ignored and stale control cannot reach a builder", async (t) => {
  const f = await setup(t);
  let previous!: BuildObservation;
  const unsubscribe = f.controller.onObservation((observation) => { previous = observation; });
  await f.begin();
  const stale = previous;
  await f.controller.cancelTask(f.identity);
  const replacement = new Transport();
  await f.controller.registerAttempt({ taskId: f.identity.taskId, attemptNumber: 2, transport: replacement,
    workspace: { rootPath: "/workspace", vcs: "jj", baseRevision: "a".repeat(40), protectedPaths: [] } });
  f.supervisor.notify(stale);
  assert.equal(f.warnings.length, 0);
  await assert.rejects(f.tool("steer_task", { taskId: f.identity.taskId, attemptId: f.identity.attemptId, guidance: "Late", reason: "Old evidence" }), /stale/);
  assert.equal(replacement.messages.length, 0);
  assert.equal(replacement.stops, 0);
  unsubscribe();
});

test("parent abort joins the supervisor without cancelling unrelated builder work", async (t) => {
  const abort = new AbortController();
  const f = await setup(t, {}, (options) => { options.signal = abort.signal; });
  await f.begin();
  abort.abort();
  await f.supervisor.stop();
  assert.equal(f.supervisor.status.state, "stopped");
  assert.equal(f.warnings.length, 0);
  assert.equal(f.builder.stops, 0);
  assert.equal(f.bridgeDisposals(), 1);
});

test("abort during bridge startup joins the newly-created resource without spawning", async (t) => {
  const abort = new AbortController();
  const f = await setup(t, {}, (options) => {
    options.signal = abort.signal;
    const create = options.dependencies.createBridge!;
    options.dependencies.createBridge = async (input) => { const bridge = await create(input); abort.abort(); return bridge; };
  });
  assert.equal(f.supervisor.status.state, "stopped");
  assert.equal(f.launches.length, 0);
  assert.equal(f.warnings.length, 0);
  assert.equal(f.bridgeDisposals(), 1);
});

test("startup journal timeout visibly degrades and joins the subprocess", async (t) => {
  const f = await setup(t, { reviewTimeoutSeconds: 1 }, (_options, fixture) => {
    fixture.journal.sessionHook = async () => {
      queueMicrotask(() => { void fixture.clock.advance(1000); });
      return new Promise(() => {});
    };
  });
  assert.equal(f.supervisor.status.state, "disabled");
  assert.match(f.warnings[0], /startup timed out/);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.child.stops, 1);
  assert.equal(f.bridgeDisposals(), 1);
  assert.equal(f.clock.timers.size, 0);
});

test("unscheduled runs and bridge tool errors fail closed", async (t) => {
  const f = await setup(t);
  f.child.emit({ type: "agent_start" });
  assert.match(f.warnings[0], /Unscheduled/);
  await f.supervisor.stop();
  const other = await setup(t);
  await other.begin();
  other.child.emit({ type: "tool_execution_end", toolName: "inspect_build", toolCallId: "tool", isError: true });
  assert.match(other.warnings[0], /bridge tool failed/);
});

test("settlement while a question is outstanding degrades rather than releasing a second review", async (t) => {
  const f = await setup(t);
  await f.begin();
  f.question.ask = () => new Promise(() => {});
  const asking = f.tool("request_user_decision", { question: "Choose a target" });
  void asking.catch(() => {});
  await flush();
  f.emitProgress("more");
  f.child.finish();
  await assert.rejects(asking, /stopped/);
  await f.supervisor.stop();
  assert.match(f.warnings[0], /settled while awaiting/);
  assert.equal(f.child.messages.length, 1);
});

test("review joins response publishing before checkpoint completion", async (t) => {
  const published = deferred<void>();
  const f = await setup(t, {}, (options) => {
    const create = options.dependencies.createBridge!;
    options.dependencies.createBridge = async (input) => {
      const bridge = await create(input);
      const handle = bridge.handleToolStart;
      bridge.handleToolStart = async (record) => { await handle(record); await published.promise; return true; };
      return bridge;
    };
  });
  await f.begin();
  await f.tool("inspect_build", {});
  let completed = false;
  const checkpoint = f.supervisor.checkpoint(f.identity).then(() => { completed = true; });
  f.child.finish();
  await flush();
  assert.equal(completed, false);
  assert.equal(f.supervisor.status.state, "reviewing");
  published.resolve();
  await checkpoint;
  assert.equal(completed, true);
});
