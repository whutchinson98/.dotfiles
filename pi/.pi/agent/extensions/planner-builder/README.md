# Planner-builder extension

Creates planner-generated plan files and dispatches each builder in its own jj workspace or Git worktree. The parent pi process owns builder RPC subprocesses, optional supervision, and VCS validation/integration. Planner creation and optional verifier review remain one-shot structured subprocesses.

**Supervision is off by default. Verifier review is independently off by default.** Supervision observes work in progress and may offer guidance; it is not acceptance testing or verifier review.

## Commands

| Command | Purpose |
| --- | --- |
| `/plan-create <request>` | Run the `planner` agent using the model and effort currently selected in the main pi process, surface material planner questions through the parent pi UI, then write a plan file under `.pi/plans/`. |
| `/plan-build [--verify] [--supervise\|--advisory] [plan-file] [T01,T02]` | Run independent builders in parallel, then serially integrate one atomic commit per task. `--supervise` selects steer mode; `--advisory` selects proposals only. They are mutually exclusive. `--verify` independently enables verifier review. If no file is provided, use the latest `.pi/plans/*.md`. |
| `/plan-list` | List recent plan files. |
| `/plan-inspect [runId] [taskId]` | Inspect the active run or its current task attempt. With no arguments, discover the active run ID. Supply the run ID before a task ID. |
| `/plan-steer <runId> <taskId> <attemptId> <guidance>` | Request bounded plain-text guidance through the same controller as the supervisor. Advisory records a proposal; off rejects guidance. |
| `/plan-cancel <runId> [taskId attemptId]` | Cancel the whole owned run, or one current task attempt while its control window is open. |

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

## Opt-in supervision

Call `plan_file_build` with one of these argument objects (paths resolve from pi cwd):

```json
{
  "path": ".pi/plans/example.md",
  "supervisionMode": "steer",
  "supervisorAgent": "supervisor",
  "supervisionOptions": { "maxInterventionsPerTask": 2 },
  "runVerifier": false
}
```

```json
{
  "path": ".pi/plans/example.md",
  "supervisionMode": "advisory"
}
```

Equivalent mode selection from the parent pane:

```text
/plan-build --supervise .pi/plans/example.md
/plan-build --advisory .pi/plans/example.md T01,T02
/plan-build --supervise --verify .pi/plans/example.md
```

Omitting `supervisionMode` or both supervision flags selects `"off"`: no supervisor and no guidance delivery. Inspection and cancellation still work. Advisory mode records proposals from both the supervisor and manual controls but never delivers them; there is no automatic proposal approval or live mode-switch command. Steer mode allows bounded guidance, subject to the same limits for manual and supervisor requests. Ordinary builders still run and commit in all three modes.

`supervisorAgent` defaults to `"supervisor"` and is selectable through the tool, not a slash-command flag. Agent discovery uses `agentScope` (`"user"` by default; `"project"` or `"both"` opt in to project agents with confirmation enabled by default). The selected parent model/effort is passed to the supervisor. Regardless of the selected agent's frontmatter, its effective tools are only `inspect_build`, `inspect_task`, `steer_task`, and `request_user_decision`. Built-in tools, MCP, and other extensions/resources are disabled; only the injected supervisor bridge is loaded. This is a restricted tool surface, not an OS sandbox.

There is one parent-owned supervisor per build. It receives the saved plan, recorded planning decisions, constraints, and acceptance/verification instructions—not a resumed planner conversation. It cannot spawn agents, rewrite plans, run arbitrary shell/VCS commands, or approve integration. Reviews are event-driven on changed progress, blockers, retries, repeated tool failures, and completion checkpoints, with debounce and a minimum interval; there is no LLM polling of unchanged state.

### Normalized supervision limits

`supervisionOptions` is optional; omitted fields use these defaults. Values must be finite numbers. Runtime normalization clamps to the inclusive ranges and rounds down; the tool schema also declares these ranges and may reject out-of-range input before normalization. Use in-range values.

| Option | Default | Range | Meaning |
| --- | --- | --- | --- |
| `intervalSeconds` | 30 | 1–300 | Minimum spacing between changed-state reviews. |
| `cooldownSeconds` | 60 | 0–3600 | Per-task guidance cooldown. |
| `maxInterventionsPerTask` | 3 | 0–20 | Per-task guidance/proposal budget, shared across attempts. |
| `maxInterventions` | 20 | 0–200 | Build-wide guidance/proposal budget. |
| `maxReviews` | 20 | 1–200 | Maximum supervisor reviews. |
| `reviewTimeoutSeconds` | 30 | 1–300 | Supervisor startup/review deadline; human waiting is separately bounded. |
| `maxActiveSeconds` | 600 | 1–7200 | Cumulative active supervisor review time, excluding human waits. |
| `maxTokens` | 200000 | 1–2000000 | Cumulative reported supervisor tokens. Not a guaranteed billing ceiling. |
| `checkpointSeconds` | 5 | 0–30 | Bounded pre-integration review window; 0 skips it. |

