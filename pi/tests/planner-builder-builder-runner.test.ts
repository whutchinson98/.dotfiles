import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { BuildController } from "../.pi/agent/extensions/planner-builder/build-controller.ts";
import { inspectBuilderResume, runBuilder, type RunBuilderOptions } from "../.pi/agent/extensions/planner-builder/builder-runner.ts";
import { createQuestionQueue, type ParentQuestion } from "../.pi/agent/extensions/planner-builder/question-queue.ts";
import { RpcAgent, type RpcClock } from "../.pi/agent/extensions/planner-builder/rpc-agent.ts";
import { RunJournal } from "../.pi/agent/extensions/planner-builder/run-journal.ts";
import { ScriptedBuilderTransport } from "./planner-builder-harness.ts";

const exec = promisify(execFile);
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("Fixture did not reach the expected lifecycle boundary");
}
class Clock implements RpcClock {
  time = 1000;
  private nextId = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, ms: number): number {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  }
  clearTimeout(id: unknown): void { this.timers.delete(id as number); }
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    while (true) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = end;
    await flush();
  }
}
async function setup(t: TestContext, supervised = false, clock?: RpcClock): Promise<{
  options: RunBuilderOptions; parent: string; children: ScriptedBuilderTransport[];
  journal?: RunJournal; answers: unknown[]; launches: string[][];
}> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "pi-builder-runner-"));
  const root = path.join(parent, "workspace");
  const sourceRoot = path.join(parent, "source");
  await fs.mkdir(root);
  await fs.mkdir(sourceRoot);
  const runDirectory = path.join(parent, "run");
  const journal = supervised ? await RunJournal.open({ runId: "build", runDirectory, sourceRoots: [root, sourceRoot], protectedPaths: [] }) : undefined;
  const questions = createQuestionQueue({ interactive: false, show: async () => undefined });
  const controller = new BuildController({ runId: "build", journal, clock,
    supervision: { supervisionMode: supervised ? "steer" : "off", supervisionOptions: { cooldownSeconds: 0 } } });
  const children: ScriptedBuilderTransport[] = [];
  const answers: unknown[] = [];
  const launches: string[][] = [];
  async function temporary(name: string, content: string): Promise<{ dir: string; filePath: string }> {
    const dir = await fs.mkdtemp(path.join(parent, `${name}-`));
    const filePath = path.join(dir, "extension.ts");
    await fs.writeFile(filePath, content, { mode: 0o600 });
    return { dir, filePath };
  }
  const options: RunBuilderOptions = {
    workspace: { name: "task", rootPath: root, cwd: root, baseRevision: "a".repeat(40) },
    vcs: "jj", sourceRoot, protectedPaths: ["plan.md"], taskId: "T01", task: "Build the assigned task",
    agent: { name: "builder", source: "user", systemPrompt: "", tools: ["read", "bash"], description: "test", filePath: "builder.md" },
    monitor: { enabled: false, intervalSeconds: 1, stuckTimeoutSeconds: 2, maxRestarts: 1 },
    controller, questions, runDirectory,
    dependencies: {
      clock, getInvocation: (args) => { launches.push(args); return { command: "pi-fixture", args: ["cli.js", ...args] }; },
      writeSystemPrompt: (name, prompt) => temporary(name, prompt),
      writeMaxEffortExtension: () => temporary("effort", "max effort compatibility extension"),
      createQuestionBridge: async () => {
        const result = await temporary("question", "question bridge");
        return { dir: result.dir, extensionPath: result.filePath };
      },
      parseQuestion: (toolCallId, args) => ({ toolCallId, question: (args as { question: string }).question, options: [] }),
      writeQuestionResponse: async (_dir, _id, response) => { answers.push(response); },
      createTransport: (rpc) => {
        const child = new ScriptedBuilderTransport(rpc, async (transport) => { transport.message(); transport.settle(); });
        children.push(child);
        return child;
      },
    },
  };
  t.after(async () => {
    await controller.cancelBuild();
    await questions.close();
    await journal?.close();
    await fs.rm(parent, { recursive: true, force: true });
  });
  return { options, parent, children, journal, answers, launches };
}
function script(options: RunBuilderOptions, fn: ConstructorParameters<typeof ScriptedBuilderTransport>[1]): ScriptedBuilderTransport[] {
  const children: ScriptedBuilderTransport[] = [];
  options.dependencies.createTransport = (rpc) => {
    const child = new ScriptedBuilderTransport(rpc, fn);
    children.push(child);
    return child;
  };
  return children;
}

