import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { createTaskEvidence, type EvidenceWorkspace } from "../.pi/agent/extensions/planner-builder/task-evidence.ts";

const exec = promisify(execFile);
async function fixture(t: TestContext): Promise<EvidenceWorkspace> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "pi-evidence-"));
  t.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  await fs.mkdir(path.join(rootPath, "src"));
  await fs.writeFile(path.join(rootPath, "src/main.ts"), "first\nsecond\nthird\n");
  return { runId: "r", taskId: "T03", attemptId: "attempt", rootPath, vcs: "jj", baseRevision: "a".repeat(40), protectedPaths: ["plan.md", "private"] };
}

test("file evidence is bounded, timestamped, explicitly non-authoritative and immutable in identity", async (t) => {
  const workspace = await fixture(t);
  workspace.protectedPaths = ["plan.md", ".pi/plans/active.md", ".pi/outputs/findings.html"];
  const evidence = createTaskEvidence(workspace, { now: () => new Date("2026-10-01T00:00:00Z") });
  workspace.taskId = "changed";
  const result = await evidence.read({ kind: "file", path: "src/main.ts", startLine: 2, maxLines: 1 });
  assert.equal(result.taskId, "T03");
  assert.equal(result.text, "second\n");
  assert.equal(result.truncated, true);
  assert.equal(result.observedAt, "2026-10-01T00:00:00.000Z");
  assert.equal(result.concurrentChangesPossible, true);
  assert.equal(result.integrationValidation, false);
  await fs.writeFile(path.join(workspace.rootPath, "src/unicode.txt"), "é".repeat(6000));
  const unicode = await evidence.read({ kind: "file", path: "src/unicode.txt", maxBytes: 101 });
  assert.ok(Buffer.byteLength(unicode.text) <= 101);
  assert.doesNotMatch(unicode.text, /\ufffd/);
  assert.equal(unicode.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(unicode)) <= 16 * 1024);
});

test("file and diff paths reject traversal, absolute paths, metadata, protected paths and injected options", async (t) => {
  const workspace = await fixture(t);
  const evidence = createTaskEvidence(workspace, { spawn: (() => { throw new Error("must not spawn"); }) as typeof spawn });
  const paths = ["../outside", "/etc/passwd", "C:\\Windows\\system.ini", "src/../plan.md", ".git/config", "src/.jj/repo", "plan.md", "PLAN.md", "private/key", ".pi/plans/test.md", ".pi/outputs/findings.html", "src//main.ts", "src/./main.ts", "src/main.ts\0", "src\\main.ts"];
  for (const file of paths) {
    for (const kind of ["file", "diff"] as const) {
      await assert.rejects(evidence.read({ kind, path: file }), /path|protected|metadata/i, `${kind}: ${file}`);
    }
  }
  await assert.rejects(evidence.read({ kind: "file", path: "src/main.ts", maxBytes: Infinity }), /limit/);
  await assert.rejects(evidence.read({ kind: "file", path: "src/main.ts", startLine: -1 }), /limit/);
  await assert.rejects(evidence.read({ kind: "diff", path: "src/main.ts", command: "touch pwned" } as never), /field/);
});

test("escaping and contained symlinks, nested checkouts, binary, oversized and special files fail closed", async (t) => {
  const workspace = await fixture(t);
  const evidence = createTaskEvidence(workspace);
  await fs.symlink("/etc/passwd", path.join(workspace.rootPath, "escape"));
  await fs.symlink("src/main.ts", path.join(workspace.rootPath, "alias"));
  await fs.symlink("/etc", path.join(workspace.rootPath, "outside"));
  for (const marker of [".git", ".jj"]) {
    const dir = path.join(workspace.rootPath, `nested${marker}`);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, marker), "checkout pointer");
    await fs.writeFile(path.join(dir, "secret"), "nested");
    await assert.rejects(evidence.read({ kind: "file", path: `nested${marker}/secret` }), /checkout/);
  }
  await fs.writeFile(path.join(workspace.rootPath, "binary"), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(workspace.rootPath, "invalid-utf8"), Buffer.from([0xff, 0xfe]));
  await fs.writeFile(path.join(workspace.rootPath, "huge"), "a".repeat(256 * 1024 + 1));
  await exec("mkfifo", [path.join(workspace.rootPath, "fifo")]);
  for (const file of ["escape", "alias", "outside/passwd", "binary", "invalid-utf8", "huge", "fifo", "src"]) {
    await assert.rejects(evidence.read({ kind: "file", path: file }), /symlink|regular|binary|UTF-8|size|directory/i, file);
  }
});

