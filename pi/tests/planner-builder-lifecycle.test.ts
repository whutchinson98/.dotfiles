import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import type { RunBuilderOptions } from "../.pi/agent/extensions/planner-builder/builder-runner.ts";
import { PlannerOperations, waitForParentIdle } from "../.pi/agent/extensions/planner-builder/controls.ts";
import { RunJournal } from "../.pi/agent/extensions/planner-builder/run-journal.ts";
import type { SupervisorOptions } from "../.pi/agent/extensions/planner-builder/supervisor.ts";
import { fixture, git } from "./planner-builder-fixtures.ts";
import { extensionRuntime, loadPlanDashboard, loadPlannerBuilder, ScriptedBuilderTransport } from "./planner-builder-harness.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function tick(): Promise<void> { await new Promise((resolve) => setImmediate(resolve)); }
const result = { text: "done", details: { path: "plan.md", agents: [] } };
const plan = `# Plan\n## Builder Tasks\n### Task T01: Write one file\nStatus: pending\nDepends on: none\nFiles:\n- one.txt\nInstructions:\n- Write one.txt\nVerification:\n- inspect one.txt\n`;

test("competing background starts acquire ownership before idle waits; tools share it", async () => {
  const api = loadPlannerBuilder("/unused");
  let starts = 0;
  api.setBuildPlanFile(async () => { starts++; return result; });
  const idle = deferred();
  let waits = 0;
  const runtime = extensionRuntime(api, { isIdle: () => false, waitForIdle: () => { waits++; return idle.promise; } });
  await Promise.all([runtime.command("plan-build", "plan.md"), runtime.command("plan-create", "another plan")]);
  await assert.rejects(runtime.tool("plan_file_build", { path: "plan.md" }), /already owns/);
  assert.equal(waits, 1);
  assert.equal(starts, 0);
  assert.ok(runtime.notifications.some((text: string) => text.includes("already owns")));
  await runtime.command("plan-inspect");
  const runId = runtime.notifications.find((text: string) => text.includes(" owned."))?.match(/Run ([^ ]+)/)?.[1];
  assert.ok(runId);
  await runtime.command("plan-cancel", runId);
  await runtime.shutdown(); // Must not depend on idle.promise resolving.
  idle.resolve();
  await tick();
  assert.equal(starts, 0);
});

test("tool ownership rejects commands; dashboard toggle/close never cancels; parent abort joins cleanup", async () => {
  const api = loadPlannerBuilder("/unused");
  const started = deferred();
  const joined = deferred();
  let signal!: AbortSignal;
  api.setBuildPlanFile(async (_ctx: unknown, _params: unknown, incoming: AbortSignal) => {
    signal = incoming;
    started.resolve();
    await new Promise<void>((resolve) => incoming.addEventListener("abort", () => resolve(), { once: true }));
    await joined.promise;
    return result;
  });
  const runtime = extensionRuntime(api);
  const parent = new AbortController();
  const work = runtime.tool("plan_file_build", { path: "plan.md" }, parent.signal);
  await started.promise;
  await runtime.command("plan-build", "plan.md");
  await runtime.shortcuts.get("alt+x").handler(runtime.ctx);
  await runtime.shortcuts.get("alt+x").handler(runtime.ctx);
  assert.equal(signal.aborted, false);
  parent.abort();
  assert.equal(signal.aborted, true);
  await assert.rejects(runtime.tool("plan_file_create", { request: "new" }), /already owns/);
  joined.resolve();
  await work;
  await runtime.shutdown();
});