// The default transport in these tests is explicit; no planner/verifier one-shot stub is involved.
test("off-mode RPC preserves invocation, cwd, model/effort, extensions, tools, stderr and output without persisting sessions", async (t) => {
  const { options, launches, parent } = await setup(t);
  options.model = "provider/selected";
  options.effort = "max";
  options.agent.model = "ignored-default";
  options.agent.systemPrompt = "Builder constraints";
  const children = script(options, async (child) => {
    assert.equal(child.options.env.PI_SUBAGENT, "1");
    assert.equal(child.options.env.PI_SUBAGENT_NAME, "builder");
    assert.equal(child.options.cwd, options.workspace.cwd);
    assert.equal(child.options.invocation.command, "pi-fixture");
    assert.equal(child.options.env.PI_USER_QUESTION_BRIDGE_DIR, undefined);
    child.stderr = "useful diagnostic";
    child.message("A successful result without a marker");
    child.settle();
  });
  const result = await runBuilder(options);
  assert.equal(result.exitCode, 0);
  assert.equal(result.finalOutput, "A successful result without a marker");
  assert.equal(result.stderr, "useful diagnostic");
  assert.equal(result.usage.input, 10);
  const args = launches[0];
  assert.deepEqual(args.slice(0, 3), ["--mode", "rpc", "--no-session"]);
  assert.ok(args.includes("--no-extensions"));
  assert.equal(args[args.indexOf("--model") + 1], "provider/selected");
  assert.equal(args[args.indexOf("--thinking") + 1], "xhigh");
  assert.equal(args[args.indexOf("--tools") + 1], "read,bash");
  assert.equal(args.filter((arg) => arg === "--extension").length, 1);
  assert.ok(!args.includes("--session-dir"));
  assert.ok(!args.includes("-p"));
  assert.ok(!args.some((arg) => arg.startsWith("Task:")));
  assert.equal(children[0].stopped, true);
  assert.deepEqual((await fs.readdir(parent)).sort(), ["source", "workspace"]);
});

test("extension discovery and default model remain selected; ask_user is never added to tools", async (t) => {
  const { options, launches } = await setup(t);
  options.agent.includeExtensions = true;
  options.agent.model = "agent-default";
  const result = await runBuilder(options);
  assert.equal(result.model, "agent-default");
  assert.ok(!launches[0].includes("--no-extensions"));
  assert.ok(!launches[0].includes("--extension"));
  assert.equal(launches[0][launches[0].indexOf("--tools") + 1], "read,bash");
});

test("supervised sessions get private unique directories and journal actual get_state mappings", async (t) => {
  const { options, launches, journal } = await setup(t, true);
  const result = await runBuilder(options);
  assert.equal(result.exitCode, 0);
  assert.ok(!launches[0].includes("--no-session"));
  const requestedId = launches[0][launches[0].indexOf("--session-id") + 1];
  const directory = launches[0][launches[0].indexOf("--session-dir") + 1];
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.ok(directory.startsWith(options.runDirectory!));
  const mapping = result.attempts[0].session!;
  assert.notEqual(mapping.sessionId, requestedId, "record observed identity, not a guessed mapping");
  assert.equal(path.dirname(mapping.sessionFile!), directory);
  const records = await fs.readFile(journal!.path, "utf8");
  assert.match(records, new RegExp(mapping.sessionId));
  assert.match(records, new RegExp(result.attempts[0].attemptId!));
});

