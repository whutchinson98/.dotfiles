import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BuildController, type BuildControllerOptions } from "../.pi/agent/extensions/planner-builder/build-controller.ts";
import { detectVcs } from "../.pi/agent/extensions/planner-builder/vcs.ts";
import { RpcAgent, type RpcAgentOptions, type RpcRecord } from "../.pi/agent/extensions/planner-builder/rpc-agent.ts";
import { startSupervisor, type SupervisorOptions } from "../.pi/agent/extensions/planner-builder/supervisor.ts";
import { loadPlannerBuilder, ScriptedBuilderTransport } from "./planner-builder-harness.ts";

const exec = promisify(execFile);
async function jj(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("jj", ["--no-pager", ...args], { cwd })).stdout.trim();
}
async function fixture(t: TestContext): Promise<{ root: string; api: Record<string, any>; base: string }> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "pi-plan-jj-test-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "source");
  await fs.mkdir(root);
  await jj(root, "git", "init", "--colocate");
  await jj(root, "config", "set", "--repo", "user.name", "Fixture");
  await jj(root, "config", "set", "--repo", "user.email", "fixture@example.invalid");
  await jj(root, "config", "set", "--repo", "signing.behavior", "drop");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/base.txt"), "base\n");
  await jj(root, "commit", "-m", "initial");
  const api = loadPlannerBuilder(path.join(parent, "tasks"));
  return { root, api, base: await api.getCommitId(root, "@") };
}

test("jj colocated detection, workspace pointer, single commit integration and cleanup regression", async (t) => {
  const { root, api, base } = await fixture(t);
  assert.deepEqual(await detectVcs(path.join(root, "src")), { kind: "jj", root });
  const first = await api.createTaskWorkspace(path.join(root, "src"), root, root, { id: "T01" }, base);
  assert.equal(await api.getJjWorkspaceRoot(first.cwd), first.rootPath);
  assert.equal(await api.getMainJjWorkspaceRoot(first.rootPath), root);
  assert.equal(first.cwd, path.join(first.rootPath, "src"));
  await fs.writeFile(path.join(first.cwd, "one.txt"), "one\n");
  await jj(first.cwd, "commit", "-m", "T01");
  const validated = await api.validateTaskWorkspaceCommit(first);
  assert.ok(validated.commitId);
  const integrated = await api.integrateTaskWorkspace(root, first, { status: "done", workspacePath: first.rootPath }, base);
  assert.equal(integrated.result.status, "done");
  await assert.rejects(fs.stat(first.rootPath), { code: "ENOENT" });
  const dependent = await api.createTaskWorkspace(root, root, root, { id: "T02" }, integrated.integratedHead);
  assert.equal(await fs.readFile(path.join(dependent.rootPath, "src/one.txt"), "utf8"), "one\n");
});

test("jj validation rejects dirty, empty and multiple-commit builders; unsuccessful workspaces remain", async (t) => {
  const { root, api, base } = await fixture(t);
  const dirty = await api.createTaskWorkspace(root, root, root, { id: "T01" }, base);
  await fs.writeFile(path.join(dirty.rootPath, "dirty.txt"), "dirty");
  await assert.rejects(api.validateTaskWorkspaceCommit(dirty), /uncommitted changes/);
  const retained = await api.integrateTaskWorkspace(root, dirty, { status: "done", workspacePath: dirty.rootPath }, base);
  assert.equal(retained.result.status, "failed");
  assert.ok(await fs.stat(dirty.rootPath));
  const empty = await api.createTaskWorkspace(root, root, root, { id: "T02" }, base);
  await jj(empty.cwd, "commit", "-m", "empty");
  await assert.rejects(api.validateTaskWorkspaceCommit(empty), /empty/);
  const multiple = await api.createTaskWorkspace(root, root, root, { id: "T03" }, base);
  for (const name of ["one", "two"]) {
    await fs.writeFile(path.join(multiple.rootPath, name), name);
    await jj(multiple.cwd, "commit", "-m", name);
  }
  await assert.rejects(api.validateTaskWorkspaceCommit(multiple), /found 2/);
});

test("jj builders cannot commit plan state", async (t) => {
  const { root, api, base } = await fixture(t);
  const task = await api.createTaskWorkspace(root, root, root, { id: "T01" }, base);
  await fs.writeFile(path.join(task.rootPath, "plan.md"), "builder status edit");
  await jj(task.cwd, "commit", "-m", "invalid plan edit");
  await assert.rejects(api.validateTaskWorkspaceCommit(task, ["plan.md"]), /plan\/report state/);
});

