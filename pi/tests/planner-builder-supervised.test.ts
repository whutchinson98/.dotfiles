import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getEventListeners } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BuildController, type BuildControllerOptions } from "../.pi/agent/extensions/planner-builder/build-controller.ts";
import { runBuilder, type BuilderResult } from "../.pi/agent/extensions/planner-builder/builder-runner.ts";
import type { AttemptIdentity } from "../.pi/agent/extensions/planner-builder/build-state.ts";
import { createQuestionQueue, type QuestionQueueOptions } from "../.pi/agent/extensions/planner-builder/question-queue.ts";
import { RpcAgent, type RpcAgentOptions, type RpcClock, type RpcRecord } from "../.pi/agent/extensions/planner-builder/rpc-agent.ts";
import { RunJournal } from "../.pi/agent/extensions/planner-builder/run-journal.ts";
import { startSupervisor, type SupervisorOptions } from "../.pi/agent/extensions/planner-builder/supervisor.ts";
import { GitBackend, type TaskWorkspace } from "../.pi/agent/extensions/planner-builder/vcs.ts";
import { fixture, git } from "./planner-builder-fixtures.ts";
import { loadPlannerBuilder } from "./planner-builder-harness.ts";

const childPath = fileURLToPath(new URL("./fixtures/planner-builder-rpc-child.mjs", import.meta.url));
const timeout = 30_000;

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(5);
  }
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function guidance(identity: AttemptIdentity, controlId = "guidance") {
  return { ...identity, controlId, origin: "supervisor" as const, guidance: "Preserve the single task commit.", reason: "Fixture checkpoint" };
}

interface OwnedChild {
  rpc: RpcAgent;
  process: ChildProcessWithoutNullStreams;
  records: RpcRecord[];
  options: RpcAgentOptions;
  joined: boolean;
}

/** Only the executable/environment seam is changed. Both roles use RpcAgent's
 * actual pipes, framing, backpressure, timers, process groups and shutdown. */