test("supervised persistence beneath a checkout fails before spawning", async (t) => {
  const { options, launches } = await setup(t, true);
  options.runDirectory = options.workspace.rootPath;
  const result = await runBuilder(options);
  assert.equal(result.exitCode, 1);
  assert.match(result.errorMessage!, /outside source and task checkouts/);
  assert.equal(launches.length, 0);
});

test("handled prompts fail promptly instead of awaiting nonexistent settlement", async (t) => {
  const { options } = await setup(t);
  const children = script(options, async () => {});
  const create = options.dependencies.createTransport!;
  options.dependencies.createTransport = (rpc) => {
    const child = create(rpc);
    child.prompt = async () => ({ disposition: "handled", response: { type: "response", id: "handled", command: "prompt", success: true }, settled: Promise.resolve(null) });
    return child;
  };
  const result = await runBuilder(options);
  assert.equal(result.exitCode, 1);
  assert.match(result.errorMessage!, /handled without starting/);
  assert.equal(children[0].stopped, true);
});

test("state inspection and repeated stderr do not feed the watchdog", async (t) => {
  const clock = new Clock();
  const { options } = await setup(t, false, clock);
  options.monitor = { enabled: true, intervalSeconds: 1, stuckTimeoutSeconds: 2, maxRestarts: 0 };
  const children = script(options, async () => {});
  const pending = runBuilder(options);
  await waitFor(() => children.length === 1);
  for (let i = 0; i < 2; i++) {
    children[0].stderr += `diagnostic ${i}\n`;
    await children[0].request("get_state");
    options.controller.inspectBuild();
    await clock.advance(1000);
  }
  const result = await pending;
  assert.equal(result.exitCode, 124);
  assert.equal(result.stopReason, "stuck");
  assert.match(result.stderr, /diagnostic 1/);
});

test("missing actual session mapping fails closed and joins the child", async (t) => {
  const { options } = await setup(t, true);
  const children = script(options, async () => { assert.fail("must not prompt without a confirmed mapping"); });
  const create = options.dependencies.createTransport!;
  options.dependencies.createTransport = (rpc) => {
    const child = create(rpc);
    child.request = async (command) => ({ type: "response", id: "missing", command, success: true, data: {} });
    return child;
  };
  const result = await runBuilder(options);
  assert.equal(result.exitCode, 1);
  assert.match(result.errorMessage!, /omitted its actual session identity/);
  assert.equal(children[0].stopped, true);
});

for (const outcome of ["length", "error", "aborted"]) {
  test(`terminal ${outcome} cannot succeed without a marker or with a done marker`, async (t) => {
    for (const text of ["no marker", "PLAN_TASK_RESULT: done"]) {
      const { options } = await setup(t);
      script(options, async (child) => { child.message(text, outcome); child.settle(outcome === "aborted"); });
      const result = await runBuilder(options);
      assert.equal(result.exitCode, 1);
      assert.equal(result.stopReason, outcome);
      assert.equal(result.attempts.length, 1);
    }
  });
}

test("retryable intermediate error/length and agent_end do not end a live builder; barrier joins only final settlement", async (t) => {
  const { options } = await setup(t);
  let child!: ScriptedBuilderTransport;
  let checkpoint = false;
  script(options, async (transport) => {
    child = transport;
    child.message("provider retry", "error", 5);
    child.emit({ type: "agent_end", messages: [], willRetry: true });
    child.emit({ type: "auto_retry_start", attempt: 1 });
  });
  options.checkpoint = async () => { checkpoint = true; assert.equal(child.stopped, false); };
  const pending = runBuilder(options);
  await waitFor(() => !!child);
  assert.equal(child.stopped, false);
  assert.equal(checkpoint, false);
  child.emit({ type: "auto_retry_end", success: true });
  child.message("length recovery", "length", 7);
  child.emit({ type: "compaction_start", reason: "overflow" });
  child.emit({ type: "compaction_end", reason: "overflow", willRetry: true });
  child.message("Final success", "stop", 11);
  child.settle();
  const result = await pending;
  assert.equal(checkpoint, true);
  assert.equal(child.stopped, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.usage.input, 23);
  assert.equal(result.usage.turns, 3);
});