test("diff invocation has fixed safe arguments, trusted revisions and no shell, with bounded output", async (t) => {
  const workspace = await fixture(t);
  const invocations: Array<{ command: string; args: readonly string[]; options: any }> = [];
  const evidence = createTaskEvidence(workspace, { spawn: ((command, args, options) => {
    invocations.push({ command, args, options });
    return spawn(process.execPath, ["-e", 'process.stdout.write("diff --git a/src/main.ts b/src/main.ts\\n" + "x".repeat(1000000)); setInterval(() => {}, 1000);'], { stdio: ["ignore", "pipe", "pipe"] });
  }) as typeof spawn });
  const result = await evidence.read({ kind: "diff", path: "src/main.ts", maxBytes: 1024 });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= 1024);
  assert.match(result.notes.join(" "), /unsnapshotted/);
  assert.equal(invocations[0].command, "jj");
  assert.ok(invocations[0].args.includes("--ignore-working-copy"));
  assert.ok(invocations[0].args.includes(workspace.baseRevision));
  assert.ok(invocations[0].args.includes("--git"));
  assert.equal(invocations[0].options.shell, false);
  assert.equal(invocations[0].options.cwd, workspace.rootPath);
  const git = createTaskEvidence({ ...workspace, vcs: "git" }, { spawn: ((command, args, options) => {
    invocations.push({ command, args, options });
    return spawn(process.execPath, ["-e", ""], { stdio: ["ignore", "pipe", "pipe"] });
  }) as typeof spawn });
  await git.read({ kind: "diff", path: "src/main.ts" });
  assert.equal(invocations[1].command, "git");
  for (const flag of ["--no-ext-diff", "--no-textconv", "--no-renames", "core.hooksPath=/dev/null", "core.fsmonitor=false"]) assert.ok(invocations[1].args.includes(flag));
  assert.equal(invocations[1].options.env.GIT_LITERAL_PATHSPECS, "1");
  assert.deepEqual(invocations[1].args.slice(-4), [workspace.baseRevision, "HEAD", "--", "src/main.ts"]);
});

test("evidence bounds aggregate reads and concurrent requests, with no fileset or shell injection", async (t) => {
  const workspace = await fixture(t);
  const evidence = createTaskEvidence(workspace);
  await fs.writeFile(path.join(workspace.rootPath, "large"), "x".repeat(256 * 1024));
  for (let index = 0; index < 15; index++) await evidence.read({ kind: "file", path: "large", maxBytes: 1 });
  await assert.rejects(evidence.read({ kind: "file", path: "large" }), /cumulative/);
  const bounded = createTaskEvidence(workspace);
  const abort = new AbortController();
  const first = bounded.read({ kind: "file", path: "src/main.ts" }, abort.signal);
  const second = bounded.read({ kind: "file", path: "src/main.ts" }, abort.signal);
  await assert.rejects(bounded.read({ kind: "file", path: "src/main.ts" }), /request limit/);
  abort.abort();
  await Promise.all([assert.rejects(first, /abort/i), assert.rejects(second, /abort/i)]);
  for (const file of ["src/main.ts;touch PWNED", "all()", "src/*", ":(glob)**", 'src/main.ts"|all()']) {
    await assert.rejects(bounded.read({ kind: "diff", path: file }), /path/);
  }
  await assert.rejects(fs.stat(path.join(workspace.rootPath, "PWNED")), { code: "ENOENT" });
});

