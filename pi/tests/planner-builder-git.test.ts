import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { detectVcs, GitBackend, runVcsCommand } from "../.pi/agent/extensions/planner-builder/vcs.ts";
import { commitFile, fixture, git } from "./planner-builder-fixtures.ts";

// No remotes exist in any fixture: unpublished local source is sufficient.
test("independent commits integrate serially; dependent work uses latest history; staged plan survives", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.plan, "updated plan before build\n");
  await git(f.root, "add", "plan.md");
  const backend = await f.start();
  const first = await backend.createWorkspace("T01");
  const second = await backend.createWorkspace("T02");
  assert.equal(first.baseRevision, second.baseRevision);
  await commitFile(first, "src/one.txt");
  await commitFile(second, "src/two.txt");
  const one = await backend.integrate(first);
  const two = await backend.integrate(second);
  assert.equal(one.status, "done");
  assert.equal(two.status, "done");
  assert.equal(await git(backend.integration.rootPath, "rev-parse", "HEAD^"), one.integratedHead);
  const dependent = await backend.createWorkspace("T03");
  assert.equal(dependent.baseRevision, two.integratedHead);
  assert.equal(await fs.readFile(path.join(dependent.rootPath, "src/one.txt"), "utf8"), "task\n");
  await commitFile(dependent, "src/three.txt");
  const three = await backend.integrate(dependent);
  assert.equal(three.status, "done");
  assert.equal(await git(f.root, "rev-parse", "HEAD"), backend.initialHead);
  await fs.writeFile(f.plan, "latest plan status and user edits\n");
  assert.deepEqual(await backend.finalize(), []);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), three.integratedHead);
  assert.equal(await git(f.root, "show", ":plan.md"), "updated plan before build");
  assert.equal(await fs.readFile(f.plan, "utf8"), "latest plan status and user edits\n");
  assert.equal(await git(f.root, "rev-list", "--count", `${backend.initialHead}..HEAD`), "3");
  assert.equal(await git(f.root, "branch", "--list", "pi-plan/*"), "");
  const record = JSON.parse(await fs.readFile(backend.recoveryPath, "utf8"));
  assert.equal(record.state, "finalized");
  assert.equal(record.tasks.length, 3);
  const review = await f.start();
  assert.equal(review.reviewBase, backend.initialHead);
  await review.finalize();
});

for (const dirty of ["unstaged", "staged", "untracked", "pi-config", "other-plan", "renamed-plan"]) {
  test(`reject dirty ${dirty} source without changing it`, async (t) => {
    const f = await fixture(t);
    let file = "src/base.txt";
    if (dirty === "untracked") file = "src/new.txt";
    if (dirty === "pi-config") file = ".pi/settings.json";
    if (dirty === "other-plan") file = ".pi/plans/other.md";
    if (dirty === "renamed-plan") {
      await git(f.root, "mv", "plan.md", "old-plan.md");
      await fs.writeFile(f.plan, "active plan\n");
    } else {
      await fs.mkdir(path.dirname(path.join(f.root, file)), { recursive: true });
      await fs.writeFile(path.join(f.root, file), "user work\n");
      if (dirty === "staged") await git(f.root, "add", file);
    }
    const before = await git(f.root, "status", "--porcelain");
    await assert.rejects(f.start(), /dirty/);
    assert.equal(await git(f.root, "status", "--porcelain"), before);
    assert.equal(await git(f.root, "branch", "--list", "pi-plan/*"), "");
  });
}

test("untracked active plan and exact findings output are allowed, not all .pi", async (t) => {
  const f = await fixture(t);
  await git(f.root, "rm", "plan.md");
  await git(f.root, "commit", "-m", "untrack plan");
  await fs.writeFile(f.plan, "untracked plan\n");
  await fs.mkdir(path.join(f.root, ".pi/outputs"), { recursive: true });
  await fs.writeFile(path.join(f.root, ".pi/outputs/findings.html"), "old report");
  const backend = await f.start();
  await backend.finalize();
  assert.equal(await fs.readFile(f.plan, "utf8"), "untracked plan\n");
});

test("detached and unborn source are rejected", async (t) => {
  const f = await fixture(t);
  await git(f.root, "checkout", "--detach");
  await assert.rejects(f.start(), /detached/);
  const empty = await fixture(t, true);
  await assert.rejects(empty.start(), /unborn/);
});