test("bounded checkpoint may deliver guidance before integration and replaces the final result", async (t) => {
  const { options } = await setup(t, true);
  const children = script(options, async (child, prompt) => {
    if (prompt.startsWith("[planner-builder-control:")) {
      child.emit({ type: "message_end", message: { role: "user", content: prompt } });
      child.message("Rechecked task commit");
    } else child.message("Initial completion");
    child.settle();
  });
  options.checkpoint = async (identity) => {
    const control = await options.controller.requestGuidance({ ...identity, origin: "supervisor", guidance: "Recheck tests", reason: "Checkpoint" });
    assert.equal(control.status, "delivered");
    assert.equal(children[0].stopped, false);
  };
  const result = await runBuilder(options);
  assert.equal(result.exitCode, 0);
  assert.equal(result.finalOutput, "Rechecked task commit");
  assert.equal(result.attempts[0].controls[0].status, "delivered");
  assert.equal(children[0].stopped, true);
});

for (const vcs of ["jj", "git"] as const) {
  for (const retained of ["dirty", "committed", "multiple"] as const) {
    test(`${vcs} watchdog restart inspects retained ${retained} work, preserving the one-commit contract`, async (t) => {
      const clock = new Clock();
      const { options, launches } = await setup(t, true, clock);
      options.vcs = vcs;
      options.monitor.enabled = true;
      const root = options.workspace.rootPath;
      async function command(...args: string[]): Promise<string> {
        return (await exec(vcs, args, { cwd: root })).stdout.trim();
      }
      if (vcs === "jj") {
        await command("git", "init", "--colocate");
        await command("config", "set", "--repo", "user.name", "Test");
        await command("config", "set", "--repo", "user.email", "test@example.invalid");
        await command("config", "set", "--repo", "signing.behavior", "drop");
        await fs.writeFile(path.join(root, "base.txt"), "base");
        await command("commit", "-m", "base");
        options.workspace.baseRevision = await command("log", "--no-graph", "-r", "@-", "-T", "commit_id");
        // Match the runner's task workspace: a fresh @ whose parent is the supplied base.
      } else {
        await command("init");
        await command("config", "user.name", "Test");
        await command("config", "user.email", "test@example.invalid");
        await command("config", "commit.gpgSign", "false");
        await fs.writeFile(path.join(root, "base.txt"), "base");
        await command("add", "base.txt");
        await command("commit", "-m", "base");
        options.workspace.baseRevision = await command("rev-parse", "HEAD");
      }
      async function commit(file: string): Promise<void> {
        if (vcs === "git") await command("add", file);
        await command("commit", "-m", "T01");
      }
      let launchesSeen = 0;
      let firstFinished!: () => void;
      const firstReady = new Promise<void>((resolve) => { firstFinished = resolve; });
      const children = script(options, async (child, prompt) => {
        launchesSeen++;
        if (launchesSeen === 1) {
          await fs.writeFile(path.join(root, "task.txt"), "retained work");
          if (retained !== "dirty") await commit("task.txt");
          if (retained === "multiple") {
            await fs.writeFile(path.join(root, "second.txt"), "second");
            await commit("second.txt");
          }
          child.message("Work retained before hang", "toolUse", 3);
          child.stderr = "first attempt diagnostic\n";
          firstFinished();
          return; // No settlement: deterministic watchdog triggers the restart.
        }
        assert.equal(children[0].stopped, true);
        assert.match(prompt, /fresh conversation, not a resumed session/);
        assert.match(prompt, /Prior attempt\/control summary/);
        assert.match(prompt, /stuck/);
        assert.equal(await fs.readFile(path.join(root, "task.txt"), "utf8"), "retained work");
        if (retained === "committed") assert.match(prompt, /Existing task commit:/);
        else { assert.match(prompt, /No separate task commit exists/); await commit("task.txt"); }
        child.message();
        child.settle();
      });
      const pending = runBuilder(options);
      await firstReady;
      await clock.advance(2500);
      const result = await pending;
      if (retained === "multiple") {
        assert.match(result.finalOutput, /PLAN_TASK_RESULT: blocked/);
        assert.match(result.errorMessage!, /Ambiguous retained/);
        assert.equal(launchesSeen, 1);
        return;
      }
      assert.equal(result.exitCode, 0, result.errorMessage);
      assert.equal(result.restartCount, 1);
      assert.equal(result.attempts.length, 2);
      assert.notEqual(result.attempts[0].attemptId, result.attempts[1].attemptId);
      assert.equal(result.usage.input, 13);
      assert.equal(result.usage.turns, 2);
      assert.match(result.stderr, /first attempt diagnostic/);
      const directories = launches.map((args) => args[args.indexOf("--session-dir") + 1]);
      assert.notEqual(directories[0], directories[1]);
      const inventory = await inspectBuilderResume(options.workspace, vcs);
      assert.match(inventory, /Existing task commit:/);
      assert.match(inventory, /Never create a second task commit/);
    });
  }
}

