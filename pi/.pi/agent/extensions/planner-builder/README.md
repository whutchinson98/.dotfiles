# Planner-builder extension

Creates planner-generated plan files and dispatches each builder in its own Jujutsu workspace. Planner creation, builder execution, and optional verifier review are managed from the main pi pane as structured subprocesses.

## Commands

| Command | Purpose |
| --- | --- |
| `/plan-create <request>` | Run the `planner` agent using the model and effort currently selected in the main pi process, surface material planner questions through the parent pi UI, then write a plan file under `.pi/plans/`. |
| `/plan-build [--verify] [plan-file] [T01,T02]` | Run `builder` agents in monitored parallel Jujutsu workspaces when tasks are independent. Each completed task must create one atomic `jj` commit, which is integrated serially onto the main workspace. If no file is provided, the latest `.pi/plans/*.md` file is used. |
| `/plan-list` | List recent plan files. |

## Tools

| Tool | Purpose |
| --- | --- |
| `plan_file_create` | Runs a planner agent with the model and effort selected in the main pi process, surfaces material planner questions through the parent pi UI, and saves a structured plan file. |
| `plan_file_build` | Creates task workspaces with `jj workspace add`, starts locally managed builder subprocesses in those workspaces, streams their output into the main planner-builder dashboard, cancels/restarts stuck attempts, and serially integrates atomic per-task `jj` commits. Set `runVerifier: true` to run verifier review afterward; the default is `false`. |
| `plan_file_list` | Lists recent plan files. |

## Workspace integration

For each ready task, the extension creates a checkout under `PI_PLAN_WORKSPACE_ROOT` or `~/.pi/plan-workspaces` with:

```sh
jj workspace add --name <workspace-name> <path> -r <integrated-head>
```

Task workspace names combine the source workspace folder and task ID, for example `macro-test-thing-t01`.

Successfully integrated task workspaces are forgotten with `jj workspace forget` and deleted. Failed, blocked, cancelled, stuck-exhausted, validation-failed, or conflicted task workspaces are retained on disk for inspection.

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

`/plan-build` runs ready tasks in dependency order. Ready tasks with disjoint parsed `Files:` entries can run at the same time in separate Jujutsu workspaces; tasks with unknown or overlapping file sets are held for a later wave. Dependent tasks wait until their dependencies have `Status: done`.

Builders create exactly one atomic commit in their dedicated workspace. After a builder reports `PLAN_TASK_RESULT: done` (or reaches the existing clean no-marker fallback), the main loop validates that exactly one non-empty task commit exists, rebases it onto the current integrated head, checks for conflicts, and advances the integrated head. Retained unsuccessful workspaces are never integrated automatically.