test("jj shared scheduler preserves the runner's updated plan across workspace movement", async (t) => {
  const { root, api } = await fixture(t);
  const planPath = path.join(root, "plan.md");
  await fs.writeFile(planPath, "### Task T01: Add file\nStatus: pending\nDepends on: none\nFiles:\n- task.txt\n");
  api.setRunAgent(() => { throw new Error("One-shot agents were not requested"); });
  let child: ScriptedBuilderTransport | undefined;
  api.setBuilderTransport((options: RpcAgentOptions) => {
    child = new ScriptedBuilderTransport(options, async (transport, prompt) => {
      assert.match(prompt, /Use Jujutsu/);
      await fs.writeFile(path.join(options.cwd, "task.txt"), "task\n");
      await jj(options.cwd, "commit", "-m", "T01");
      transport.message();
      transport.settle();
    });
    return child;
  });
  const result = await api.buildPlanFile({ cwd: root, hasUI: false }, {
    path: planPath, model: "fixture", effort: "off", builderMonitor: false,
  });
  assert.match(result.text, /1 done, 0 failed, 0 blocked/);
  assert.equal(child?.stopped, true);
  assert.equal(await fs.readFile(path.join(root, "task.txt"), "utf8"), "task\n");
  assert.match(await fs.readFile(planPath, "utf8"), /Status: done/);
});

test("jj conflicted rebase retains task workspace and does not advance integrated head", async (t) => {
  const { root, api, base } = await fixture(t);
  const left = await api.createTaskWorkspace(root, root, root, { id: "T01" }, base);
  const right = await api.createTaskWorkspace(root, root, root, { id: "T02" }, base);
  for (const task of [left, right]) {
    await fs.writeFile(path.join(task.rootPath, "src/base.txt"), `${task.name}\n`);
    await jj(task.cwd, "commit", "-m", task.name);
  }
  const first = await api.integrateTaskWorkspace(root, left, { status: "done", workspacePath: left.rootPath }, base);
  const conflict = await api.integrateTaskWorkspace(root, right, { status: "done", workspacePath: right.rootPath }, first.integratedHead);
  assert.equal(conflict.result.status, "blocked");
  assert.equal(conflict.integratedHead, first.integratedHead);
  assert.ok(await fs.stat(right.rootPath));
});

/** Only fake executables are injected: scheduler, builder lifecycle, controller,
 * supervisor, bridge, RPC pipes, validation and jj integration are production. */