test("queued and displayed human questions pause watchdog; answering resets its full idle baseline", async (t) => {
  const clock = new Clock();
  const { options, answers } = await setup(t, false, clock);
  options.monitor = { enabled: true, intervalSeconds: 1, stuckTimeoutSeconds: 2, maxRestarts: 0 };
  options.agent.tools!.push("ask_user");
  const active: Array<{ question: ParentQuestion; answer: (value: string) => void }> = [];
  const questions = createQuestionQueue({ interactive: true, show: (question, signal) => new Promise((resolve) => {
    active.push({ question, answer: resolve });
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
  }) });
  t.after(() => questions.close());
  options.questions = questions;
  const preceding = questions.ask({ owner: "supervisor", id: "ahead", method: "input", title: "Other child" });
  let child!: ScriptedBuilderTransport;
  script(options, async (transport) => { child = transport; });
  const pending = runBuilder(options);
  await waitFor(() => !!child);
  await clock.advance(1000);
  child.emit({ type: "tool_execution_start", toolName: "ask_user", toolCallId: "question", args: { question: "Scope?" } });
  await flush();
  await clock.advance(10_000);
  assert.equal(child.stopped, false, "queued questions pause watchdog");
  active[0].answer("answer preceding");
  await preceding;
  await flush();
  assert.equal(active.length, 2);
  await clock.advance(10_000);
  assert.equal(child.stopped, false, "displayed questions pause watchdog");
  active[1].answer("Keep scope");
  await flush();
  assert.deepEqual(answers, [{ status: "answered", answer: "Keep scope" }]);
  await clock.advance(1000);
  assert.equal(child.stopped, false, "answer starts a fresh idle interval");
  child.message();
  child.settle();
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.equal(result.restartCount, 0);
});

test("allowed ask_user gets the existing bridge even without UI, and is cancelled/joined on parent abort", async (t) => {
  const { options, launches, answers } = await setup(t);
  options.agent.tools!.push("ask_user");
  let child!: ScriptedBuilderTransport;
  script(options, async (transport) => {
    child = transport;
    child.emit({ type: "tool_execution_start", toolName: "ask_user", toolCallId: "question", args: { question: "Scope?" } });
  });
  const abort = new AbortController();
  options.signal = abort.signal;
  const pending = runBuilder(options);
  await waitFor(() => answers.length === 1);
  assert.ok(launches[0].includes("--extension"));
  assert.ok(child.options.env.PI_USER_QUESTION_BRIDGE_DIR);
  assert.deepEqual(answers, [{ status: "unavailable", message: "User interaction is unavailable in this mode" }]);
  abort.abort();
  const result = await pending;
  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "aborted");
  assert.equal(child.stopped, true);
  await assert.rejects(fs.stat(child.options.env.PI_USER_QUESTION_BRIDGE_DIR!), { code: "ENOENT" });
});

