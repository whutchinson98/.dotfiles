import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type VcsKind = "jj" | "git";
export interface TaskWorkspace {
  name: string;
  rootPath: string;
  cwd: string;
  baseRevision: string;
}
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<CommandResult>;

export function runVcsCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
    // An inherited index/repository override must not redirect worktree operations.
    for (const key of Object.keys(env)) {
      if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(key)) delete env[key];
    }
    const proc = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => { stdout += chunk; });
    proc.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-20_000); });
    proc.on("error", (error) => resolve({ exitCode: 1, stdout, stderr: error.message }));
    proc.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Stop at the nearest checkout boundary; .jj wins only at that boundary. */
export async function detectVcs(cwd: string, run: CommandRunner = runVcsCommand): Promise<{ kind: VcsKind; root: string }> {
  let root = await fs.realpath(cwd);
  while (true) {
    if (await exists(path.join(root, ".jj"))) {
      const result = await run("jj", ["--no-pager", "--ignore-working-copy", "log", "--no-graph", "-r", "@", "-T", "commit_id"], root);
      if (result.exitCode !== 0 || !result.stdout.trim()) {
        throw new Error(`Found .jj at ${root}, but jj cannot open it. Repair Jujutsu or install jj; Git fallback is disabled.\n${result.stderr}`);
      }
      return { kind: "jj", root };
    }
    if (await exists(path.join(root, ".git"))) {
      const result = await run("git", ["rev-parse", "--show-toplevel"], root);
      if (result.exitCode !== 0 || result.stdout.trim() !== root) {
        throw new Error(`Cannot open Git checkout at ${root}. Repair its .git metadata.\n${result.stderr}`);
      }
      return { kind: "git", root };
    }
    const parent = path.dirname(root);
    if (parent === root) throw new Error("No .jj or .git checkout found. Run plan_file_build inside a Jujutsu workspace or a Git feature branch with locally committed source changes.");
    root = parent;
  }
}