for (const mutation of ["head", "branch", "unstaged", "staged", "untracked", "operation", "skip-worktree"]) {
  test(`finalization refuses source ${mutation} changes and retains recovery`, async (t) => {
    const f = await fixture(t);
    const backend = await f.start();
    const task = await backend.createWorkspace("T01");
    await commitFile(task, "src/one.txt");
    const integrated = await backend.integrate(task);
    assert.equal(integrated.status, "done");
    if (mutation === "head") {
      await git(f.root, "commit", "--allow-empty", "-m", "user advanced branch");
    } else if (mutation === "branch") {
      await git(f.root, "switch", "-c", "other");
    } else if (mutation === "operation") {
      await fs.writeFile(path.join(f.root, ".git/MERGE_HEAD"), `${backend.initialHead}\n`);
    } else if (mutation === "skip-worktree") {
      await git(f.root, "update-index", "--skip-worktree", "src/base.txt");
    } else {
      const file = mutation === "untracked" ? "new.txt" : "src/base.txt";
      await fs.writeFile(path.join(f.root, file), "new user work");
      if (mutation === "staged") await git(f.root, "add", file);
    }
    const before = await git(f.root, "rev-parse", "HEAD");
    const status = await git(f.root, "status", "--porcelain");
    await assert.rejects(backend.finalize(), /Git finalization stopped:.*(changed|dirty|operation|skip-worktree)/s);
    assert.equal(await git(f.root, "rev-parse", "HEAD"), before);
    assert.equal(await git(f.root, "status", "--porcelain"), status);
    assert.ok(await fs.stat(backend.integration.rootPath));
    const record = JSON.parse(await fs.readFile(backend.recoveryPath, "utf8"));
    assert.equal(record.state, "running");
    assert.equal(record.tasks[0].integratedCommit, integrated.integratedHead);
    assert.match(integrated.message, /Recovery record:/);
    await assert.rejects(f.start(), /unfinished Git build needs recovery/);
  });
}

test("conflicts retain task worktree, abort integration and permit next pick and manual recovery", async (t) => {
  const f = await fixture(t);
  const backend = await f.start();
  const left = await backend.createWorkspace("T01");
  const right = await backend.createWorkspace("T02");
  const next = await backend.createWorkspace("T03");
  await commitFile(left, "src/base.txt", "left\n");
  const rightCommit = await commitFile(right, "src/base.txt", "right\n");
  await commitFile(next, "src/next.txt");
  assert.equal((await backend.integrate(left)).status, "done");
  const conflict = await backend.integrate(right);
  assert.equal(conflict.status, "blocked");
  assert.equal(await git(right.rootPath, "rev-parse", "HEAD"), rightCommit);
  assert.equal(await git(right.rootPath, "status", "--porcelain"), "");
  assert.equal(await git(backend.integration.rootPath, "status", "--porcelain"), "");
  assert.equal((await backend.integrate(next)).status, "done");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(backend.finalize(controller.signal), /Recovery record:/);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), backend.initialHead);
  await git(f.root, "merge", "--ff-only", "--no-autostash", backend.integration.name);
  assert.equal(await fs.readFile(path.join(f.root, "src/base.txt"), "utf8"), "left\n");
  const record = JSON.parse(await fs.readFile(backend.recoveryPath, "utf8"));
  record.state = "recovered";
  await fs.writeFile(backend.recoveryPath, JSON.stringify(record));
  const retry = await f.start();
  await retry.finalize();
  assert.ok(await fs.stat(right.rootPath));
});