Fixed bounds include a 750 ms event debounce, 4 KiB guidance, 1 KiB reason, up to 32 evidence-sequence references, 16 KiB evidence responses, and 32 KiB review snapshots. The supervisor seed is limited to 128 KiB; an oversized seed disables supervision visibly rather than silently dropping constraints. The decision journal is limited to 4 MiB per run, reserving space for accepted controls' terminal records. These are byte limits, not character limits.

### Inspection, controls, and receipts

Start with `/plan-inspect`, then copy the current identities into commands:

```text
/plan-inspect <runId> T01
/plan-steer <runId> T01 <attemptId> Recheck the task's edge-case test before finalizing.
/plan-inspect <runId> T01
/plan-cancel <runId> T01 <attemptId>
/plan-cancel <runId>
```

The last two commands are alternative cancellation scopes, not required follow-up steps. `attemptId` is opaque and distinct from the display attempt number. Restarts get new IDs. Stale run/attempt controls are rejected; never guess an ID or reuse one from an earlier attempt. Only one create/build operation is owned by this extension runtime at once, including startup and cleanup. Controls do not wait for the parent model turn to finish.

Inspection returns bounded structured observations: assistant text separate from thinking/tool-argument activity, tool evidence, retries, compaction, human waits, queues, usage, session mappings, and control outcomes. Raw thinking is not included in supervisor snapshots. Dashboard output tails are display projections, not authoritative completion or delivery evidence. `/plan-inspect` is capped at 32 KiB; inspect an individual task if the build view is truncated. Its `controlOutcomes` includes advisory proposal text while retained. The supervisor's `inspect_task` can also request validated, bounded file/diff evidence—not arbitrary commands or paths. jj diff evidence uses stored revisions with `--ignore-working-copy`; unsnapshotted edits may require file evidence. Evidence can race workspace changes and is not commit validation.

Each guidance receipt has a `controlId` and status:

- `proposed`: advisory only, no builder delivery. The journal retains a bounded proposal preview, not necessarily the full text.
- `accepted`: persisted admission, not delivery.
- `queued` / `started`: RPC accepted the prompt into a queue or a new turn, not proof that the builder consumed it.
- `delivered`: the parent observed the matching marked user message. This still does not prove the instruction was followed.
- `rejected` / `cancelled` / `delivery-unknown`: inspect the reason; never assume delivery. A `handled` RPC disposition without matching message evidence is rejected, not counted as delivery.

**Steering does not interrupt a running shell tool.** It is delivered after the current assistant turn's tool calls finish, before the next model call; if idle, it can start another turn. Cancellation, not steering, is the stop mechanism. A guidance receipt/delivery deadline is 30 seconds; guidance stuck behind a long tool can time out and prevent integration rather than being presumed delivered.

At settlement, the runner allows only a bounded checkpoint before closing guidance admission. It drains already accepted controls, requires fresh `agent_settled` completion if guidance starts more work, confirms empty queues, and stops/joins the child **before** commit validation. Late controls are rejected. Unknown delivery, control timeouts, or uncertain shutdown retain/fail the task rather than integrating uncertain work. Neither supervision nor checkpoint completion bypasses the one-commit, clean-checkout, conflict, or source-finalization checks. Cancellation cannot undo already integrated work.

### Disablement, questions, and dashboard lifetime

A missing/unavailable supervisor, startup/review failure, exhausted review/time/token budget, or unavailable journal visibly disables supervision; it is not silently restarted forever. Intervention caps reject further guidance. Inspect `supervisionDisableReason`, control receipts, and the dashboard warning. Healthy builders continue under the deterministic watchdog (if enabled); inspection and cancellation remain available. This fallback does not override safety failures: journal I/O failures or uncertain controls can fail an affected task and block integration.

Builder and supervisor questions share a serialized, cancellable parent queue: one visible dialog at a time, with a maximum 300-second deadline starting when enqueued (a shorter requested timeout is honored). Noninteractive runs return unavailable/cancelled responses immediately; silence is never approval. Dismissing a question declines only that question. Only a builder actually awaiting parent-mediated input has its watchdog paused; supervisor reasoning or waiting for its own answer does not pause other builders. Supervisor question timeout/error disables supervision rather than retrying indefinitely.