async function supervisedFixture(t: TestContext, jobs: Record<string, unknown>, mode: "auto" | "manual" = "auto") {
  const { root } = await fixture(t);
  const parent = path.dirname(root);
  const childPath = fileURLToPath(new URL("./fixtures/planner-builder-rpc-child.mjs", import.meta.url));
  const script = path.join(parent, "script.json");
  await fs.writeFile(script, JSON.stringify({ root: parent, vcs: "jj", mode, jobs, supervisor: { action: mode === "auto" ? "steer" : "none" } }));
  const credentials = path.join(parent, "empty-agent");
  await fs.mkdir(credentials);
  const env = { PATH: process.env.PATH, HOME: parent, PI_CODING_AGENT_DIR: credentials };
  const children: Array<{ rpc: RpcAgent; options: RpcAgentOptions; joined: boolean; records: RpcRecord[] }> = [];
  let controller!: BuildController;
  function getInvocation(args: string[]) { return { command: process.execPath, args: [childPath, "supervised", script, ...args] }; }
  function createTransport(options: RpcAgentOptions): RpcAgent {
    const rpc = new RpcAgent({ ...options, invocation: getInvocation(options.invocation.args.slice(options.invocation.args.indexOf("--mode"))),
      env: { ...env, PI_SUBAGENT_NAME: options.env.PI_SUBAGENT_NAME } });
    const child = { rpc, options, joined: false, records: [] as RpcRecord[] };
    rpc.onRecord((record) => { child.records.push(record); });
    void rpc.closed.then(() => { child.joined = true; });
    children.push(child);
    return rpc;
  }
  const api = loadPlannerBuilder(path.join(parent, "tasks"), {
    discoverAgents: () => ({ agents: ["builder", "supervisor"].map((name) => ({ name, source: "user", systemPrompt: "" })) }),
    BuildController: class extends BuildController {
      constructor(options: BuildControllerOptions) { super(options); controller = this; }
    },
    startSupervisor: (options: SupervisorOptions) => startSupervisor({ ...options, dependencies: { env, getInvocation, createTransport } }),
    spawn(command: string, args: string[], options: any) {
      assert.equal(command, "jj", "verifier is disabled; no real model may launch");
      const child = children.find((child) => child.options.cwd === options.cwd);
      if (child) {
        assert.equal(child.joined, true, "jj validation/integration must not run while the builder is owned");
        const task = controller.inspectBuild().tasks.find((task) => task.workspacePath === options.cwd)!;
        assert.equal(controller.inspectTask(task).readyForIntegration, true);
        assert.equal(controller.inspectTask(task).admissionOpen, false);
      }
      return spawn(command, args, options);
    },
  });
  api.setBuilderTransport(createTransport);
  t.after(async () => { await controller?.cancelBuild(); await Promise.all(children.map((child) => child.rpc.stop())); });
  const planPath = path.join(root, "plan.md");
  async function build(tasks: Array<{ id: string; file: string; depends?: string }>) {
    await fs.writeFile(planPath, tasks.map(({ id, file, depends }) => `### Task ${id}: Implement ${file}\nStatus: pending\nDepends on: ${depends ?? "none"}\nFiles:\n- ${file}\nInstructions:\n- Preserve source configuration; change only ${file}.\n`).join("\n"));
    return api.buildPlanFile({ cwd: root, hasUI: false }, { path: planPath, model: "fixture", effort: "off", builderMonitor: false,
      maxConcurrency: 2, supervisionMode: "steer", supervisionOptions: { intervalSeconds: 1, cooldownSeconds: 0, checkpointSeconds: 3 } });
  }
  async function assertRetainedSessions(result: any): Promise<void> {
    for (const child of children) {
      assert.equal(child.joined, true);
      assert.equal(child.rpc.state.pendingRequests + child.rpc.state.completionWaiters + child.rpc.state.pendingUi + child.rpc.state.queuedWrites, 0);
      if (child.options.env.PI_SUBAGENT_NAME === "supervisor") {
        const args = child.options.invocation.args;
        await assert.rejects(fs.stat(path.dirname(args[args.indexOf("--extension") + 1])), { code: "ENOENT" });
        await assert.rejects(fs.stat(child.options.cwd), { code: "ENOENT" });
      }
    }
    const rows = (await fs.readFile(result.details.supervision.journalPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const mappings = rows.filter((row) => row.kind === "session");
    assert.ok(mappings.some((mapping) => mapping.role === "supervisor"));
    for (const mapping of mappings) {
      assert.ok(mapping.sessionFile.startsWith(result.details.supervision.runDirectory));
      assert.match(await fs.readFile(mapping.sessionFile, "utf8"), new RegExp(mapping.sessionId));
      if (mapping.role === "builder") {
        assert.ok(rows.some((row) => row.kind === "attempt" && row.attemptId === mapping.attemptId && row.taskId === mapping.taskId));
      }
    }
  }
  return { root, api, planPath, children, build, assertRetainedSessions };
}

test("supervised jj dependency waves preserve pre-existing modified/deleted/added configuration bytes outside task commit diffs", { timeout: 30_000 }, async (t) => {
  const f = await supervisedFixture(t, {
    T01: { files: { "one.txt": "one\n" } }, T02: { files: { "two.txt": "two\n" } },
    T03: { requires: ["one.txt", "two.txt"], files: { "three.txt": "three\n" } },
  });
  // Reproduce the observed categories using disposable bytes, never live Pi/MCP
  // settings. Seed tracked files before introducing the unrelated working edits.
  const modified = {
    "claude/.claude/settings.json": Buffer.from('{"fixture":"modified claude 雪"}\r\n'),
    "pi/.pi/agent/settings.json": Buffer.from('{"fixture":"modified pi"}\n'),
  };
  const deleted = ["pi/.pi/agent/extensions/linear_mcp.ts", "pi/.pi/agent/extensions/mcp_bridge/bridge.ts", "pi/.pi/agent/extensions/pulumi_mcp.ts"];
  const added = "pi/.pi/agent/mcp.json";
  for (const file of [...Object.keys(modified), ...deleted]) {
    await fs.mkdir(path.dirname(path.join(f.root, file)), { recursive: true });
    await fs.writeFile(path.join(f.root, file), "tracked fixture baseline\n");
  }
  await jj(f.root, "commit", "-m", "tracked configuration fixture");
  const preserved = { ...modified, [added]: Buffer.from('{"fixture":"added config, no servers"}\n') };
  for (const [file, bytes] of Object.entries(preserved)) await fs.writeFile(path.join(f.root, file), bytes);
  for (const file of deleted) await fs.unlink(path.join(f.root, file));
  const before = await jj(f.root, "diff", "--summary");
  for (const file of Object.keys(modified)) assert.ok(before.includes(`M ${file}`));
  for (const file of deleted) assert.ok(before.includes(`D ${file}`));
  assert.ok(before.includes(`A ${added}`));

  const result = await f.build([{ id: "T01", file: "one.txt" }, { id: "T02", file: "two.txt" }, { id: "T03", file: "three.txt", depends: "T01, T02" }]);
  assert.match(result.text, /3 done, 0 failed, 0 blocked/, `${await fs.readFile(f.planPath, "utf8")}\n${f.children.map((child) => child.rpc.stderr).join("\n")}`);
  assert.match(result.text, /Verifier skipped \(not requested\)/);
  assert.equal(result.details.supervision.disableReason, undefined);
  for (const [file, bytes] of Object.entries(preserved)) assert.deepEqual(await fs.readFile(path.join(f.root, file)), bytes, file);
  for (const file of deleted) await assert.rejects(fs.stat(path.join(f.root, file)), { code: "ENOENT" });
  const commits: string[] = [];
  for (const [task, file] of [["T01", "one.txt"], ["T02", "two.txt"], ["T03", "three.txt"]]) {
    const commit = await jj(f.root, "log", "--no-graph", "-r", `description(exact:${JSON.stringify(`${task}\n`)})`, "-T", 'commit_id ++ "\\n"');
    assert.match(commit, /^[a-f0-9]{40}$/); // Exactly one task commit, not empty or duplicated.
    commits.push(commit);
    assert.equal(await jj(f.root, "diff", "-r", commit, "--summary"), `A ${file}`);
  }
  for (const ancestor of commits.slice(0, 2)) {
    assert.equal(await jj(f.root, "log", "--no-graph", "-r", `${ancestor} & ancestors(${commits[2]})`, "-T", "commit_id"), ancestor);
  }
  for (const child of f.children.filter((child) => child.options.env.PI_SUBAGENT_NAME === "builder")) await assert.rejects(fs.stat(child.options.cwd), { code: "ENOENT" });
  assert.ok(result.details.supervision.attempts.every((attempt: any) => attempt.controls.some((control: any) => control.status === "delivered")));
  await f.assertRetainedSessions(result);
});

test("supervised jj retains failed tasks and rejects protected plan/report commits", { timeout: 30_000 }, async (t) => {
  const f = await supervisedFixture(t, {
    T01: { result: "failed", files: { "failed.txt": "retained\n" } },
    T02: { files: { "plan.md": "forbidden plan rewrite\n" } },
    T03: { files: { ".pi/outputs/findings.html": "forbidden report\n" } },
  });
  const result = await f.build([{ id: "T01", file: "failed.txt" }, { id: "T02", file: "plan.md" }, { id: "T03", file: ".pi/outputs/findings.html" }]);
  assert.match(result.text, /0 done, 3 failed/);
  assert.match(await fs.readFile(f.planPath, "utf8"), /plan\/report state/);
  for (const file of ["failed.txt", ".pi/outputs/findings.html"]) await assert.rejects(fs.stat(path.join(f.root, file)), { code: "ENOENT" });
  for (const child of f.children.filter((child) => child.options.env.PI_SUBAGENT_NAME === "builder")) {
    assert.ok(await fs.stat(child.options.cwd));
    const commits = await jj(child.options.cwd, "log", "--no-graph", "-r", "@-", "-T", "description");
    assert.match(commits, /^T0[123]$/);
    assert.notEqual(await jj(child.options.cwd, "diff", "-r", "@-", "--summary"), "");
    assert.equal(await jj(child.options.cwd, "diff", "--summary"), "");
  }
  await f.assertRetainedSessions(result);
});

test("jj source status snapshots while real builders run cannot rewrite their shared task base", { timeout: 30_000 }, async (t) => {
  const f = await supervisedFixture(t, {
    T01: { files: { "one.txt": "one\n" } }, T02: { files: { "two.txt": "two\n" } },
  }, "manual");
  const work = f.build([{ id: "T01", file: "one.txt" }, { id: "T02", file: "two.txt" }]);
  const builders = () => f.children.filter((child) => child.options.env.PI_SUBAGENT_NAME === "builder");
  const deadline = Date.now() + 10_000;
  while (builders().length !== 2 || builders().some((child) => !child.records.some((record) => record.type === "agent_start"))) {
    assert.ok(Date.now() < deadline, "both real builders must reach their running turn");
    await delay(5);
  }
  const base = await jj(f.root, "--ignore-working-copy", "log", "--no-graph", "-r", "@-", "-T", "commit_id");
  const before = await jj(f.root, "--ignore-working-copy", "log", "--no-graph", "-r", "@", "-T", "commit_id");
  assert.notEqual(before, base, "source must already be on a sibling of the task changes");
  const taskHeads = [];
  for (const child of builders()) {
    assert.equal(child.joined, false);
    assert.equal(child.rpc.state.isSettled, false);
    taskHeads.push(await jj(child.options.cwd, "--ignore-working-copy", "log", "--no-graph", "-r", "@", "-T", "commit_id"));
    assert.equal(await jj(child.options.cwd, "--ignore-working-copy", "log", "--no-graph", "-r", "@-", "-T", "commit_id"), base);
  }
  assert.equal((await fs.readFile(f.planPath, "utf8")).match(/^Status: in-progress$/gm)?.length, 2);
  // Snapshot the runner's already-written status updates, without editing its plan.
  await jj(f.root, "status");
  assert.notEqual(await jj(f.root, "log", "--no-graph", "-r", "@", "-T", "commit_id"), before);
  assert.equal(await jj(f.root, "log", "--no-graph", "-r", "@-", "-T", "commit_id"), base);
  for (const [index, child] of builders().entries()) {
    await jj(child.options.cwd, "status"); // Must not require workspace update-stale.
    assert.equal(await jj(child.options.cwd, "log", "--no-graph", "-r", "@", "-T", "commit_id"), taskHeads[index]);
    assert.equal(await jj(child.options.cwd, "log", "--no-graph", "-r", "@-", "-T", "commit_id"), base);
  }
  await Promise.all(builders().map((child) => child.rpc.request("fixture", { action: "finish" })));
  const result = await work;
  assert.match(result.text, /2 done, 0 failed, 0 blocked/);
  await f.assertRetainedSessions(result);
});

for (const runVerifier of [false, true]) {
  test(`jj ${runVerifier ? "verify-only" : "no-op"} build leaves the source working-copy commit unchanged`, { timeout: 30_000 }, async (t) => {
    const { root } = await fixture(t);
    const planPath = path.join(root, "plan.md");
    await fs.writeFile(planPath, "### Task T01: Already complete\nStatus: done\nDepends on: none\nFiles:\n- task.txt\n");
    const before = await jj(root, "log", "--no-graph", "-r", "@", "-T", "commit_id");
    let verifierLaunches = 0;
    const api = loadPlannerBuilder(path.join(path.dirname(root), "tasks"), {
      spawn(command: string, args: string[], options: any) {
        if (command === "jj") return spawn(command, args, options);
        assert.equal(runVerifier, true);
        assert.equal(options.env.PI_SUBAGENT_NAME, "verifier");
        assert.equal(args[args.indexOf("--mode") + 1], "json");
        verifierLaunches++;
        // Keep runAgent() intact, substituting only a disposable, credential-free
        // one-shot executable. No builder transport is involved in this path.
        const record = { type: "message_end", message: { role: "assistant", stopReason: "stop",
          content: [{ type: "text", text: "Fixture verification complete." }] } };
        return spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(record) + "\n")})`],
          { ...options, env: { HOME: path.dirname(root), PATH: process.env.PATH } });
      },
    });
    api.setBuilderTransport(() => { throw new Error("No runnable tasks may launch builders"); });
    const result = await api.buildPlanFile({ cwd: root, hasUI: false }, {
      path: planPath, model: "fixture", effort: "off", builderMonitor: false, runVerifier,
    });
    assert.match(result.text, /0 done, 0 failed, 0 blocked/);
    assert.match(result.text, runVerifier ? /Verifier finished/ : /Verifier skipped \(not requested\)/);
    assert.equal(verifierLaunches, Number(runVerifier));
    assert.equal(await jj(root, "log", "--no-graph", "-r", "@", "-T", "commit_id"), before);
  });
}