for (const invalid of ["empty", "two", "dirty", "untracked", "plan", "wrong-parent", "merge", "detached", "hidden-dirty"]) {
  test(`reject invalid builder commit: ${invalid}`, async (t) => {
    const f = await fixture(t);
    const backend = await f.start();
    const task = await backend.createWorkspace("T01");
    if (invalid === "empty") {
      await git(task.rootPath, "commit", "--allow-empty", "-m", "empty");
    } else if (invalid === "wrong-parent") {
      await git(task.rootPath, "checkout", "--orphan", "unrelated");
      await git(task.rootPath, "commit", "-m", "unrelated root");
      await git(task.rootPath, "branch", "-f", task.name, "HEAD");
      await git(task.rootPath, "switch", task.name);
    } else {
      await commitFile(task, invalid === "plan" ? "plan.md" : "src/task.txt");
      if (invalid === "two") await commitFile(task, "src/extra.txt");
      if (invalid === "dirty") await fs.writeFile(path.join(task.rootPath, "src/task.txt"), "dirty");
      if (invalid === "untracked") await fs.writeFile(path.join(task.rootPath, "untracked.txt"), "dirty");
      if (invalid === "detached") await git(task.rootPath, "checkout", "--detach");
      if (invalid === "hidden-dirty") {
        await git(task.rootPath, "update-index", "--assume-unchanged", "src/task.txt");
        await fs.writeFile(path.join(task.rootPath, "src/task.txt"), "hidden changes");
      }
      if (invalid === "merge") {
        const side = await backend.createWorkspace("side");
        await commitFile(side, "src/side.txt");
        await git(task.rootPath, "merge", "--no-ff", "--no-edit", side.name);
      }
    }
    const result = await backend.integrate(task);
    assert.equal(result.status, "failed");
    assert.equal(result.integratedHead, backend.initialHead);
    assert.ok(await fs.stat(task.rootPath));
    await backend.finalize();
    assert.ok(await fs.stat(task.rootPath));
  });
}

for (const newWork of ["commit", "untracked", "ignored"]) {
  test(`cleanup preserves ${newWork} created after integration`, async (t) => {
    const f = await fixture(t);
    const backend = await f.start();
    const task = await backend.createWorkspace("T01");
    await commitFile(task, "src/one.txt");
    assert.equal((await backend.integrate(task)).status, "done");
    if (newWork === "commit") await commitFile(task, "new-work.txt");
    else {
      if (newWork === "ignored") await fs.appendFile(path.join(f.root, ".git/info/exclude"), "\nnew-work.txt\n");
      await fs.writeFile(path.join(task.rootPath, "new-work.txt"), "important work");
    }
    const warnings = await backend.finalize();
    assert.ok(warnings.some((warning) => warning.includes(task.rootPath)));
    assert.ok(await fs.stat(path.join(task.rootPath, "new-work.txt")));
    assert.ok(await git(f.root, "show-ref", `refs/heads/${task.name}`));
  });
}

test("concurrent build starts cannot both claim the same source checkout", async (t) => {
  const f = await fixture(t);
  const starts = await Promise.allSettled([f.start(), f.start()]);
  const succeeded = starts.filter((result) => result.status === "fulfilled");
  assert.equal(succeeded.length, 1);
  const rejected = starts.find((result) => result.status === "rejected");
  assert.match(String(rejected?.reason), /startup is locked|unfinished Git build/);
  await succeeded[0].value.finalize();
});

test("ignored user files colliding with incoming source are not overwritten", async (t) => {
  const f = await fixture(t);
  const backend = await f.start();
  const task = await backend.createWorkspace("T01");
  await commitFile(task, "incoming.txt", "builder work");
  assert.equal((await backend.integrate(task)).status, "done");
  await fs.appendFile(path.join(f.root, ".git/info/exclude"), "\nincoming.txt\n");
  await fs.writeFile(path.join(f.root, "incoming.txt"), "ignored user work");
  await assert.rejects(backend.finalize(), /Git finalization stopped/);
  assert.equal(await fs.readFile(path.join(f.root, "incoming.txt"), "utf8"), "ignored user work");
  assert.equal(await git(f.root, "rev-parse", "HEAD"), backend.initialHead);
});

test("merge command failure preserves integration branch/worktree and source plan", async (t) => {
  const f = await fixture(t);
  const backend = await GitBackend.start(f.root, f.root, f.plan, path.join(f.parent, "tasks"), async (command, args, cwd) => {
    if (args.includes("merge")) return { exitCode: 1, stdout: "", stderr: "simulated merge failure" };
    return runVcsCommand(command, args, cwd);
  });
  const task = await backend.createWorkspace("T01");
  await commitFile(task, "src/task.txt");
  assert.equal((await backend.integrate(task)).status, "done");
  await fs.writeFile(f.plan, "latest status");
  await assert.rejects(backend.finalize(), /simulated merge failure.*Recovery record:/s);
  assert.equal(await git(f.root, "rev-parse", "HEAD"), backend.initialHead);
  assert.equal(await fs.readFile(f.plan, "utf8"), "latest status");
  assert.ok(await fs.stat(backend.integration.rootPath));
});

