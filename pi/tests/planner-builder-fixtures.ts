import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { GitBackend, type TaskWorkspace } from "../.pi/agent/extensions/planner-builder/vcs.ts";

const exec = promisify(execFile);
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
    cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  return stdout.trim();
}
export async function fixture(t: TestContext, unborn = false): Promise<{ root: string; parent: string; plan: string; start: (cwd?: string) => Promise<GitBackend> }> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "pi-plan-git-test-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "source");
  await fs.mkdir(root);
  await git(root, "init", "-b", "feature");
  await git(root, "config", "user.name", "Fixture");
  await git(root, "config", "user.email", "fixture@example.invalid");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/base.txt"), "base\n");
  const plan = path.join(root, "plan.md");
  await fs.writeFile(plan, "plan\n");
  if (!unborn) {
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial source (local only)");
  }
  return { root, parent, plan, start: (cwd = root) => GitBackend.start(cwd, root, plan, path.join(parent, "worktrees")) };
}
export async function commitFile(workspace: TaskWorkspace, file: string, text = "task\n"): Promise<string> {
  await fs.mkdir(path.dirname(path.join(workspace.rootPath, file)), { recursive: true });
  await fs.writeFile(path.join(workspace.rootPath, file), text);
  await git(workspace.rootPath, "add", "--", file);
  await git(workspace.rootPath, "commit", "-m", `implement ${file}`);
  return git(workspace.rootPath, "rev-parse", "HEAD");
}
