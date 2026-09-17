import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { detectVcs } from "../.pi/agent/extensions/planner-builder/vcs.ts";
import { loadPlannerBuilder } from "./planner-builder-harness.ts";

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
  api.setRunAgent(async (cwd: string, _agents: unknown[], agent: string, prompt: string) => {
    assert.match(prompt, /Use Jujutsu/);
    await fs.writeFile(path.join(cwd, "task.txt"), "task\n");
    await jj(cwd, "commit", "-m", "T01");
    return { agent, cwd, exitCode: 0, stderr: "", finalOutput: "PLAN_TASK_RESULT: done", usage: {} };
  });
  const result = await api.buildPlanFile({ cwd: root, hasUI: false }, {
    path: planPath, model: "fixture", effort: "off", builderMonitor: false,
  });
  assert.match(result.text, /1 done, 0 failed, 0 blocked/);
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