test("failed conflict abort prevents subsequent cherry-picks into unsafe integration", async (t) => {
  const f = await fixture(t);
  let picks = 0;
  const backend = await GitBackend.start(f.root, f.root, f.plan, path.join(f.parent, "tasks"), async (command, args, cwd) => {
    if (args.includes("cherry-pick")) {
      if (args.includes("--abort")) return { exitCode: 1, stdout: "", stderr: "simulated abort failure" };
      picks++;
    }
    return runVcsCommand(command, args, cwd);
  });
  const left = await backend.createWorkspace("T01");
  const right = await backend.createWorkspace("T02");
  const next = await backend.createWorkspace("T03");
  await commitFile(left, "src/base.txt", "left\n");
  await commitFile(right, "src/base.txt", "right\n");
  await commitFile(next, "src/next.txt");
  assert.equal((await backend.integrate(left)).status, "done");
  assert.equal((await backend.integrate(right)).status, "blocked");
  assert.equal((await backend.integrate(next)).status, "blocked");
  assert.equal(picks, 2);
  await assert.rejects(backend.finalize(), /in-progress Git operation/);
  assert.ok(await fs.stat(right.rootPath));
});

for (const operation of ["CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG", "index.lock"]) {
  test(`reject source operation ${operation} before launching tasks`, async (t) => {
    const f = await fixture(t);
    const operationPath = path.join(f.root, ".git", operation);
    if (["rebase-merge", "rebase-apply", "sequencer"].includes(operation)) await fs.mkdir(operationPath);
    else await fs.writeFile(operationPath, "operation marker");
    await assert.rejects(f.start(), /in-progress Git operation/);
    assert.equal(await git(f.root, "branch", "--list", "pi-plan/*"), "");
  });
}

test("linked source worktrees and cwd subdirectories", async (t) => {
  const f = await fixture(t);
  const linked = path.join(f.parent, "linked");
  await git(f.root, "worktree", "add", "-b", "linked-feature", linked);
  assert.ok((await fs.stat(path.join(linked, ".git"))).isFile());
  assert.deepEqual(await detectVcs(path.join(linked, "src")), { kind: "git", root: linked });
  const backend = await GitBackend.start(path.join(linked, "src"), linked, path.join(linked, "plan.md"), path.join(f.parent, "tasks"));
  const task = await backend.createWorkspace("T01");
  assert.equal(task.cwd, path.join(task.rootPath, "src"));
  await commitFile(task, "src/one.txt");
  assert.equal((await backend.integrate(task)).status, "done");
  await backend.finalize();
  assert.equal(await git(f.root, "rev-parse", "HEAD"), backend.initialHead);
  assert.notEqual(await git(linked, "rev-parse", "HEAD"), backend.initialHead);
});

test("metadata detection chooses jj first, stops at nested Git, and never falls back on invalid jj", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, ".jj"));
  await assert.rejects(detectVcs(path.join(f.root, "src")), /Found .jj.*Git fallback is disabled/s);
  let calls: string[] = [];
  assert.deepEqual(await detectVcs(path.join(f.root, "src"), async (command) => {
    calls.push(command);
    return { exitCode: 0, stdout: `${f.root}\n`, stderr: "" };
  }), { kind: "jj", root: f.root });
  assert.deepEqual(calls, ["jj"]);
  calls = [];
  await assert.rejects(detectVcs(f.root, async (command) => {
    calls.push(command);
    return { exitCode: 1, stdout: "", stderr: "ENOENT: jj not installed" };
  }), /install jj/);
  assert.deepEqual(calls, ["jj"]);
  const nested = path.join(f.root, "src/nested");
  await fs.mkdir(nested);
  await git(nested, "init", "-b", "nested");
  assert.deepEqual(await detectVcs(nested), { kind: "git", root: nested });
  await assert.rejects(detectVcs(f.parent), /No .jj or .git checkout found/);
});