test("diff deadlines, cancellation, disallowed historical paths and binary modes fail safely", async (t) => {
  const workspace = await fixture(t);
  for (const output of ["diff --git a/plan.md b/plan.md\n+secret", "diff --git a/src/main.ts b/src/main.ts\nold mode 120000\n", "diff --git a/src/main.ts b/src/main.ts\nBinary files a/src/main.ts and b/src/main.ts differ\n", "diff --git a/src/main.ts b/src/main.ts\n+forced text\0binary\n"]) {
    const evidence = createTaskEvidence(workspace, { spawn: (() => spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(output)})`], { stdio: ["ignore", "pipe", "pipe"] })) as typeof spawn });
    await assert.rejects(evidence.read({ kind: "diff", path: "src/main.ts" }), /path|binary|regular/i);
  }
  const stalled = createTaskEvidence(workspace, { timeoutMs: 20, spawn: (() => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] })) as typeof spawn });
  await assert.rejects(stalled.read({ kind: "diff", path: "src/main.ts" }), /timeout/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(stalled.read({ kind: "diff", path: "src/main.ts" }, abort.signal), /abort/i);
});

test("real jj diff uses committed observations without snapshotting edits or invoking configured tools", async (t) => {
  const workspace = await fixture(t);
  async function jj(...args: string[]): Promise<string> {
    return (await exec("jj", ["--no-pager", ...args], { cwd: workspace.rootPath })).stdout.trim();
  }
  await jj("git", "init", "--colocate");
  await jj("config", "set", "--repo", "user.name", "Evidence");
  await jj("config", "set", "--repo", "user.email", "test@example.invalid");
  await jj("config", "set", "--repo", "signing.behavior", "drop");
  await jj("commit", "-m", "base");
  workspace.baseRevision = await jj("log", "-r", "@-", "--no-graph", "-T", "commit_id");
  await fs.writeFile(path.join(workspace.rootPath, "src/main.ts"), "committed\n");
  await jj("commit", "-m", "change");
  await fs.writeFile(path.join(workspace.rootPath, "src/main.ts"), "unsnapshotted\n");
  await jj("config", "set", "--repo", "ui.diff-formatter", "a-command-that-must-not-run");
  const evidence = createTaskEvidence(workspace);
  const diff = await evidence.read({ kind: "diff", path: "src/main.ts" });
  assert.match(diff.text, /\+committed/);
  assert.doesNotMatch(diff.text, /unsnapshotted/);
  assert.match((await evidence.read({ kind: "file", path: "src/main.ts" })).text, /unsnapshotted/);
  assert.match(await jj("--ignore-working-copy", "diff", "--from", workspace.baseRevision, "--git"), /\+committed/);
  // A deleted file can still be inspected from stored history without opening another filesystem path.
  await fs.unlink(path.join(workspace.rootPath, "src/main.ts"));
  await jj("commit", "-m", "delete");
  const deletion = await createTaskEvidence(workspace).read({ kind: "diff", path: "src/main.ts" });
  assert.match(deletion.text, /deleted file mode 100644/);

  // The Git evidence path must not execute checkout-configured helpers either.
  const sentinel = path.join(workspace.rootPath, "helper-executed");
  const helper = path.join(workspace.rootPath, "probe.sh");
  await fs.writeFile(helper, `#!/bin/sh\ntouch '${sentinel}'\ncat\n`, { mode: 0o700 });
  await fs.writeFile(path.join(workspace.rootPath, ".gitattributes"), "* diff=probe filter=probe\n");
  await fs.appendFile(path.join(workspace.rootPath, ".git/config"), [
    "", "[diff]", `external = ${helper}`, '[diff "probe"]', `textconv = ${helper}`,
    '[filter "probe"]', `clean = ${helper}`, `smudge = ${helper}`, "[core]", `fsmonitor = ${helper}`, "",
  ].join("\n"));
  const gitDiff = await createTaskEvidence({ ...workspace, vcs: "git" }).read({ kind: "diff", path: "src/main.ts" });
  assert.match(gitDiff.text, /deleted file mode 100644/);
  await assert.rejects(fs.stat(sentinel), { code: "ENOENT" });
});