test("aborting a displayed question cancels parent UI before joining the builder", async (t) => {
  const { options, answers } = await setup(t);
  options.agent.tools!.push("ask_user");
  let displayed = false;
  let dismissed = false;
  const questions = createQuestionQueue({ interactive: true, show: async (_question, signal) => {
    displayed = true;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { dismissed = true; resolve(); }, { once: true }));
    return undefined;
  } });
  t.after(() => questions.close());
  options.questions = questions;
  const children = script(options, async (child) => {
    child.emit({ type: "tool_execution_start", toolName: "ask_user", toolCallId: "active", args: { question: "Scope?" } });
  });
  const abort = new AbortController();
  options.signal = abort.signal;
  const pending = runBuilder(options);
  await waitFor(() => displayed);
  abort.abort();
  const result = await pending;
  assert.equal(result.stopReason, "aborted");
  assert.equal(dismissed, true);
  assert.equal(children[0].stopped, true);
  assert.deepEqual(answers, [{ status: "cancelled", message: undefined }]);
});

test("RPC extension dialogs share parent queue and preserve confirm/value/cancel semantics", async (t) => {
  const { options } = await setup(t);
  const shown: string[] = [];
  const questions = createQuestionQueue({ interactive: true, show: async (question) => {
    shown.push(question.method);
    return question.method === "confirm" ? false : "value";
  } });
  t.after(() => questions.close());
  options.questions = questions;
  script(options, async (child) => {
    for (const method of ["input", "editor", "select", "confirm"]) {
      const request = { type: "extension_ui_request" as const, method, id: method, title: "Question", options: ["value"] };
      child.emit(request);
      const reply = await child.options.uiHandler!(request, new AbortController().signal);
      assert.deepEqual(reply, method === "confirm" ? { confirmed: false } : { value: "value" });
    }
    child.message();
    child.settle();
  });
  const result = await runBuilder(options);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(shown, ["input", "editor", "select", "confirm"]);
});

// Exercise the real JSONL transport and controller with a fake executable, not a model.
test("real RPC subprocess drains thinking/text/retry records and joins before returning", async (t) => {
  const { options } = await setup(t);
  const code = `
    let input = '';
    const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
    process.stdin.on('data', chunk => {
      input += chunk;
      let end;
      while ((end = input.indexOf('\\n')) >= 0) {
        const c = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
        const reply = data => emit({type:'response', command:c.type, id:c.id, success:true, data});
        if (c.type === 'get_state') reply({isStreaming:false,isCompacting:false,pendingMessageCount:0,sessionId:'actual'});
        else if (c.type === 'prompt') {
          emit({type:'agent_start'});
          emit({type:'message_start',message:{role:'assistant',timestamp:1,content:[]}});
          emit({type:'message_update',assistantMessageEvent:{type:'thinking_delta',contentIndex:0,delta:'hidden reasoning'}});
          emit({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:1,delta:'Visible text'}});
          emit({type:'message_end',message:{role:'assistant',timestamp:1,stopReason:'stop',content:[{type:'text',text:'PLAN_TASK_RESULT: done'}],usage:{input:2,output:3}}});
          emit({type:'agent_end',messages:[]});
          emit({type:'agent_settled',aborted:false});
          reply({disposition:'started'});
        } else reply({});
      }
    });
    process.stdin.on('end', () => process.exit(0));
  `;
  options.dependencies.getInvocation = () => ({ command: process.execPath, args: ["-e", code] });
  options.dependencies.createTransport = (rpc) => new RpcAgent(rpc);
  const output: string[] = [];
  options.onOutput = (result) => output.push(result.liveOutput ?? "");
  const result = await runBuilder(options);
  assert.equal(result.exitCode, 0, result.errorMessage);
  assert.equal(result.finalOutput, "PLAN_TASK_RESULT: done");
  assert.equal(result.usage.input, 2);
  assert.ok(output.every((text) => !text.includes("hidden reasoning")));
});
