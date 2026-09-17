# Planner-builder extension

Creates planner-generated plan files and dispatches each builder in its own jj workspace or Git worktree. Planner creation, builder execution, and optional verifier review are managed from the main pi pane as structured subprocesses.

## Commands

| Command | Purpose |
| --- | --- |
| `/plan-create <request>` | Run the `planner` agent using the model and effort currently selected in the main pi process, surface material planner questions through the parent pi UI, then write a plan file under `.pi/plans/`. |
| `/plan-build [--verify] [plan-file] [T01,T02]` | Run `builder` agents in monitored parallel jj workspaces or Git worktrees when tasks are independent. Each completed task must create one atomic commit, integrated serially with the selected backend. If no file is provided, the latest `.pi/plans/*.md` file is used. |
| `/plan-list` | List recent plan files. |

## Tools

| Tool | Purpose |
| --- | --- |
| `plan_file_create` | Runs a planner agent with the model and effort selected in the main pi process, surfaces material planner questions through the parent pi UI, and saves a structured plan file. |
| `plan_file_build` | Auto-selects jj or Git, creates isolated task checkouts, starts locally managed builder subprocesses, streams their output into the main planner-builder dashboard, cancels/restarts stuck attempts, and serially integrates atomic per-task commits. Set `runVerifier: true` to run verifier review afterward; the default is `false`. |
| `plan_file_list` | Lists recent plan files. |

## Backend selection

Starting at cwd (including subdirectories), the nearest `.jj` or `.git` metadata defines the checkout. `.jj` takes precedence when colocated; a nested `.git` checkout stops the search before an outer jj repository. Linked Git worktrees with `.git` files are supported. If `.jj` exists but jj is missing or broken, the build fails without Git fallback. With neither VCS, enter or initialize a supported checkout first.

## Jujutsu workspace integration

For each ready task, the extension creates a checkout under `PI_PLAN_WORKSPACE_ROOT` or `~/.pi/plan-workspaces` with:

```sh
jj workspace add --name <workspace-name> <path> -r <integrated-head>
```

Task workspace names combine the source workspace folder and task ID, for example `macro-test-thing-t01`.

Successfully integrated task workspaces are forgotten with `jj workspace forget` and deleted. Failed, blocked, cancelled, stuck-exhausted, validation-failed, or conflicted task workspaces are retained on disk for inspection.

## Git worktree integration

Before building, switch to an attached feature branch with a HEAD commit and **commit source changes locally**. No push or remote is required. Staged, unstaged, and untracked source changes are rejected. Sparse/skip-worktree/assume-unchanged checkouts and in-progress Git operations are rejected. The only cleanliness exemptions are the exact active plan path and `<repo-root>/.pi/outputs/findings.html`, not `.pi` source/configuration or other plans. The plan can be tracked, modified, or staged; builders must never edit or commit it or the findings report.

- Each run has unique temporary branches and worktrees under `PI_PLAN_WORKSPACE_ROOT` or `~/.pi/plan-workspaces` (outside the source checkout).
- Independent ready tasks run in parallel from the latest integrated head. Subsequent dependency waves use the updated history.
- A builder must leave exactly one non-empty commit on its assigned branch, with the provided base as its only direct parent and a clean index/worktree including untracked source files.
- The runner serially cherry-picks validated commits into a separate integration branch/worktree. Conflicted picks are aborted there, not in the task checkout; the task checkout/branch is retained and other tasks can proceed.
- The source branch advances only by `git merge --ff-only --no-autostash`, after checking its branch name, original HEAD, cleanliness and absence of in-progress operations. Plan changes are preserved in place, never restored from an old snapshot. No stash, source snapshot commits, reset, remote calls, or push is performed.
- Successful cleanup uses non-force worktree removal and compare-and-delete branch refs. New commits, dirty files, ignored output, changed branches, or operations cause retention instead of destructive cleanup.

### Recovery and review

Before creating any worktree, the runner writes a recovery JSON under the Git common directory's `pi-planner-builder/`. It records the source branch, initial/review base, integration branch/worktree, and every task path/base. Commit mappings are saved **before** a task is marked done. During a run, done means durably integrated there, not yet fast-forwarded to the source. Each task result links to the recovery record. Records are retained after successful cleanup too. A short-lived `start.lock` in that same directory serializes startup across Pi processes. If a process dies during startup, inspect the lock's PID and recovery records before removing a stale lock; never remove a live process's lock.

On failure, interruption, or finalization refusal, keep the integration branch/worktree. Read the reported JSON and inspect `git -C <integration-worktree> status` and its log. After resolving any integration operation, reviewing retained tasks, and safely saving your own source edits, return to the recorded source branch and run `git merge --ff-only --no-autostash <integration-branch>`. If histories diverged, reconcile manually rather than resetting. Reconcile the plan statuses with recovered commits, then set the record's `state` to `"recovered"`. Another build of that source checkout is blocked while an unfinished record remains. A crash between cherry-pick and journal update can leave the integration branch ahead of the recorded head; inspect its log before recovery.

Verifier review runs only after successful finalization, using an explicit base: the first Git build's initial HEAD for that plan (also on later verify-only calls), or the existing jj `main` bookmark. It never assumes a Git `main` branch or remote exists.

## Build options

`plan_file_build` accepts optional verification and watchdog controls:

- `runVerifier` (default `false`) runs the configured verifier agent after workspace integration when enabled.
- `verifierAgent` (default `"verifier"`) selects the verifier agent used when `runVerifier` is enabled.
- `builderMonitor` (default `true`) enables/disables stuck detection.
- `builderMonitorIntervalSeconds` (default `30`) controls status checks.
- `builderStuckTimeoutSeconds` (default `900`) cancels a builder attempt after this many seconds with no subprocess output or lifecycle progress.
- `builderMaxRestarts` (default `1`) controls per-task restarts after a stuck cancellation; `0` cancels stuck runs without restarting.

## Plan format

The planner is prompted to emit machine-readable builder tasks:

```markdown
## Builder Tasks

### Task T01: Short imperative title
Status: pending
Depends on: none
Files:
- path/to/file.ts
Instructions:
- Specific implementation instruction.
Verification:
- Exact command or manual check.
```

`/plan-build` runs ready tasks in dependency order. Ready tasks with disjoint parsed `Files:` entries can run at the same time in separate jj workspaces or Git worktrees; tasks with unknown or overlapping file sets are held for a later wave. Dependent tasks wait until their dependencies have `Status: done`.

Builders create exactly one atomic commit in their dedicated workspace. After a builder reports `PLAN_TASK_RESULT: done` (or reaches the existing clean no-marker fallback), the main loop validates that exactly one non-empty task commit exists, rebases it with jj or cherry-picks it with Git onto the current integrated head, checks for conflicts, and advances the integrated head. Retained unsuccessful workspaces are never integrated automatically.

## Tests

Run `node --test pi/tests/planner-builder*.test.ts` from the dotfiles root with Node 24+, Git and jj installed. Tests use temporary local repositories and synthetic builder callbacks, never real agents or remotes. No additional dependencies are needed.
