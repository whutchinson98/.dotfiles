import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fixture, git } from "./planner-builder-fixtures.ts";
import { loadPlannerBuilder } from "./planner-builder-harness.ts";

const plan = `# Build fixture
## Builder Tasks
### Task T01: First independent task
Status: pending
Depends on: none
Files:
- one.txt
Instructions:
- Create one.txt.
### Task T02: Second independent task
Status: pending
Depends on: none
Files:
- two.txt
Instructions:
- Create two.txt.
### Task T03: Dependent task
Status: pending
Depends on: T01, T02
Files:
- three.txt
Instructions:
- Create three.txt.
`;

function success(agent: string, cwd: string): Record<string, unknown> {
  return {
    agent, agentSource: "user", task: "synthetic builder", cwd,
    exitCode: 0, finalOutput: "PLAN_TASK_RESULT: done", stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };
}

test("shared scheduler runs independent Git builders concurrently, then updated dependency wave and explicit-base verifier", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.plan, plan);
  const api = loadPlannerBuilder(path.join(f.parent, "tasks"));
  const initialHead = await git(f.root, "rev-parse", "HEAD");
  let started = 0;
  let release: () => void = () => {};
  const bothStarted = new Promise<void>((resolve) => { release = resolve; });
  let verifierPrompt = "";
  api.setRunAgent(async (cwd: string, _agents: unknown[], agent: string, prompt: string) => {
    if (agent === "verifier") {
      verifierPrompt = prompt;
      assert.notEqual(await git(cwd, "rev-parse", "HEAD"), initialHead);
      return success(agent, cwd);
    }
    const taskId = prompt.match(/Assigned task: (T\d+)/)?.[1];
    assert.match(prompt, /dedicated Git worktree/);
    assert.doesNotMatch(prompt, /Use Jujutsu/);
    started++;
    if (taskId !== "T03") {
      assert.equal(await git(cwd, "rev-parse", "HEAD"), initialHead);
      if (started === 2) release();
      await bothStarted;
    } else {
      assert.equal(started, 3);
      assert.equal(await fs.readFile(path.join(cwd, "one.txt"), "utf8"), "T01");
      assert.equal(await fs.readFile(path.join(cwd, "two.txt"), "utf8"), "T02");
      assert.equal(await git(cwd, "rev-list", "--count", `${initialHead}..HEAD`), "2");
    }
    const file = { T01: "one.txt", T02: "two.txt", T03: "three.txt" }[taskId!];
    await fs.writeFile(path.join(cwd, file!), taskId!);
    await git(cwd, "add", file!);
    await git(cwd, "commit", "-m", taskId!);
    return success(agent, cwd);
  });
  const ctx = { cwd: f.root, hasUI: false };
  const params = { path: f.plan, model: "test", effort: "off", builderMonitor: false, runVerifier: true };
  const result = await api.buildPlanFile(ctx, params);
  assert.match(result.text, /3 done, 0 failed, 0 blocked/);
  const updatedPlan = await fs.readFile(f.plan, "utf8");
  assert.equal((updatedPlan.match(/^Status: done$/gm) ?? []).length, 3);
  assert.match(updatedPlan, /Recovery record:/);
  assert.match(updatedPlan, /Commit:/);
  assert.match(verifierPrompt, new RegExp(`Explicit review base: ${initialHead}`));
  await api.buildPlanFile(ctx, params);
  assert.equal(started, 3);
  assert.match(verifierPrompt, new RegExp(`Explicit review base: ${initialHead}`));
});

for (const failure of ["source-edits", "cancel"]) {
  test(`scheduler ${failure} leaves durable done-task recovery and does not run verifier`, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(f.plan, plan.split("### Task T02")[0]);
    const api = loadPlannerBuilder(path.join(f.parent, "tasks"));
    const initialHead = await git(f.root, "rev-parse", "HEAD");
    const controller = new AbortController();
    api.setRunAgent(async (cwd: string, _agents: unknown[], agent: string) => {
      assert.equal(agent, "builder");
      await fs.writeFile(path.join(cwd, "one.txt"), "task");
      await git(cwd, "add", "one.txt");
      await git(cwd, "commit", "-m", "task");
      if (failure === "cancel") controller.abort();
      else await fs.writeFile(path.join(f.root, "user.txt"), "unsaved work");
      return success(agent, cwd);
    });
    await assert.rejects(api.buildPlanFile({ cwd: f.root, hasUI: false }, {
      path: f.plan, model: "test", effort: "off", builderMonitor: false, runVerifier: true,
    }, controller.signal), /Recovery record:/);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), initialHead);
    const updated = await fs.readFile(f.plan, "utf8");
    assert.match(updated, /Status: done/);
    const recovery = updated.match(/Recovery record: (.+?\.json)/)?.[1];
    assert.ok(recovery);
    const record = JSON.parse(await fs.readFile(recovery, "utf8"));
    assert.equal(record.state, "running");
    assert.ok(await fs.stat(record.integration.rootPath));
    assert.equal(record.tasks[0].status, "integrated");
  });
}

test("scheduler parsing, overlap selection, result markers and prompts remain compatible", () => {
  const api = loadPlannerBuilder("/unused");
  const tasks = api.parsePlanTasks(plan);
  assert.equal(tasks.length, 3);
  assert.equal(tasks[2].dependsOn.join(","), "T01,T02");
  assert.equal(api.selectParallelTaskBatch(tasks, 2).length, 2);
  const overlapping = { ...tasks[1], block: tasks[1].block.replace("two.txt", "one.txt") };
  assert.equal(api.selectParallelTaskBatch([tasks[0], overlapping], 4).length, 1);
  assert.equal(api.classifyBuilderResult({ exitCode: 0, finalOutput: "no marker" }).status, "done");
  assert.equal(api.classifyBuilderResult({ exitCode: 0, finalOutput: "```\nPLAN_TASK_RESULT: failed\n```\nPLAN_TASK_RESULT: done" }).status, "done");
  assert.equal(api.classifyBuilderResult({ exitCode: 0, finalOutput: "PLAN_TASK_RESULT: blocked" }).status, "blocked");
  const jjPrompt = api.createBuilderTask("plan.md", tasks[0], plan);
  assert.match(jjPrompt, /jj commit/);
  assert.match(jjPrompt, /Use Jujutsu/);
  assert.match(jjPrompt, /Never edit or commit the plan/);
  assert.match(api.createVerifierTask("plan.md", [], "jj", "main"), /Explicit review base: main/);
  assert.match(api.createPlannerTask("task", "builder"), /locally committed/);
});