test("reload waits for background cleanup and prevents starts in the old runtime", async () => {
  const api = loadPlannerBuilder("/unused");
  const started = deferred();
  const cleanup = deferred();
  let aborted = false;
  api.setBuildPlanFile(async (_ctx: unknown, _params: unknown, signal: AbortSignal) => {
    started.resolve();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    await cleanup.promise;
    return result;
  });
  const runtime = extensionRuntime(api);
  await runtime.command("plan-build", "--advisory plan.md");
  await started.promise;
  let completed = false;
  const shutdown = runtime.shutdown().then(() => { completed = true; });
  await tick();
  assert.equal(aborted, true);
  assert.equal(completed, false);
  await assert.rejects(runtime.tool("plan_file_build", { path: "plan.md" }), /shutting down/);
  cleanup.resolve();
  await shutdown;
  await runtime.shutdown();
});

test("ownership releases after errors and cancellation of an idle wait", async () => {
  const owner = new PlannerOperations();
  await assert.rejects(owner.run("create", async () => { throw new Error("failure"); }), /failure/);
  const signal = new AbortController();
  const wait = owner.run("build", () => waitForParentIdle(() => new Promise(() => {}), signal.signal), signal.signal);
  signal.abort();
  await assert.rejects(wait);
  assert.equal(owner.active, undefined);
  assert.equal(await owner.run("build", async () => "ok"), "ok");
});

test("children register no nested orchestration tools or commands", () => {
  const api = loadPlannerBuilder("/unused", { process: { ...process, env: { ...process.env, PI_SUBAGENT: "1" } } });
  const runtime = extensionRuntime(api);
  assert.equal(runtime.tools.size, 0);
  assert.equal(runtime.commands.size, 0);
});

test("default off never starts supervisor and missing supervisor degrades visibly without enabling verifier", async (t) => {
  for (const supervisionMode of ["off", "steer"] as const) {
    const f = await fixture(t);
    await fs.writeFile(f.plan, plan);
    const api = loadPlannerBuilder(path.join(f.parent, "tasks"), { startSupervisor: () => { throw new Error("missing supervisor must not launch"); } });
    api.setRunAgent(() => { throw new Error("verifier must remain opt-in"); });
    const transports: ScriptedBuilderTransport[] = [];
    api.setBuilderTransport((options: any) => {
      const transport = new ScriptedBuilderTransport(options, async (child) => {
        await fs.writeFile(path.join(options.cwd, "one.txt"), "task");
        await git(options.cwd, "add", "one.txt");
        await git(options.cwd, "commit", "-m", "task");
        child.message(); child.settle();
      });
      transports.push(transport);
      return transport;
    });
    const built = await api.buildPlanFile({ cwd: f.root, hasUI: false }, { path: f.plan, supervisionMode, model: "test", effort: "off", builderMonitor: false });
    assert.match(built.text, /1 done/);
    assert.equal(built.details.supervision.mode, supervisionMode);
    assert.equal(transports[0].options.invocation.args.includes("--no-session"), supervisionMode === "off");
    if (supervisionMode === "steer") {
      assert.match(built.details.supervision.disableReason, /unavailable/);
      assert.ok(built.details.supervision.attempts[0].session.sessionFile.startsWith(built.details.supervision.runDirectory));
    }
    const journal = await fs.readFile(built.details.supervision.journalPath, "utf8");
    assert.match(journal, /"kind":"attempt"/);
    assert.match(journal, /"kind":"session"/);
    assert.equal(transports[0].stopped, true);
  }
});