async function runtime(parent: string, script: Record<string, unknown>) {
  const scriptPath = path.join(parent, "script.json");
  const audit = path.join(parent, "audit.jsonl");
  await fs.writeFile(scriptPath, JSON.stringify({ root: parent, vcs: "git", audit, ...script }));
  const credentials = path.join(parent, "empty-agent");
  await fs.mkdir(credentials);
  const env = { PATH: process.env.PATH, HOME: parent, PI_CODING_AGENT_DIR: credentials,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const children: OwnedChild[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const clock: RpcClock = {
    now: Date.now,
    setTimeout(callback, ms) {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { clearTimeout(timer as ReturnType<typeof setTimeout>); timers.delete(timer as ReturnType<typeof setTimeout>); },
  };
  function getInvocation(args: string[]) { return { command: process.execPath, args: [childPath, "supervised", scriptPath, ...args] }; }
  function createTransport(options: RpcAgentOptions): RpcAgent {
    let process!: ChildProcessWithoutNullStreams;
    const rpc = new RpcAgent({ ...options,
      invocation: getInvocation(options.invocation.args.slice(options.invocation.args.indexOf("--mode"))),
      env: { ...env, PI_SUBAGENT_NAME: options.env.PI_SUBAGENT_NAME },
      shutdown: { commandMs: 150, gracefulMs: 150, termMs: 100, killMs: 1000 },
      dependencies: { clock, spawn(command, args, options) { process = spawn(command, args, options); return process; } },
    });
    const child: OwnedChild = { rpc, process, records: [], options, joined: false };
    rpc.onRecord((record) => { child.records.push(record); });
    void rpc.closed.then(() => { child.joined = true; });
    children.push(child);
    return rpc;
  }
  async function assertClean(): Promise<void> {
    for (const child of children) {
      assert.equal(child.joined, true, "owned RPC child must join before returning");
      assert.ok(child.process.exitCode !== null || child.process.signalCode !== null);
      assert.equal(child.process.listenerCount("exit"), 0);
      assert.equal(child.process.listenerCount("close"), 0);
      assert.equal(child.process.stdout.listenerCount("data"), 0);
      assert.equal(child.process.stderr.listenerCount("data"), 0);
      assert.equal(child.process.stdin.listenerCount("drain"), 0);
      for (const key of ["pendingRequests", "completionWaiters", "queuedWrites", "queuedWriteBytes", "pendingUi"] as const) assert.equal(child.rpc.state[key], 0, key);
      assert.equal(child.rpc.state.accepting, false);
    }
    assert.equal(timers.size, 0, "all owned clock timers cleared");
  }
  return { env, children, clock, getInvocation, createTransport, assertClean, audit };
}

async function builderFixture(t: TestContext, script: Record<string, unknown> = {}, options: {
  mode?: "steer" | "advisory";
  supervisionOptions?: Record<string, number>;
  controlTimeoutMs?: number;
  question?: QuestionQueueOptions["show"];
} = {}) {
  const f = await fixture(t);
  const rt = await runtime(f.parent, { mode: "manual", ...script });
  const journal = await RunJournal.open({ runId: "fixture-run", runDirectory: path.join(f.parent, "run"), sourceRoots: [f.root], protectedPaths: [f.plan] });
  const questions = createQuestionQueue({ interactive: () => !!options.question, show: options.question ?? (async () => undefined) });
  const controller = new BuildController({ runId: journal.runId, journal, questions, clock: rt.clock,
    supervision: { supervisionMode: options.mode ?? "steer", supervisionOptions: { cooldownSeconds: 0, checkpointSeconds: 0, ...options.supervisionOptions } },
    controlTimeoutMs: options.controlTimeoutMs ?? 5000, sealTimeoutMs: 10_000 });
  const abort = new AbortController();
  const temporary: string[] = [];
  let completed = false;
  let validationBegins = 0;
  controller.onObservation((observation) => {
    if (observation.payload.kind !== "phase" || observation.payload.phase !== "integrating") return;
    validationBegins++;
    assert.equal(rt.children.at(-1)?.joined, true, "readiness cannot precede process join");
    const snapshot = controller.inspectTask(observation);
    assert.equal(snapshot.admissionOpen, false);
    assert.ok(snapshot.controlOutcomes.every((control) => ["delivered", "proposed", "rejected"].includes(control.status)));
    assert.equal(snapshot.queues.steering + snapshot.queues.followUp, 0);
  });
  const work = runBuilder({
    workspace: { rootPath: f.root, cwd: f.root, baseRevision: await git(f.root, "rev-parse", "HEAD"), name: "fixture", taskId: "T01" } as TaskWorkspace,
    vcs: "git", sourceRoot: f.root, protectedPaths: ["plan.md"], taskId: "T01", task: "Assigned task: T01 - scripted task",
    agent: { name: "builder", source: "user", systemPrompt: "Fixture-only builder" },
    monitor: { enabled: false, intervalSeconds: 1, stuckTimeoutSeconds: 1, maxRestarts: 0 },
    controller, questions, runDirectory: journal.runDirectory, signal: abort.signal,
    dependencies: {
      clock: rt.clock, getInvocation: rt.getInvocation, createTransport: rt.createTransport,
      async writeSystemPrompt(_name, prompt) {
        const dir = await fs.mkdtemp(path.join(f.parent, "prompt-"));
        temporary.push(dir);
        const filePath = path.join(dir, "system.md");
        await fs.writeFile(filePath, prompt);
        return { dir, filePath };
      },
      writeMaxEffortExtension: async () => { throw new Error("Unexpected max-effort extension"); },
      createQuestionBridge: async () => { throw new Error("RPC UI does not need a tool bridge"); },
      parseQuestion: () => { throw new Error("Unexpected tool question"); },
      writeQuestionResponse: async () => { throw new Error("Unexpected tool response"); },
    },
  }).then((result) => { completed = true; return result; });
  t.after(async () => { abort.abort(); await controller.cancelBuild(); await work; await questions.close(); await journal.close(); });
  await waitFor(() => rt.children.length > 0 && rt.children[0].records.some((record) => record.type === "agent_start"), "builder prompt");
  const child = rt.children[0];
  const identity = controller.inspectBuild().tasks[0];
  async function command(action: string): Promise<void> { await child.rpc.request("fixture", { action }); }
  function pending(): void {
    assert.equal(completed, false, "builder result cannot escape the integration barrier");
    assert.equal(validationBegins, 0, "validation cannot start while controls/work/process remain active");
    assert.equal(controller.inspectTask(identity).readyForIntegration, false);
  }
  async function finish(): Promise<BuilderResult> {
    const result = await work;
    await questions.close();
    await journal.close();
    await rt.assertClean();
    assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    for (const dir of temporary) await assert.rejects(fs.stat(dir), { code: "ENOENT" });
    return result;
  }
  return { ...f, rt, journal, questions, controller, abort, work, child, identity, command, pending, finish, get validationBegins() { return validationBegins; } };
}

for (const idle of [false, true]) {
  test(`${idle ? "idle-race" : "running-turn"} guidance uses real RPC; queued acceptance is not delivery and sealing joins the child`, { timeout }, async (t) => {
    const f = await builderFixture(t);
    if (idle) {
      // Settlement and guidance compete in the same stdout callback, before the
      // runner's receipt waiter can close admission.
      let control!: Promise<unknown>;
      const unsubscribe = f.child.rpc.onRecord((record) => {
        if (record.type === "agent_settled" && !control) control = f.controller.requestGuidance(guidance(f.identity));
      });
      await f.command("finish");
      await control;
      unsubscribe();
    } else await f.controller.requestGuidance(guidance(f.identity));
    const accepted = f.controller.inspectTask(f.identity).controlOutcomes[0];
    assert.equal(accepted.status, idle ? "started" : "queued");
    assert.equal(accepted.disposition, idle ? "started" : "queued");
    const wire = f.child.records.filter((record) => record.type === "fixture_command").map((record) => record.command as RpcRecord);
    assert.equal(wire.at(-1)?.streamingBehavior, "steer");
    assert.equal(wire.some((command) => command.type === "steer"), false);
    f.pending();
    await f.command("deliver");
    await waitFor(() => f.controller.inspectTask(f.identity).controlOutcomes[0].status === "delivered", "delivery evidence");
    f.pending(); // Delivered is not settled, and the process is still owned.
    await f.command("finish");
    assert.equal((await f.finish()).exitCode, 0);
    assert.equal(f.validationBegins, 1);
    const rows = (await fs.readFile(f.journal.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const statuses = rows.filter((row) => row.kind === "control").map((row) => row.status);
    assert.deepEqual(statuses, ["accepted", idle ? "started" : "queued", "delivered"]);
  });
}

test("settling during an in-flight receipt closes admission but drains accepted guidance, rejecting late supervisor controls", { timeout }, async (t) => {
  const f = await builderFixture(t, { holdReceipt: true });
  const control = f.controller.requestGuidance(guidance(f.identity));
  await waitFor(() => f.child.records.some((record) => record.type === "queue_update"), "guidance write");
  await f.command("finish");
  await waitFor(() => !f.controller.inspectTask(f.identity).admissionOpen, "admission closure");
  f.pending();
  assert.equal((await f.controller.requestGuidance(guidance(f.identity, "late"))).status, "rejected");
  await f.command("receipt");
  assert.equal((await control).status, "queued");
  f.pending();
  await f.command("deliver");
  f.pending();
  await f.command("finish");
  assert.equal((await f.finish()).exitCode, 0);
});

test("ambiguous guidance delivery fails and retains work rather than granting integration readiness", { timeout }, async (t) => {
  const f = await builderFixture(t, {}, { controlTimeoutMs: 250 });
  assert.equal((await f.controller.requestGuidance(guidance(f.identity))).status, "queued");
  await f.command("finish");
  f.pending();
  const result = await f.finish();
  assert.equal(result.exitCode, 1);
  assert.match(result.errorMessage!, /delivery.*timed out/i);
  assert.equal(f.controller.inspectTask(f.identity).controlOutcomes[0].status, "delivery-unknown");
  assert.equal(f.validationBegins, 0);
  assert.ok(await fs.stat(f.root));
});

test("advisory proposals and exhausted intervention budgets never write builder guidance", { timeout }, async (t) => {
  const f = await builderFixture(t, {}, { mode: "advisory", supervisionOptions: { maxInterventionsPerTask: 1 } });
  assert.equal((await f.controller.requestGuidance(guidance(f.identity))).status, "proposed");
  assert.match((await f.controller.requestGuidance(guidance(f.identity, "over-budget"))).detail!, /limit/);
  assert.equal(f.child.records.filter((record) => record.type === "fixture_command" && (record.command as RpcRecord).type === "prompt").length, 1);
  await f.command("finish");
  assert.equal((await f.finish()).exitCode, 0);
});

test("text-only deltas, out-of-order responses, retry and compaction cannot masquerade as final settlement", { timeout }, async (t) => {
  const f = await builderFixture(t);
  await f.command("deltas");
  const snapshot = f.controller.inspectTask(f.identity);
  assert.equal(snapshot.assistantText.text, "Visible 雪\u2028text");
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_THINKING|PRIVATE_ARGUMENT/);
  const first = f.child.rpc.request("reorder");
  const second = f.child.rpc.request("reorder");
  assert.deepEqual((await second).data, { order: 2 });
  assert.deepEqual((await first).data, { order: 1 });
  await f.command("retry");
  assert.equal(f.controller.inspectTask(f.identity).retries.active, true);
  assert.equal(f.controller.inspectTask(f.identity).compaction.active, true);
  f.pending();
  await f.command("recovered");
  f.pending();
  await f.command("finish");
  assert.equal((await f.finish()).exitCode, 0);
});

test("stale attempt controls after replacement never reach a restarted real child", { timeout }, async (t) => {
  const f = await builderFixture(t);
  f.abort.abort();
  assert.equal((await f.work).exitCode, 1);
  const replacement = f.rt.createTransport(f.child.options);
  const identity = await f.controller.registerAttempt({ taskId: "T01", attemptNumber: 2, transport: replacement,
    workspace: { rootPath: f.root, baseRevision: await git(f.root, "rev-parse", "HEAD"), vcs: "git", protectedPaths: ["plan.md"] } });
  assert.notEqual(identity.attemptId, f.identity.attemptId);
  await assert.rejects(f.controller.requestGuidance(guidance(f.identity)), /stale/);
  await replacement.request("get_state");
  assert.equal(f.rt.children[1].records.some((record) => record.type === "fixture_command" && (record.command as RpcRecord).type === "prompt"), false);
  await f.controller.cancelTask(identity);
  await f.finish();
});

test("unexpected subprocess exit fails the task without beginning commit validation", { timeout }, async (t) => {
  const f = await builderFixture(t);
  await assert.rejects(f.command("exit"), /unexpectedly/);
  const result = await f.finish();
  assert.equal(result.exitCode, 1);
  assert.match(result.errorMessage!, /unexpectedly/);
  assert.equal(f.validationBegins, 0);
});

test("a parent-mediated question pauses only its builder watchdog while stdout still drains", { timeout }, async (t) => {
  const answer = deferred<string>();
  let shown = false;
  const f = await builderFixture(t, { mode: "question" }, { question: async () => { shown = true; return answer.promise; } });
  await waitFor(() => shown, "question UI");
  assert.equal(f.controller.watchdogState(f.identity).paused, true);
  await f.command("deltas");
  assert.match(f.controller.inspectTask(f.identity).assistantText.text, /Visible/);
  f.pending();
  answer.resolve("fixture answer");
  assert.equal((await f.finish()).exitCode, 0);
  assert.equal(f.controller.watchdogState(f.identity).paused, false);
  const reply = f.child.records.find((record) => record.type === "fixture_ui_reply")?.reply as RpcRecord;
  assert.equal(reply.value, "fixture answer");
});

test("cancellation during real stdin backpressure drops unsent guidance and joins the process tree", { timeout, skip: process.platform !== "linux" }, async (t) => {
  const f = await builderFixture(t);
  await f.command("descendant");
  const pid = f.child.records.find((record) => record.type === "descendant")!.pid as number;
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ } });
  await f.command("pause");
  const writes = Array.from({ length: 3 }, () => f.child.rpc.request("padding", { text: "x".repeat(400_000) }).catch((error) => error));
  assert.ok(f.child.rpc.state.queuedWrites > 0, "OS pipe backpressure must actually occur");
  const control = f.controller.requestGuidance(guidance(f.identity));
  f.pending();
  await f.controller.cancelTask(f.identity);
  await Promise.all(writes);
  assert.equal((await control).status, "cancelled");
  assert.equal((await f.finish()).exitCode, 1);
  assert.equal(f.validationBegins, 0);
  const closed = await f.child.rpc.closed;
  assert.ok(closed.signals.includes("SIGKILL"));
  const commands = f.child.records.filter((record) => record.type === "fixture_command").map((record) => (record.command as RpcRecord).type);
  assert.equal(commands.filter((command) => command === "prompt").length, 1, "cancelled guidance was never consumed");
  // Orphan reaping and SIGKILL observation can lag pipe close under parallel load.
  let stat = "";
  for (let attempt = 0; attempt < 100; attempt++) {
    stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    if (!stat || stat.split(") ")[1].startsWith("Z")) break;
    await delay(10);
  }
  assert.ok(!stat || stat.split(") ")[1].startsWith("Z"), stat);
});

function plan(tasks: Array<{ id: string; file: string; depends?: string }>): string {
  return tasks.map(({ id, file, depends }) => `### Task ${id}: Implement ${file}\nStatus: pending\nDepends on: ${depends ?? "none"}\nFiles:\n- ${file}\nInstructions:\n- Write only ${file}.\nVerification:\n- Inspect the local file.\n`).join("\n");
}

async function schedulerFixture(t: TestContext, script: Record<string, unknown>) {
  const f = await fixture(t);
  const rt = await runtime(f.parent, script);
  let controller!: BuildController;
  let supervisorOptions!: SupervisorOptions;
  let validations = 0;
  const api = loadPlannerBuilder(path.join(f.parent, "tasks"), {
    discoverAgents: () => ({ agents: ["builder", "supervisor"].map((name) => ({ name, source: "user", systemPrompt: "", tools: [] })) }),
    BuildController: class extends BuildController {
      constructor(options: BuildControllerOptions) { super({ ...options, clock: rt.clock }); controller = this; }
    },
    async startSupervisor(options: SupervisorOptions) {
      supervisorOptions = options;
      return startSupervisor({ ...options, dependencies: { env: rt.env, clock: rt.clock, getInvocation: rt.getInvocation, createTransport: rt.createTransport } });
    },
    GitBackend: { async start(...args: Parameters<typeof GitBackend.start>) {
      const backend = await GitBackend.start(...args);
      const validate = backend.validate.bind(backend);
      backend.validate = async (workspace) => {
        validations++;
        const identity = controller.inspectBuild().tasks.find((task) => task.workspacePath === workspace.rootPath)!;
        const snapshot = controller.inspectTask(identity);
        assert.equal(snapshot.readyForIntegration, true);
        assert.equal(snapshot.admissionOpen, false);
        const builder = rt.children.find((child) => child.options.cwd === workspace.cwd)!;
        assert.equal(builder.joined, true, "real VCS validation cannot run before process cleanup");
        assert.ok(snapshot.controlOutcomes.every((control) => ["delivered", "proposed", "rejected"].includes(control.status)));
        return validate(workspace);
      };
      return backend;
    } },
    // One-shot agents remain production code. Any accidental verifier launch is
    // rejected at spawn, not hidden by replacing runAgent().
    spawn(command: string, args: string[], options: any) {
      assert.equal(command, "jj", "no one-shot Pi/model subprocess may launch");
      return spawn(command, args, options);
    },
  });
  api.setBuilderTransport(rt.createTransport);
  t.after(async () => { await controller?.cancelBuild(); await Promise.all(rt.children.map((child) => child.rpc.stop())); });
  async function build(mode = "steer", supervisionOptions: Record<string, number> = {}) {
    return api.buildPlanFile({ cwd: f.root, hasUI: false }, { path: f.plan, model: "fixture", effort: "off", builderMonitor: false,
      maxConcurrency: 2, supervisionMode: mode, supervisionOptions: { intervalSeconds: 1, cooldownSeconds: 0, checkpointSeconds: 3, ...supervisionOptions } });
  }
  async function retained(result: any): Promise<void> {
    await rt.assertClean();
    const journal = (await fs.readFile(result.details.supervision.journalPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const mappings = journal.filter((row) => row.kind === "session");
    assert.ok(mappings.some((mapping) => mapping.role === "supervisor"));
    for (const mapping of mappings) {
      assert.ok(mapping.sessionFile.startsWith(result.details.supervision.runDirectory));
      assert.match(await fs.readFile(mapping.sessionFile, "utf8"), new RegExp(mapping.sessionId));
    }
    for (const child of rt.children) {
      if (child.options.env.PI_SUBAGENT_NAME !== "supervisor") continue;
      const args = child.options.invocation.args;
      const bridge = path.dirname(args[args.indexOf("--extension") + 1]);
      await assert.rejects(fs.stat(bridge), { code: "ENOENT" });
      await assert.rejects(fs.stat(child.options.cwd), { code: "ENOENT" });
    }
    assert.equal(supervisorOptions.controller, controller);
  }
  return { ...f, rt, api, build, retained, get controller() { return controller; }, get validations() { return validations; } };
}

test("supervised Git dependency waves preserve one nonempty commit each; sessions outlive deleted worktrees and verifier stays off", { timeout }, async (t) => {
  const f = await schedulerFixture(t, { mode: "auto", supervisor: { action: "steer" }, jobs: {
    T01: { files: { "one.txt": "one\n" } }, T02: { files: { "two.txt": "two\n" } },
    T03: { requires: ["one.txt", "two.txt"], files: { "three.txt": "three\n" } },
  } });
  await fs.writeFile(f.plan, plan([{ id: "T01", file: "one.txt" }, { id: "T02", file: "two.txt" }, { id: "T03", file: "three.txt", depends: "T01, T02" }]));
  const base = await git(f.root, "rev-parse", "HEAD");
  const result = await f.build();
  assert.match(result.text, /3 done, 0 failed, 0 blocked/);
  assert.equal(f.validations, 3);
  const history = (await git(f.root, "log", "--reverse", "--format=%H %s", `${base}..HEAD`)).split("\n");
  assert.equal(history.length, 3);
  assert.match(history[2], / T03$/);
  for (const line of history) {
    const [commit, task] = line.split(" ");
    const expected = { T01: "one.txt", T02: "two.txt", T03: "three.txt" }[task];
    assert.equal(await git(f.root, "diff-tree", "--no-commit-id", "--name-only", "-r", commit), expected);
  }
  for (const child of f.rt.children.filter((child) => child.options.env.PI_SUBAGENT_NAME === "builder")) await assert.rejects(fs.stat(child.options.cwd), { code: "ENOENT" });
  assert.equal(f.rt.children.filter((child) => child.options.env.PI_SUBAGENT_NAME === "supervisor").length, 1);
  assert.equal(result.details.supervision.disableReason, undefined);
  assert.ok(result.details.supervision.attempts.every((attempt: any) => attempt.controls.some((control: any) => control.status === "delivered")));
  await f.retained(result);
});

test("supervised Git retains failed and protected plan/report commits instead of integrating them", { timeout }, async (t) => {
  const f = await schedulerFixture(t, { mode: "auto", supervisor: { action: "none" }, jobs: {
    T01: { result: "failed", files: { "failed.txt": "retained\n" } },
    T02: { files: { "plan.md": "forbidden status rewrite\n" } },
    T03: { files: { ".pi/outputs/findings.html": "forbidden report\n" } },
  } });
  await fs.writeFile(f.plan, plan([{ id: "T01", file: "failed.txt" }, { id: "T02", file: "plan.md" }, { id: "T03", file: ".pi/outputs/findings.html" }]));
  const base = await git(f.root, "rev-parse", "HEAD");
  const result = await f.build();
  assert.match(result.text, /0 done, 3 failed/);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), base);
  assert.equal(f.validations, 2, "failed task markers never reach commit validation");
  for (const child of f.rt.children.filter((child) => child.options.env.PI_SUBAGENT_NAME === "builder")) assert.ok(await fs.stat(child.options.cwd));
  assert.match(await fs.readFile(f.plan, "utf8"), /runner-owned|plan\/report|protected/i);
  await assert.rejects(fs.stat(path.join(f.root, ".pi/outputs/findings.html")), { code: "ENOENT" });
  await f.retained(result);
});

test("real supervisor token exhaustion disables supervision visibly while deterministic builders still finish", { timeout }, async (t) => {
  const f = await schedulerFixture(t, { mode: "auto", supervisor: { tokens: 2000 }, jobs: { T01: { files: { "one.txt": "one\n" } } } });
  await fs.writeFile(f.plan, plan([{ id: "T01", file: "one.txt" }]));
  const result = await f.build("advisory", { maxTokens: 1000 });
  assert.match(result.text, /1 done, 0 failed/);
  assert.match(result.details.supervision.disableReason, /token budget exhausted/i);
  assert.equal(f.validations, 1);
  await f.retained(result);
});