interface TaskRecord extends TaskWorkspace {
  status: "created" | "validated" | "integrated" | "failed";
  commitId?: string;
  integratedCommit?: string;
  error?: string;
}
interface RecoveryRecord {
  sourceRoot: string;
  sourceBranch: string;
  planPath: string;
  initialHead: string;
  reviewBase: string;
  integratedHead: string;
  integration: TaskWorkspace;
  state: "running" | "finalized" | "recovered";
  tasks: TaskRecord[];
  recovery: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isInside(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Git owns only its temporary branches/worktrees. The source is never reset or stashed. */
export class GitBackend {
  readonly root: string;
  readonly initialHead: string;
  readonly reviewBase: string;
  readonly recoveryPath: string;
  readonly integration: TaskWorkspace;
  private readonly run: CommandRunner;
  private readonly record: RecoveryRecord;
  private readonly relativeCwd: string;
  private readonly protectedPaths: Set<string>;

  private constructor(record: RecoveryRecord, recoveryPath: string, cwd: string, run: CommandRunner) {
    this.record = record;
    this.root = record.sourceRoot;
    this.initialHead = record.initialHead;
    this.reviewBase = record.reviewBase;
    this.integration = record.integration;
    this.recoveryPath = recoveryPath;
    this.relativeCwd = path.relative(this.root, cwd);
    this.run = run;
    this.protectedPaths = new Set([".pi/outputs/findings.html"]);
    if (isInside(this.root, record.planPath)) this.protectedPaths.add(path.relative(this.root, record.planPath));
  }

  static async start(cwd: string, root: string, planPath: string, workspaceParent: string, run: CommandRunner = runVcsCommand): Promise<GitBackend> {
    const sourceRoot = await fs.realpath(root);
    const canonicalCwd = await fs.realpath(cwd);
    const canonicalPlan = await fs.realpath(planPath);
    const git = async (args: string[]): Promise<string> => {
      const result = await run("git", args, sourceRoot);
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
      return result.stdout.trim();
    };
    const branch = await git(["symbolic-ref", "--quiet", "HEAD"]).catch(() => {
      throw new Error("Git HEAD is detached. Switch to a feature branch before building.");
    });
    const initialHead = await git(["rev-parse", "--verify", "HEAD^{commit}"]).catch(() => {
      throw new Error("Git branch is unborn. Commit source changes locally before building (no push required).");
    });
    const commonDir = path.resolve(sourceRoot, await git(["rev-parse", "--git-common-dir"]));
    const journalDir = path.join(commonDir, "pi-planner-builder");
    await fs.mkdir(journalDir, { recursive: true });
    // Serialize discovery + journal creation across Pi processes, not just tool calls.
    const lockPath = path.join(journalDir, "start.lock");
    const lock = await fs.open(lockPath, "wx").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") {
        throw new Error(`Git build startup is locked: ${lockPath}. Inspect its PID and recovery JSON files. Only remove a stale lock after confirming that process is no longer running.`);
      }
      throw error;
    });
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, sourceRoot, startedAt: new Date().toISOString() }));
      let reviewBase = initialHead;
      for (const entry of (await fs.readdir(journalDir)).sort()) {
        if (!entry.endsWith(".json")) continue;
        const previous = JSON.parse(await fs.readFile(path.join(journalDir, entry), "utf8")) as RecoveryRecord;
        if (previous.sourceRoot !== sourceRoot) continue;
        if (previous.state === "running") {
          throw new Error(`An unfinished Git build needs recovery before another build. Inspect ${path.join(journalDir, entry)}.\n${previous.recovery}`);
        }
        if (previous.planPath === canonicalPlan) reviewBase = previous.reviewBase;
      }
      const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      const runDirectory = path.join(workspaceParent, `git-${id}`);
      await fs.mkdir(workspaceParent, { recursive: true });
      if (isInside(sourceRoot, await fs.realpath(workspaceParent))) {
        throw new Error("PI_PLAN_WORKSPACE_ROOT must be outside the source checkout for Git builds.");
      }
      const integration: TaskWorkspace = {
        name: `pi-plan/${id}/integration`, rootPath: path.join(runDirectory, "integration"),
        cwd: path.join(runDirectory, "integration"), baseRevision: initialHead,
      };
      const recoveryPath = path.join(journalDir, `${id}.json`);
      const record: RecoveryRecord = {
        sourceRoot, sourceBranch: branch, planPath: canonicalPlan, initialHead, reviewBase,
        integratedHead: initialHead, integration, state: "running", tasks: [], recovery: "",
      };
      const backend = new GitBackend(record, recoveryPath, canonicalCwd, run);
      await backend.assertSourceSafe();
      record.recovery = backend.recoveryInstructions();
      await backend.save(); // Record paths before any worktree or branch can be created.
      try {
        await fs.mkdir(runDirectory);
        await backend.git(sourceRoot, ["worktree", "add", "-b", integration.name, integration.rootPath, initialHead]);
      } catch (error) {
        throw new Error(`${errorText(error)}\n${backend.recoveryInstructions()}`);
      }
      return backend;
    } finally {
      await lock.close();
      await fs.unlink(lockPath);
    }
  }

  recoveryInstructions(): string {
    return [
      `Recovery record: ${this.recoveryPath}. Integration branch: ${this.integration.name}; worktree: ${this.integration.rootPath}.`,
      `Inspect with git -C ${shellQuote(this.integration.rootPath)} status and git -C ${shellQuote(this.root)} log --oneline ${shellQuote(this.integration.name)}.`,
      `After reviewing retained task worktrees, finishing any integration operation, and safely saving your own edits, on ${this.record.sourceBranch} run git -C ${shellQuote(this.root)} merge --ff-only --no-autostash ${shellQuote(this.integration.name)}.`,
      `If histories diverged, reconcile manually; never reset user work. Reconcile plan statuses against recovered commits, then set state to "recovered" in the recovery JSON to allow another run.`,
    ].join("\n");
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const result = await this.run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], cwd);
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    return result.stdout;
  }
  private async head(cwd: string): Promise<string> {
    return (await this.git(cwd, ["rev-parse", "HEAD"])).trim();
  }
  private async save(): Promise<void> {
    const temporary = `${this.recoveryPath}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.record, null, 2)}\n`, { mode: 0o600, flush: true });
    await fs.rename(temporary, this.recoveryPath);
  }
  private async assertNoOperation(cwd: string): Promise<void> {
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG", "index.lock"]) {
      const operationPath = (await this.git(cwd, ["rev-parse", "--git-path", name])).trim();
      if (await exists(path.resolve(cwd, operationPath))) throw new Error(`Finish the in-progress Git operation (${name}) in ${cwd} first.`);
    }
  }
  private async assertClean(cwd: string, allowOutput = false, includeIgnored = false): Promise<void> {
    const flags = await this.git(cwd, ["ls-files", "-v", "-z"]);
    if (flags.split("\0").some((entry) => entry && (entry[0] === "S" || entry[0] === entry[0].toLowerCase()))) {
      throw new Error(`Clear skip-worktree/assume-unchanged flags (including sparse checkout) in ${cwd} so cleanliness can be verified.`);
    }
    const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"];
    if (includeIgnored) args.push("--ignored");
    const entries = (await this.git(cwd, args)).split("\0").filter(Boolean);
    for (const entry of entries) {
      const status = entry.slice(0, 2);
      const file = entry.slice(3);
      // Renames, conflicts and deletions are never runner output updates.
      if (allowOutput && this.protectedPaths.has(file) && /^(\?\?|[ AM]{2})$/.test(status)) continue;
      throw new Error(`Git checkout/index is dirty: ${JSON.stringify(entry)} in ${cwd}. Commit source changes locally (including untracked files); no push is needed. Only the active plan and .pi/outputs/findings.html are exempt.`);
    }
  }
  private async assertSourceSafe(): Promise<void> {
    await this.assertNoOperation(this.root);
    await this.assertClean(this.root, true);
    if ((await this.git(this.root, ["symbolic-ref", "--quiet", "HEAD"])).trim() !== this.record.sourceBranch) {
      throw new Error("Source branch changed during the build; refusing to advance it.");
    }
    if (await this.head(this.root) !== this.initialHead) throw new Error("Source HEAD changed during the build; refusing to advance it.");
  }

  async createWorkspace(taskId: string): Promise<TaskWorkspace> {
    const baseRevision = this.record.integratedHead;
    await this.assertIntegrationSafe();
    const suffix = `${taskId.replace(/[^a-zA-Z0-9_-]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const rootPath = path.join(path.dirname(this.integration.rootPath), suffix);
    const workspace: TaskRecord = {
      name: `${this.integration.name.replace(/integration$/, "task")}-${suffix}`,
      rootPath, cwd: path.join(rootPath, this.relativeCwd), baseRevision, status: "created",
    };
    this.record.tasks.push(workspace);
    await this.save();
    await this.git(this.root, ["worktree", "add", "-b", workspace.name, rootPath, baseRevision]);
    await fs.mkdir(workspace.cwd, { recursive: true });
    return workspace;
  }

  async validate(workspace: TaskWorkspace): Promise<string> {
    await this.assertNoOperation(workspace.rootPath);
    await this.assertClean(workspace.rootPath);
    if ((await this.git(workspace.rootPath, ["symbolic-ref", "--quiet", "HEAD"])).trim() !== `refs/heads/${workspace.name}`) {
      throw new Error("Builder switched branches; leave the assigned task branch attached.");
    }
    const commitId = await this.head(workspace.rootPath);
    const parents = (await this.git(workspace.rootPath, ["show", "-s", "--format=%P", commitId])).trim().split(/\s+/);
    if (parents.length !== 1 || parents[0] !== workspace.baseRevision) {
      throw new Error(`Expected exactly one task commit with direct single parent ${workspace.baseRevision}.`);
    }
    const changed = (await this.git(workspace.rootPath, ["diff", "--name-only", "--no-renames", "-z", workspace.baseRevision, commitId])).split("\0").filter(Boolean);
    if (!changed.length) throw new Error("Task commit is empty.");
    if (changed.some((file) => this.protectedPaths.has(file))) throw new Error("Builders must not edit or commit runner-owned plan/report state.");
    return commitId;
  }

  private async assertIntegrationSafe(): Promise<void> {
    await this.assertNoOperation(this.integration.rootPath);
    await this.assertClean(this.integration.rootPath);
    if (await this.head(this.integration.rootPath) !== this.record.integratedHead ||
        (await this.git(this.integration.rootPath, ["symbolic-ref", "--quiet", "HEAD"])).trim() !== `refs/heads/${this.integration.name}`) {
      throw new Error("Integration branch moved unexpectedly; inspect the recovery record.");
    }
  }

  async integrate(workspace: TaskWorkspace): Promise<{ status: "done" | "failed" | "blocked"; commitId?: string; integratedHead: string; message: string }> {
    const task = this.record.tasks.find((candidate) => candidate.name === workspace.name);
    if (!task) throw new Error("Unknown task workspace.");
    let status: "done" | "failed" | "blocked" = "failed";
    let message: string;
    try {
      task.commitId = await this.validate(workspace);
      task.status = "validated";
      await this.save();
      status = "blocked";
      await this.assertIntegrationSafe();
      try {
        await this.git(this.integration.rootPath, ["cherry-pick", task.commitId]);
      } catch (error) {
        // Only the runner-owned, previously clean integration checkout is aborted.
        const abort = await this.run("git", ["cherry-pick", "--abort"], this.integration.rootPath);
        await this.assertIntegrationSafe().catch((unsafe) => {
          throw new Error(`${errorText(error)}; abort failed or integration is unsafe: ${abort.stderr} ${errorText(unsafe)}`);
        });
        throw error;
      }
      this.record.integratedHead = await this.head(this.integration.rootPath);
      task.integratedCommit = this.record.integratedHead;
      task.status = "integrated";
      status = "done";
      message = `Integrated ${task.commitId} as ${task.integratedCommit}; source branch not advanced yet.`;
    } catch (error) {
      task.status = "failed";
      task.error = errorText(error);
      message = `${task.error} Task worktree retained at ${workspace.rootPath}.`;
    }
    await this.save(); // Durable commit mapping precedes any task's "done" plan status.
    return { status, commitId: task.commitId, integratedHead: this.record.integratedHead, message: `${message}\n${this.recoveryInstructions()}` };
  }

  async finalize(signal?: AbortSignal): Promise<string[]> {
    try {
      signal?.throwIfAborted();
      await this.assertIntegrationSafe();
      // Protected paths must be identical in history, so Git preserves even staged plan updates.
      const changed = (await this.git(this.root, ["diff", "--name-only", "--no-renames", "-z", this.initialHead, this.record.integratedHead])).split("\0");
      if (changed.some((file) => this.protectedPaths.has(file))) throw new Error("Integrated history changes runner-owned output; refusing finalization.");
      await this.assertSourceSafe();
      signal?.throwIfAborted();
      await this.git(this.root, ["merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", this.record.integratedHead]);
      const currentBranch = (await this.git(this.root, ["symbolic-ref", "--quiet", "HEAD"])).trim();
      const sourceHead = (await this.git(this.root, ["rev-parse", this.record.sourceBranch])).trim();
      if (currentBranch !== this.record.sourceBranch || sourceHead !== this.record.integratedHead) {
        throw new Error("Original source branch did not reach the integrated head or the checkout switched branches during finalization.");
      }
      signal?.throwIfAborted();
      this.record.state = "finalized";
      await this.save();
    } catch (error) {
      throw new Error(`Git finalization stopped: ${errorText(error)}\n${this.recoveryInstructions()}`);
    }
    const warnings: string[] = [];
    for (const task of this.record.tasks) {
      if (task.status !== "integrated" || !task.commitId) continue;
      await this.cleanup(task, task.commitId).catch((error) => warnings.push(errorText(error)));
    }
    await this.cleanup(this.integration, this.record.integratedHead).catch((error) => warnings.push(errorText(error)));
    return warnings;
  }

  private async cleanup(workspace: TaskWorkspace, expectedHead: string): Promise<void> {
    try {
      await this.assertNoOperation(workspace.rootPath);
      await this.assertClean(workspace.rootPath, false, true);
      if (await this.head(workspace.rootPath) !== expectedHead ||
          (await this.git(workspace.rootPath, ["symbolic-ref", "--quiet", "HEAD"])).trim() !== `refs/heads/${workspace.name}`) {
        throw new Error("new work or a different branch was found");
      }
      await this.git(this.root, ["worktree", "remove", workspace.rootPath]);
      // Compare-and-delete: never force-delete a branch that gained new work.
      await this.git(this.root, ["update-ref", "--no-deref", "-d", `refs/heads/${workspace.name}`, expectedHead]);
    } catch (error) {
      throw new Error(`Cleanup retained ${workspace.name} at ${workspace.rootPath}: ${errorText(error)}`);
    }
  }
}