test("one supervisor receives plan decisions and bounded options, joins before journal close", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.plan, plan);
  const events: string[] = [];
  let supervisorOptions!: SupervisorOptions;
  let checkpoints = 0;
  const api = loadPlannerBuilder(path.join(f.parent, "tasks"), {
    discoverAgents: () => ({ agents: ["builder", "supervisor"].map((name) => ({ name, source: "project", systemPrompt: "trusted prompt", tools: ["bash"], includeExtensions: true })) }),
    startSupervisor: async (options: SupervisorOptions) => {
      assert.equal(supervisorOptions, undefined, "exactly one supervisor per build");
      supervisorOptions = options;
      return { status: { state: "idle", reviews: 0, activeMs: 0, tokens: 0 },
        checkpoint: async () => { checkpoints++; }, stop: async () => { events.push("supervisor joined"); } };
    },
    RunJournal: { open: async (options: any) => {
      const journal = await RunJournal.open(options);
      const close = journal.close.bind(journal);
      journal.close = async () => { await close(); events.push("journal closed"); };
      return journal;
    } },
  });
  let confirmed = "";
  api.setBuilderTransport((options: any) => new ScriptedBuilderTransport(options, async (child) => {
    await fs.writeFile(path.join(options.cwd, "one.txt"), "task");
    await git(options.cwd, "add", "one.txt"); await git(options.cwd, "commit", "-m", "task");
    child.message(); child.settle();
  }));
  const built = await api.buildPlanFile({ cwd: f.root, hasUI: true, ui: { confirm: async (_title: string, text: string) => { confirmed = text; return true; } } },
    { path: f.plan, supervisionMode: "advisory", supervisionOptions: { maxReviews: 1000 }, agentScope: "both", model: "test", effort: "off", builderMonitor: false });
  assert.match(confirmed, /builder, supervisor/);
  assert.equal(supervisorOptions.controller.config.supervisionOptions.maxReviews, 200);
  assert.equal(supervisorOptions.context.planText, plan);
  assert.match(supervisorOptions.context.recordedDecisions, /older plan/);
  assert.match(supervisorOptions.context.verificationInstructions, /not verification/);
  assert.equal(checkpoints, 1);
  assert.deepEqual(events, ["supervisor joined", "journal closed"]);
  assert.match(built.text, /1 done/);
});

test("creation persists answered, cancelled and unavailable questions outside task blocks", async (t) => {
  const f = await fixture(t);
  await fs.rm(f.plan, { force: true });
  const answers = ["answered", "cancelled", "unavailable"];
  const api = loadPlannerBuilder(path.join(f.parent, "tasks"), { surfaceUserQuestion: async () => ({ status: answers.shift(), answer: "chosen" }) });
  api.setRunAgent(async (_cwd: string, _agents: unknown, _agent: unknown, _task: unknown, options: any) => {
    for (let index = 0; index < 3; index++) await options.userQuestionHandler({ question: `Question ${index}?` });
    return { exitCode: 0, finalOutput: plan, stderr: "", usage: {} };
  });
  await api.createPlanFile({ cwd: f.root, hasUI: false }, { path: f.plan, request: "plan it", model: "test", effort: "off" });
  const saved = await fs.readFile(f.plan, "utf8");
  for (const status of ["answered", "cancelled", "unavailable"]) assert.ok(saved.includes(`"status":"${status}"`));
  assert.doesNotMatch(api.parsePlanTasks(saved)[0].block, /runner-authored/);
});

test("unsealed successful lifecycle cannot enter VCS validation/integration", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.plan, plan);
  const head = await git(f.root, "rev-parse", "HEAD");
  const api = loadPlannerBuilder(path.join(f.parent, "tasks"));
  api.setBuilderLifecycle(async (options: RunBuilderOptions) => ({ agent: options.agent.name, agentSource: "user", task: "task", cwd: options.workspace.cwd,
    exitCode: 0, finalOutput: "PLAN_TASK_RESULT: done", stderr: "", usage: {} }));
  const built = await api.buildPlanFile({ cwd: f.root, hasUI: false }, { path: f.plan, model: "test", effort: "off" });
  assert.match(built.text, /0 done, 1 failed/);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), head);
});