Closing the dashboard or toggling it with `Alt+X` **does not cancel a build**. Use `/plan-cancel <runId>` explicitly and inspect until ownership is released; cleanup joins owned processes. Task cancellation cancels its questions and clears queued work before aborting, with process-group termination fallback. Build cancellation, errors, session shutdown, and extension reload also stop/join owned children. Do not reload to merely hide the dashboard.

## Build options and restarts

Verification and watchdog controls are independent of supervision:

- `runVerifier` (default `false`) runs the configured verifier agent only after successful integration/finalization when enabled. Neither supervision mode enables it.
- `verifierAgent` (default `"verifier"`) selects that optional post-build reviewer.
- `builderMonitor` (default `true`) enables/disables stuck detection.
- `builderMonitorIntervalSeconds` (default `30`) controls watchdog status checks.
- `builderStuckTimeoutSeconds` (default `900`) cancels an attempt after this many seconds without meaningful structured task progress, excluding its human waits. Inspection, diagnostic stderr, and transport-only chatter do not count as progress.
- `builderMaxRestarts` (default `1`) controls restarts after a stuck cancellation; `0` cancels without restarting.

The monitor fields remain supported compatibility options (the schema labels the first three deprecated). A stuck restart launches a **fresh conversation in the same checkout**, not a resumed session. The parent first joins the old child and inventories retained status/history. The builder must inspect retained edits and any task commit relative to the supplied base. Reuse a completed task commit or amend only that task commit if necessary; never amend the base or create a second task commit. Ambiguous ownership/history blocks restart rather than forcing repair.

## Journals, sessions, and manual recovery

Every build writes an external append-only `decisions.jsonl` under `PI_PLAN_RUN_ROOT/<runId>` or, by default, `~/.pi/plan-runs/<runId>`. The root must be outside source/task checkouts and protected plan/report paths. New run directories are private (0700), and the journal is 0600. `/plan-inspect <runId>`, dashboard details, and the final build summary report the paths.

With advisory or steer selected, each builder attempt has a persistent session under `builder-<sessionId>/` in that run directory; the supervisor has a session under `supervisor-<suffix>/`. Use the recorded `sessionFile`, not a guessed filename. With supervision off, builder sessions remain ephemeral (`--no-session`), although the run journal still records attempt/session identities. Planner/verifier one-shot sessions remain ephemeral.

Journal `attempt` and `session` records map `runId`, `taskId`, opaque `attemptId`, display `attemptNumber`, workspace path, and session ID/file. `control` records track acceptance and terminal outcomes; `decision` records hold bounded reasons, evidence references, and proposal previews. Journal sequence/timestamps and truncation flags aid inspection, but this is not a complete transcript. After the run ends, slash controls no longer attach to it: read the journal/session JSONL files locally and inspect the reported retained workspace status, diffs, and history with the selected VCS. For jj, start with `jj -R <retained-workspace> status --no-pager`; do not manage or repair runner-owned workspaces from a builder task.

**Treat retained transcripts as sensitive.** Persistent sessions can contain prompts, source, tool output, decisions, and model content even though supervisor snapshots exclude raw thinking. Journal size limits do not bound session transcript retention. Sessions and journals survive normal cleanup; there is no automatic retention pruning. Restrict access, review before sharing, and arrange manual retention/deletion only after the run has stopped and recovery needs are resolved.

**There is no automatic crash recovery, transcript replay, or reattachment.** A journal or saved session cannot resume control of a dead run or authorize integration. Existing VCS recovery is authoritative: inspect retained jj workspaces/history or follow the Git recovery JSON and integration-worktree procedure above. A live watchdog restart is not crash recovery. Never treat a saved `done` message or delivery receipt as proof of an integrated commit.

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

## Deployment and tests

This checkout uses individual Stow links, so adding a supervisor definition or helper module does not automatically install it into `~/.pi/agent`. Run only the dry-run check `stow --simulate --verbose pi` from the dotfiles root and inspect its proposed links/conflicts. Do not force, adopt, restow, or prune links while unrelated changes exist. Actual home-directory deployment is not a builder task; see [the agent package deployment guidance](../../README.md#safe-deployment-check).

Run `node --test pi/tests/planner-builder*.test.ts` from the dotfiles root with Node 24+, Git and jj installed. Tests use temporary local repositories, synthetic builder callbacks, and fake RPC subprocesses, never real agents or remotes. No additional dependencies are needed.