test("real dashboard close declines a question without aborting its build; wrapper shows controls and paths", async () => {
  const { PlanBuildDashboard, renderPlanBuildDetails } = loadPlanDashboard();
  const dashboard = new PlanBuildDashboard("plan.md");
  const abort = new AbortController();
  const answer = dashboard.askQuestion({ question: "Proceed?", options: [] }, abort.signal);
  dashboard.close();
  assert.equal(await answer, undefined);
  assert.equal(abort.signal.aborted, false);
  const details = { path: "plan.md", agents: [{ id: "T01", title: "task", agent: "builder", status: "running", output: "working" }],
    supervision: { runId: "run-identity", mode: "steer", agent: "supervisor", status: "disabled", disableReason: "Token budget exhausted", journalPath: "/external/decisions.jsonl", runDirectory: "/external",
      attempts: [{ taskId: "T01", attemptId: "attempt-identity", attemptNumber: 1, phase: "running", humanWait: true,
        session: { sessionFile: "/external/builder/session.jsonl" }, controls: [{ controlId: "control-id", status: "queued" }] }] } };
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  const rendered = renderPlanBuildDetails(details, true, theme).render(120).join("\n");
  for (const text of ["attempt-identity", "run-identity", "Token budget", "watchdog paused", "control-id: queued", "/external/decisions", "/external/builder", "does not cancel"]) assert.ok(rendered.includes(text), text);
  dashboard.update(details);
  const component = dashboard.createComponent(theme, () => {}, () => {}, () => 16);
  assert.ok(component.render(60).length <= 16);
  assert.match(component.render(60).join("\n"), /does not cancel/);
});

test("real build abort closes human questions and joins supervisor/builders before journal flush and reload return", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.plan, plan);
  const question = deferred();
  const builderJoin = deferred();
  const supervisorJoin = deferred();
  const events: string[] = [];
  const api = loadPlannerBuilder(path.join(f.parent, "tasks"), {
    discoverAgents: () => ({ agents: ["builder", "supervisor"].map((name) => ({ name, source: "user", systemPrompt: "" })) }),
    startSupervisor: async () => ({ status: { state: "idle", reviews: 0, activeMs: 0, tokens: 0 },
      checkpoint: async () => {}, stop: async () => { await supervisorJoin.promise; events.push("supervisor joined"); } }),
    RunJournal: { open: async (options: any) => {
      const journal = await RunJournal.open(options);
      const close = journal.close.bind(journal);
      journal.close = async () => { await close(); events.push("journal closed"); };
      return journal;
    } },
  });
  api.setBuilderTransport((options: any) => new ScriptedBuilderTransport(options, async (child) => {
    const answer = await options.uiHandler({ type: "extension_ui_request", id: "question", method: "input", title: "Need a decision" }, new AbortController().signal);
    assert.equal(answer.cancelled, true);
    events.push("question cancelled");
    await builderJoin.promise;
    child.message("aborted", "aborted"); child.settle(true);
    events.push("builder joined");
  }));
  const runtime = extensionRuntime(api, { cwd: f.root, ui: {
    notify: () => {}, setStatus: () => {},
    input: async (_title: string, _placeholder: string, options: { signal: AbortSignal }) => {
      question.resolve();
      return new Promise((resolve) => options.signal.addEventListener("abort", () => resolve(undefined), { once: true }));
    },
  } });
  const parent = new AbortController();
  const work = runtime.tool("plan_file_build", { path: f.plan, supervisionMode: "steer" }, parent.signal).then(() => undefined, (error: Error) => error);
  await question.promise;
  parent.abort();
  let shutdownDone = false;
  const shutdown = runtime.shutdown().then(() => { shutdownDone = true; });
  await tick();
  assert.ok(events.includes("question cancelled"));
  assert.equal(shutdownDone, false);
  assert.equal(events.includes("journal closed"), false);
  builderJoin.resolve();
  await tick();
  assert.equal(shutdownDone, false);
  supervisorJoin.resolve();
  await shutdown;
  assert.match(String(await work), /Recovery record:/);
  assert.equal(events.at(-1), "journal closed");
  assert.ok(events.indexOf("builder joined") < events.indexOf("journal closed"));
  assert.ok(events.indexOf("supervisor joined") < events.indexOf("journal closed"));
});
