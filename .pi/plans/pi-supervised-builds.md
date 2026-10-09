---
planFileVersion: 1
createdAt: "2026-10-13T13:21:37.933Z"
request: "Implement the supervised planner-builder loop discussed with the user. User has now authorized implementation. Create actionable builder tasks for implementation in this dotfiles repository, using jj task workspaces and preserving all pre-existing unrelated changes (claude settings, pi MCP configuration/settings deletions/additions). Do NOT touch those unrelated files.\n\nConfirmed current architecture: pi/.pi/agent/extensions/planner-builder/index.ts has a private runAgent (~826) spawning pi --mode json -p --no-session, stdin ignored, independent from generic subagent runner. runBuilderInWorkspace (~1144) watchdog restarts fresh conversations in same checkout. buildPlanFile (~1945) batches independent tasks, serially validates/integrates exactly one nonempty commit each, status runner-owned. Shared dashboard extensions/shared/agent-dashboard.ts. user-question bridge extensions/subagent/user-question.ts injects tools and relays child tool requests to parent. Planner runs then exits; no supervisor. Read actual source/docs for exact details. Existing pi/tests/planner-builder-harness.ts replaces runAgent; tests do not cover real transport.\n\nApproved product scope and recommended decisions (use these instead of unnecessary preference questions):\n- Add opt-in supervision modes off/advisory/steer, off by default preserving existing callers. Example plan_file_build supervisionMode: 'steer' or 'advisory', supervisorAgent default 'supervisor'; /plan-build --supervise (steer), --advisory (advisory). These names can be consolidated for consistency but document clearly.\n- One supervisor per build, owned and stopped by the parent runner, seeded with plan, constraints, acceptance/verification instructions and recorded planning decisions. No recursive orchestration; do NOT give planner unrestricted spawning or supervisor arbitrary write/bash/VCS tools. No autonomous plan rewriting in v1. Don't resume the planner as though its --no-session context persisted.\n- Builders must have live RPC control using installed Pi's documented RPC mode. Preserve isolated cwd, model/effort selection, allowlists, process-group kill fallback, usage/errors and question handling. Keep one-shot planner/verifier/generic subagent unchanged where possible. RPC must continuously read JSONL, correlate command IDs, respect backpressure, handle unexpected exit, use agent_settled for logical completion (not agent_end/process exit), inspect abort/error/length stop reasons, and clear queues before abort. Steering is after current turn's tools, not interruption of a shell tool. Installed runtime @earendil-works/pi-coding-agent 1.2.0 docs at /home/hutch/.local/share/fnm/node-versions/v24.20.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/docs, SDK/RPC examples alongside. Existing code imports @mariozechner compatibility APIs, so preserve working compatibility and don't blindly assume unbundled RpcClient is drop-in; its process-group shutdown/UI support differ.\n- Build a typed bounded event/snapshot/control layer (run/task/attempt IDs; tool evidence, assistant text separate from thinking/tool argument deltas; retry/compaction/awaiting-human state; sequence timestamps; usage). Dashboard text tails must not be authoritative observation. Avoid dumping unlimited transcripts into supervisor context.\n- Supervisor can inspect_build, inspect_task, steer_task, request_user_decision via a narrow injected extension + parent-owned bridge or equivalent safe transport; read-only inspection may include task file/diff evidence via strictly bounded validated APIs, not arbitrary commands. All actions validated by runner against current attempt/state. Advisory mode records proposals but never delivers steering. Steer mode delivers bounded guidance only. Evidence/reason logged. User questions serialized through parent UI with cancellation and noninteractive behavior; do not let waiting for a human look like a stuck builder.\n- Event-driven/debounced supervision on blockers/repeated errors/checkpoints/changed progress with configurable bounded interval, cooldown per task, maximum intervention count and finite supervisor reasoning/usage/time budget (sensible defaults). No busy-loop LLM polling and no blocking stdout consumption while supervisor thinks. Retain deterministic watchdog as fallback. If supervisor fails or budget exhausted, visibly disable supervision, preserve safe build operation and let existing watchdog handle builders; do not silently retry forever.\n- Manual inspection/steering/cancel actions should use the same validated controller path (commands and/or dashboard actions, choose minimal coherent UX); clearly distinguish closing dashboard from cancelling a build.\n- Reject stale attempt controls; close steering window before validating/integrating. Race-safe settled/queued work handling and bounded pre-integration review/checkpoint if needed so finished builders don't integrate while a control is in flight. A steer accepted/queued is not the same as delivered. Preserve one-commit contract on restart; inspect retained work before new commit.\n- Persist sessions for supervised builder attempts and supervisor where feasible, plus append-only bounded decision/control journal outside protected source paths. Persist accepted/delivered/rejected control status and attempt/session mapping, without claiming automatic crash recovery/reattachment unless implemented. Existing VCS recovery remains authoritative. Stop and join owned children on abort, error, session_shutdown, reload. Add active build ownership guard so concurrent commands don't control wrong run. Never bypass jj/Git validation/finalization; verifier remains opt-in and is not supervision.\n- Add supervisor.md (minimal tools, extensions disabled except explicitly injected bridge) and builder/planner prompt guidance only as needed; don't silently broaden tool privileges.\n- Add deterministic transport protocol tests with fake subprocesses and supervisor/control scheduler tests (no real models or remotes): steer receipt/delivery and bounds, advisory no-op, text-only deltas, fast settled races, retry+agent_end+settled, stale attempt, task finishes while control in flight, abort clears queue and descendants, waiting questions, unexpected exit, budget/timeout, lifecycle cleanup; retain Git/jj regression suite. Improve harness as needed. node --test pi/tests/planner-builder*.test.ts is existing regression command.\n- Update extension README, agent README/APPEND_SYSTEM workflow guidance as appropriate so user and model can discover opt-in mode. Keep generic subagent feature expansion out of scope.\n\nFavor maintainable small modules, deterministic safety authority in parent, and a practical fully functional v1. Partition into a few file-disjoint foundational tasks that can run concurrently, then integration and tests/docs depending on them; clearly specify interfaces across tasks and ensure every task one nonempty commit. No verifier-agent review requested (ordinary tests/review by main assistant fine)."
plannerAgent: "planner"
builderAgent: "builder"
status: "pending"
---

> Generated by `plan_file_create` using the `planner` agent.
> Run ready tasks with `/plan-build <this-file>` or ask pi to use `plan_file_build`.
# Plan: Implement Supervised Planner-Builder Execution — Bounded RPC Control in Isolated Task Workspaces

## Context

`pi/.pi/agent/extensions/planner-builder/index.ts` currently contains 2,866 lines. Its private `runAgent()` launches one-shot JSON subprocesses with ignored stdin; `runBuilderInWorkspace()` restarts fresh conversations in the same checkout. `buildPlanFile()` runs independent tasks concurrently, validates and integrates their commits serially, and owns plan status updates. There is no persistent supervisor or live builder control channel.

The installed Pi runtime is `@earendil-works/pi-coding-agent` 1.2.0. Its documented RPC protocol supports long-lived subprocesses, prompt acceptance dispositions, steering, queue clearing, extension UI requests, and `agent_settled`. The installed `RpcClient` does not preserve this extension’s process-group shutdown behavior, so implement a small local transport rather than assuming it is a drop-in replacement. Keep existing `@mariozechner` compatibility imports; the installed extension loader explicitly supports them.

The 40-line `pi/tests/planner-builder-harness.ts` strips imports and replaces `runAgent()`. Existing Git, jj, and scheduler tests exercise integration but not actual subprocess transport. New modules should be independently testable with Node built-ins, injected clocks, and fake subprocesses.

This checkout has colocated `.jj` and `.git` metadata, so implementation tasks must use runner-created **jj task workspaces**. Read-only inspection found these pre-existing unrelated changes:

| Path | Existing state |
|---|---|
| `claude/.claude/settings.json` | Modified |
| `pi/.pi/agent/extensions/linear_mcp.ts` | Deleted |
| `pi/.pi/agent/extensions/mcp_bridge/bridge.ts` | Deleted |
| `pi/.pi/agent/extensions/pulumi_mcp.ts` | Deleted |
| `pi/.pi/agent/mcp.json` | Added |
| `pi/.pi/agent/settings.json` | Modified |

Do not edit, restore, stage separately, or otherwise reconcile these paths. Builders inherit the runner-provided base and commit only their assigned changes. Do not invoke live Pi configuration updates, broad Stow resynchronization, or cleanup of existing dangling MCP links.

Implementation authorization and product decisions are already supplied; no additional preference question is needed. This planning pass made no changes and did not execute tests that create fixtures.

### Implementation decisions

- Use RPC for builder attempts, including unsupervised attempts; retain ephemeral sessions when supervision is off.
- Keep the one-shot planner, verifier, and generic subagent runners unchanged except narrowly necessary lifecycle ownership plumbing.
- Launch one persistent supervisor per supervised build. It receives recorded plan context, not a resumed planner conversation.
- Use a parent-owned controller as the sole authority for inspection, guidance, cancellation, attempt identity, and integration readiness.
- In advisory mode, all guidance requests—including manual requests—become recorded proposals without delivery. Off mode rejects guidance; inspection and cancellation remain available.
- Use command-based manual controls and the existing dashboard. Do not expand the shared dashboard into a general orchestration UI.
- Never enable verifier review implicitly.

### Shared interfaces

These boundaries allow the foundational tasks to run concurrently.

| Boundary | Contract |
|---|---|
| Identity | Every task observation/control carries `runId`, `taskId`, and opaque `attemptId`; display attempt number is separate. |
| Events | Parent-assigned increasing sequence, observation timestamp, discriminated payload, bounded evidence and explicit truncation. |
| Snapshots | Structured task state, assistant text, tool evidence, retries, compaction, human wait, queues, usage, session mapping, and control outcomes. Dashboard tails are projections only. |
| RPC transport | Node-only subprocess wrapper accepting invocation, cwd, env, spawn/clock dependencies; exposes correlated requests, synchronous record subscription, UI replies, settled observation, and idempotent shutdown. |
| Bridge | `createSupervisorBridge()` creates an isolated injected extension; `handleToolStart()` invokes an injected parent dispatcher and writes a bounded response. It does not decide authorization. |
| Controller | `inspectBuild()`, `inspectTask()`, `requestGuidance()`, `cancelTask()`, `cancelBuild()`, and `sealAttemptForIntegration()`. All asynchronous actions revalidate identity/state before acting. |
| Supervisor | `startSupervisor()` returns `notify()`, bounded checkpoint support, and `stop()`. It receives controller capabilities, not filesystem/VCS mutation capabilities. |
| Evidence | Parent-provided workspace identity plus typed file/diff request; no caller-supplied commands, cwd, revisions, or arbitrary absolute paths. |

### Defaults and limits

Expose `supervisionMode`, `supervisorAgent`, and an optional bounded `supervisionOptions` object. Keep byte limits and debounce implementation constants.

| Setting | Default |
|---|---|
| `supervisionMode` | `"off"` |
| `supervisorAgent` | `"supervisor"` |
| `intervalSeconds` | 30; changed-state scheduling only |
| `cooldownSeconds` | 60 per task |
| `maxInterventionsPerTask` / `maxInterventions` | 3 / 20 |
| `maxReviews` | 20 |
| `reviewTimeoutSeconds` | 30 |
| `maxActiveSeconds` | 600 |
| `maxTokens` | 200,000 cumulative reported tokens |
| `checkpointSeconds` | 5 |
| Event debounce | 750 ms |
| Guidance / evidence response / review snapshot | 4 KiB / 16 KiB / 32 KiB |
| Supervisor seed | 128 KiB maximum; disable supervision visibly rather than silently dropping constraints |
| Human question deadline | 300 seconds; serialized and cancellable |
| Decision journal | 4 MiB per run, with reserved capacity for terminal control records |

Validate finite values and clamp documented ranges. Usage limits are enforced when usage becomes observable, not represented as a guaranteed billing ceiling.

---

## Phase 1: Establish Bounded Foundations (TDD)

**Why:** Transport, observation, and bridge safety must work independently before changing the scheduler. T01–T03 have disjoint files and can run concurrently.

**Test first** → `pi/tests/planner-builder-events.test.ts`, `pi/tests/planner-builder-journal.test.ts`, `pi/tests/planner-builder-rpc.test.ts`, `pi/tests/planner-builder-bridge.test.ts`, `pi/tests/planner-builder-evidence.test.ts`

**New files** → Typed state/journal modules, RPC transport and fake child, narrow supervisor bridge, serialized question queue, and bounded evidence reader listed in T01–T03.

**Reference** → Installed `docs/rpc.md`, `docs/rpc-commands.md`, `docs/json.md`, `docs/rpc-extension-ui.md`, `docs/extensions.md`, and corresponding RPC examples.

**Risk:** The transport must continue draining stdout while model reasoning, filesystem responses, or human questions are pending.

---

## Phase 2: Implement Deterministic Control and Agent Lifecycles (TDD)

**Why:** Integration must never race accepted guidance, unfinished RPC work, or an obsolete attempt. Establish this authority before exposing supervision to callers.

**Test first** → `pi/tests/planner-builder-controller.test.ts`, `pi/tests/planner-builder-supervisor.test.ts`, `pi/tests/planner-builder-builder-runner.test.ts`

**New files** → `build-controller.ts`, `supervisor.ts`, `builder-runner.ts`, and `pi/.pi/agent/agents/supervisor.md`.

**Modify** → `index.ts`, the harness, and existing scheduler/jj tests as specified in T06.

T04 follows the foundations. T05 and T06 can then run concurrently.

**Risk:** A successful RPC response is acceptance, not delivery or completion. Retained work must be inspected before restarted builders create or amend their single task commit.

---

## Phase 3: Connect Supervision and Parent Controls (TDD)

**Why:** The feature needs a discoverable opt-in interface, a single active owner, and cancellation that survives dashboard closure and runtime shutdown.

**Test first** → `pi/tests/planner-builder-controls.test.ts`, `pi/tests/planner-builder-lifecycle.test.ts`

**Modify** → `index.ts`, `dashboard.ts`, and `planner-builder-harness.ts`.

**New file** → `pi/.pi/agent/extensions/planner-builder/controls.ts`

T07 depends on both lifecycle implementations.

**Risk:** Background slash commands currently have no owned cancellation signal, and `session_shutdown` only hides the dashboard. Ownership must be acquired before asynchronous startup and released only after cleanup finishes.

---

## Phase 4: Prove Integration and Document Operation

**Why:** Transport unit tests alone cannot demonstrate that supervised tasks still obey VCS validation, cleanup, and source-preservation rules.

**Test first** → `pi/tests/planner-builder-supervised.test.ts`

**Modify** → Fake subprocess fixtures, jj regressions, extension documentation, agent guidance, and workflow instructions listed in T08–T09.

T08 and T09 can run concurrently after T07.

**Risk:** This repository uses individual Stow links; adding repository files does not automatically install new supervisor/module links. Document deployment without changing unrelated configuration.

---

## Builder Tasks

### Task T01: Define bounded build observations and decision persistence
Status: pending
Depends on: none
Files:
- pi/.pi/agent/extensions/planner-builder/build-state.ts
- pi/.pi/agent/extensions/planner-builder/run-journal.ts
- pi/tests/planner-builder-events.test.ts
- pi/tests/planner-builder-journal.test.ts
Instructions:
- Create Node-only types and reducers for run/task/attempt identities, task phases, typed observations, snapshots, usage, session mappings, and control status transitions. Export shared supervision configuration normalization and limits.
- Write tests first for increasing sequences, immutable snapshots, bounded event/evidence storage, stale-attempt observations, and visible truncation.
- Normalize documented RPC records without treating every string delta as assistant text. Handle text blocks by content index; keep thinking and tool-argument activity separate and exclude raw thinking from supervisor snapshots.
- Treat `message_end` as authoritative. Account for streaming usage cumulatively per message, without double-counting final messages or `agent_end.messages`. Include retry, compaction, tool-result usage, and final error/abort/length outcomes.
- Represent transport activity separately from meaningful task progress; snapshot inspection must not reset watchdog progress.
- Model guidance as proposed, accepted, queued/started, delivered, rejected, cancelled, or delivery-unknown. Include control ID, origin, reason, evidence sequences, and timestamps.
- Implement serialized append-only JSONL persistence with restrictive permissions, schema version, byte limits, and capacity reserved for accepted controls’ terminal records. Do not store complete transcripts in the journal.
- Accept an externally supplied run directory. Record attempt/session identity and mappings there; do not write beneath source checkouts or protected plan/report paths.
- Before exhausting capacity, refuse new controls and expose a disable reason. Journal I/O failures must surface to the controller, not silently discard an accepted action.
- Create exactly one nonempty task commit; do not modify the active plan, runner output, or unrelated configuration.
Verification:
- `node --test pi/tests/planner-builder-events.test.ts pi/tests/planner-builder-journal.test.ts`
- Confirm tests cover multibyte byte limits, duplicate usage records, oversized evidence, append ordering, capacity reservation, and journal write failure.

### Task T02: Implement a continuously drained RPC subprocess transport
Status: pending
Depends on: none
Files:
- pi/.pi/agent/extensions/planner-builder/rpc-agent.ts
- pi/tests/fixtures/planner-builder-rpc-child.mjs
- pi/tests/planner-builder-rpc.test.ts
Instructions:
- Implement a Node-only RPC wrapper accepting an explicit executable/argument invocation, cwd, environment, and injectable spawn/clock dependencies. Do not import the installed unbundled `RpcClient`.
- Use the installed 1.2.0 RPC documentation and examples as protocol references. Preserve detached process groups on supported platforms and bounded stderr capture.
- Continuously decode UTF-8 JSONL using LF boundaries, accepting CRLF and preserving Unicode line separators inside strings. Bound individual records, incomplete-line buffers, pending requests, and queued writes; fail visibly on protocol corruption or overflow.
- Correlate responses by unique command ID and expected command. Handle out-of-order replies, unsuccessful responses, malformed records, unknown events, stdin errors, startup errors, and unexpected exit.
- Honor stdin backpressure without serializing all response waits behind one another. Stdout handlers must never await supervisor reasoning or human UI.
- Register completion listeners before writing prompts. Track settled generations so a fast `agent_settled` before the command response cannot be missed. Return prompt dispositions explicitly; `"handled"` must not wait indefinitely for a nonexistent run.
- Expose queue/state events and extension UI records without conflating them with command responses. Support bounded asynchronous UI handling and cancellation responses.
- Implement idempotent stop: close admission, clear queued work before abort, wait with deadlines, close stdin for orderly shutdown, then escalate to process-group TERM/KILL when necessary. Continue draining output until the child closes.
- Reject all outstanding requests and completion waiters on terminal failure. Remove timers/listeners and join owned processes; ensure group cleanup still considers descendants when the direct child has already exited.
- Build deterministic fake-child scenarios rather than invoking Pi, models, credentials, or remotes.
Verification:
- `node --test pi/tests/planner-builder-rpc.test.ts`
- Cover split UTF-8/JSONL, CRLF, Unicode separators, backpressure, reordered responses, handled prompts, fast settling, retry followed by `agent_end` then settlement, unexpected exit, stalled shutdown, and descendant termination.

### Task T03: Add narrow supervisor tools and bounded parent-side evidence
Status: pending
Depends on: none
Files:
- pi/.pi/agent/extensions/planner-builder/supervisor-bridge.ts
- pi/.pi/agent/extensions/planner-builder/question-queue.ts
- pi/.pi/agent/extensions/planner-builder/task-evidence.ts
- pi/tests/planner-builder-bridge.test.ts
- pi/tests/planner-builder-evidence.test.ts
Instructions:
- Follow the existing injected-extension pattern in `extensions/subagent/user-question.ts`, without modifying that file or the generic subagent runner.
- Generate an isolated bridge extension registering only `inspect_build`, `inspect_task`, `steer_task`, and `request_user_decision`. Tools dispatch through parent-observed tool-start records and bounded response files.
- Keep transport independent of authorization: inject a dispatcher callback. Bind launch identity in the parent, never trust child-supplied run identity to select another build.
- Use a private directory and collision-resistant response filenames derived from complete tool-call IDs. Validate request/response sizes, track duplicate requests, bound outstanding work, atomically publish responses, and remove transient files only after pending work is cancelled/joined.
- Provide a serialized parent question queue shared across children. Support queued cancellation, active cancellation, timeout, and immediate noninteractive fallback. Expose waiting-start/end callbacks; do not import TUI packages into its core.
- Adapt ordinary RPC select/confirm/input/editor requests into that queue while retaining their response semantics. Fire-and-forget notifications must not become blocking questions.
- Implement bounded text-file and diff evidence APIs operating only on parent-supplied task workspace metadata. Reject traversal, absolute paths, escaping symlinks, metadata paths, protected paths, nested checkout crossings, binary/special files, and excessive reads.
- Diff operations must use fixed argument arrays, trusted base revisions, time/output limits, disabled external diff/text conversion and hooks where applicable, and no shell evaluation. jj inspection must use `--ignore-working-copy`; report that unsnapshotted edits may require file evidence.
- Evidence responses must identify observation time, truncation, and possible concurrent workspace changes. They are evidence, not integration validation.
- Keep these modules independent of T01/T02 so all three foundation tasks can run concurrently.
Verification:
- `node --test pi/tests/planner-builder-bridge.test.ts pi/tests/planner-builder-evidence.test.ts`
- Test bridge cancellation/duplicates, question serialization, unavailable UI, malicious IDs/paths, symlink escapes, bounded diff output, and absence of arbitrary command execution.

### Task T04: Enforce validated controls and an integration barrier
Status: pending
Depends on: T01, T02, T03
Files:
- pi/.pi/agent/extensions/planner-builder/build-controller.ts
- pi/tests/planner-builder-controller.test.ts
Instructions:
- Create the parent-owned controller using the state/journal modules, RPC adapter, and bounded evidence API. Inject clocks, transport factories, and persistence for deterministic tests.
- Register attempts with opaque IDs and their current workspace/session mapping. Validate run, task, attempt, state, payload bounds, evidence references, cooldown, and intervention limits for every guidance action.
- Advisory mode records proposals but never writes guidance to a builder. Off mode rejects guidance. Manual and supervisor guidance use the same authorization path.
- Reserve an in-flight control before asynchronous journal/RPC work; revalidate before sending. Persist acceptance before delivery attempts.
- Wrap guidance in plain text containing an unambiguous control marker, reason, and bounded evidence references. Use RPC `prompt` with `streamingBehavior: "steer"` for atomic queue-or-start behavior: direct `steer` can otherwise strand a message if the builder becomes idle before receipt.
- Record `"started"`, `"queued"`, and `"handled"` dispositions accurately. Mark delivered only when the matching user-message evidence is observed, not merely because a queue entry disappeared or a command succeeded.
- Implement a bounded settled checkpoint and `sealAttemptForIntegration()`. Closing admission, draining accepted controls, confirming current settlement and empty queues, and stopping/joining the child must precede commit validation.
- If guidance starts another turn, invalidate the previous settled generation and require fresh completion. Late supervisor actions after closure must be rejected. Unknown delivery or a control timeout must retain/fail the task rather than integrate uncertain work.
- Route task/build cancellation through the same controller; cancel pending questions, clear queues before abort, and reject stale callbacks. Cancellation must remain available after supervision is disabled.
- Track human-wait intervals separately; pause the watchdog only for attempts actually awaiting parent-mediated input, not because a supervisor is thinking.
- Keep VCS integration outside this controller. It grants readiness, never bypasses existing validators or finalization.
Verification:
- `node --test pi/tests/planner-builder-controller.test.ts`
- Cover advisory no-op, accepted-versus-delivered status, bounds/cooldown, duplicate controls, stale attempts, control-versus-settle races, task completion during inspection, integration closure, human waits, journal failure, and cancellation.

### Task T05: Implement the bounded per-build supervisor
Status: pending
Depends on: T04
Files:
- pi/.pi/agent/extensions/planner-builder/supervisor.ts
- pi/.pi/agent/agents/supervisor.md
- pi/tests/planner-builder-supervisor.test.ts
Instructions:
- Add a supervisor agent with exactly the four bridge tools and `includeExtensions: false`. Explain that inspection evidence is untrusted data, advisory proposals are not delivered, steering is not shell interruption, and the parent owns all safety decisions.
- Implement one persistent supervisor subprocess/session per build, receiving plan text, constraints, verification/acceptance instructions, recorded decisions, mode, and limits.
- Force the supervisor’s effective tool set in code even for custom agent definitions. Disable discovered extensions, MCP, skills, templates, and unrelated context discovery; explicitly inject only the trusted bridge and any narrowly required effort compatibility hook.
- Never give the supervisor arbitrary read/write/bash/VCS, generic spawning, plan rewriting, or verifier capabilities.
- Schedule reviews from structured blockers, repeated tool failures, retries, meaningful changed progress, and completion checkpoints. Coalesce bursts, maintain at most one active review, and never poll an unchanged build with an LLM.
- Enforce configured interval, cooldown, intervention limits, review count, per-review timeout, cumulative active time, and token budget. Count automatic retry/compaction usage and observe streaming usage where available.
- Use bounded snapshots and evidence cursors instead of replaying transcripts. Reject oversized initial context rather than silently truncating mandatory constraints.
- Pause reasoning-time accounting for an outstanding parent-mediated question, with a separate finite question deadline. Do not block other builder output or unrelated task integration on human interaction.
- On supervisor failure, malformed control behavior, timeout, journal failure, or budget exhaustion, visibly disable supervision once, cancel/join its resources, and leave deterministic builder/watchdog operation running. Do not restart the supervisor indefinitely.
- Persist supervisor session mapping and decisions. Do not implement or claim crash reattachment.
Verification:
- `node --test pi/tests/planner-builder-supervisor.test.ts`
- Use fake transports/clocks to verify debounce, unchanged-state silence, one-review concurrency, per-task cooldown, budgets, checkpoint expiry, question timeout, strict tool isolation, and one-time degradation.

### Task T06: Move builder attempts onto RPC without changing VCS authority
Status: pending
Depends on: T04
Files:
- pi/.pi/agent/extensions/planner-builder/builder-runner.ts
- pi/.pi/agent/extensions/planner-builder/index.ts
- pi/tests/planner-builder-harness.ts
- pi/tests/planner-builder-scheduler.test.ts
- pi/tests/planner-builder-jj.test.ts
- pi/tests/planner-builder-builder-runner.test.ts
Instructions:
- Extract builder-attempt lifecycle into `builder-runner.ts` and replace only the builder call path. Retain one-shot `runAgent()` for planner/verifier and leave the generic subagent runner untouched.
- Preserve existing invocation resolution, isolated cwd, selected model/effort including max-effort compatibility, tool allowlists, extension settings, subprocess environment markers, usage, stderr, and progress output.
- Do not silently add tools to builder definitions. When `ask_user` is already allowed, inject the existing question bridge and route it through the shared parent question queue; also handle RPC extension dialogs.
- Allocate fresh attempt IDs on watchdog restarts. Persist supervised attempts using unique session IDs/directories outside the checkout and record actual `get_state` mappings. Off mode stays ephemeral.
- Use structured activity for watchdog monitoring. Suspend idle accounting while the attempt is queued for or displaying a human question; resume with a fresh activity baseline afterward.
- Aggregate usage and attempt summaries across restarts. Distinguish retryable intermediate error/length responses from the final settled outcome; terminal aborted/error/length results cannot use the no-marker success fallback.
- Keep the child alive through the controller’s completion barrier, then stop/join it before returning a result for integration.
- Before restarting, inspect retained workspace state and history. Include a bounded resume inventory and prior attempt/control summary in the new prompt; do not claim conversational continuity.
- Strengthen both jj and Git builder prompts: if the task commit already exists, inspect and reuse or amend only that task commit as necessary; never create a second task commit or amend the supplied base. Ambiguous/multiple-commit state must block safely.
- Keep `detectVcs()`, jj integration, `GitBackend`, protected-path validation, serial integration, and opt-in verifier behavior intact.
- Improve the harness with explicit builder transport/lifecycle injection while preserving one-shot agent stubs. Update existing scheduler/jj tests rather than continuing to pretend `runAgent` mocks cover RPC.
Verification:
- `node --test pi/tests/planner-builder-builder-runner.test.ts pi/tests/planner-builder-scheduler.test.ts pi/tests/planner-builder-jj.test.ts pi/tests/planner-builder-git.test.ts`
- Verify off-mode compatibility, session persistence only when requested, restart after an existing commit, retained dirty work, waiting-human watchdog behavior, and terminal length/error classification.

### Task T07: Wire supervision options, ownership, and manual controls
Status: pending
Depends on: T05, T06
Files:
- pi/.pi/agent/extensions/planner-builder/index.ts
- pi/.pi/agent/extensions/planner-builder/controls.ts
- pi/.pi/agent/extensions/planner-builder/dashboard.ts
- pi/tests/planner-builder-harness.ts
- pi/tests/planner-builder-controls.test.ts
- pi/tests/planner-builder-lifecycle.test.ts
Instructions:
- Extend `plan_file_build` with `supervisionMode`, `supervisorAgent`, and bounded `supervisionOptions`; default to off. Add `/plan-build --supervise` for steer and `--advisory` for advisory; reject conflicting/unknown flags clearly.
- Connect one build controller and, when requested, one supervisor to `buildPlanFile()`. Include the supervisor in trusted-project-agent confirmation without expanding its effective privileges.
- Store run journals and supervised sessions under an external per-run directory, such as `~/.pi/plan-runs/<runId>/`; canonicalize any configurable root and reject source/task-checkout locations.
- Establish one active planner-builder operation owner per extension runtime before background startup or `waitForIdle()`. Both tool and command entry points must honor it.
- Register `/plan-inspect [runId] [taskId]`, `/plan-steer <runId> <taskId> <attemptId> <guidance>`, and `/plan-cancel <runId> [taskId attemptId]`. Require explicit identities for mutations; route all actions through the controller.
- Manual control handlers must work while the parent is busy rather than waiting for the build to finish. Include control receipt/status in output and preserve advisory/off policy.
- Add an owned AbortController and completion promise for background commands. On abort, error, `session_shutdown`, or reload, close control admission, cancel questions, stop/join supervisor and builders, flush the journal, and release ownership in an idempotent finally path.
- Before VCS validation/integration, require the sealed attempt result. Keep runner-owned plan status/report handling unchanged and never turn supervision into verification.
- Persist the planner’s answered/cancelled/unavailable question records in a bounded runner-authored plan section during creation. Seed supervision from these records and plan guidance; older plans without records must still work.
- Project supervision status, run/attempt IDs, human wait, control outcomes, budget-disable reasons, and journal/session paths into `PlanBuildDetails` and the planner-builder dashboard wrapper. Leave `shared/agent-dashboard.ts` unchanged.
- Clearly display that dashboard close/toggle does not cancel a build. Cancellation uses `/plan-cancel`; closing a question can decline that question without cancelling its build.
- Prevent nested planner-builder orchestration in child processes; do not broaden generic subagent functionality.
Verification:
- `node --test pi/tests/planner-builder-controls.test.ts pi/tests/planner-builder-lifecycle.test.ts`
- `node --test pi/tests/planner-builder*.test.ts`
- Test competing background starts, command/tool ownership, stale commands, flag parsing, default off, missing supervisor degradation, UI closure versus cancellation, parent abort, and awaited reload cleanup.

### Task T08: Add end-to-end supervised transport and source-preservation regressions
Status: pending
Depends on: T07
Files:
- pi/tests/planner-builder-supervised.test.ts
- pi/tests/fixtures/planner-builder-rpc-child.mjs
- pi/tests/planner-builder-jj.test.ts
Instructions:
- Add end-to-end tests that run the production RPC transport and controller against fake subprocesses. Do not replace `runAgent()` or bypass the new builder transport for these scenarios.
- Extend the fake child with scripted builder/supervisor behavior, using only disposable local repositories and fake usage. Never invoke real models, Pi credentials, MCP, or remotes.
- Exercise running-turn guidance, idle-race guidance, queued-versus-delivered reporting, advisory no-op, text-only deltas, retry/compaction followed by final settlement, and out-of-order command responses.
- Cover a task settling while a control is in flight, a late supervisor request after admission closes, stale controls after restart, unexpected child exit, exhausted budgets, question waits, cancellation during backpressure, and process-tree cleanup.
- Assert no commit validation/integration begins while accepted guidance, ambiguous delivery, queued work, or an owned builder process remains active.
- Add supervised Git and jj scenarios demonstrating exactly one nonempty commit per task, dependency-wave history, failed-task retention, protected plan/report rejection, and verifier remaining disabled by default.
- Add a jj source-preservation fixture containing pre-existing modified files, deleted files, and an added configuration file matching the categories observed here. Assert their bytes/absence remain unchanged and they do not enter task commit diffs.
- Verify retained sessions/journal mappings survive successful workspace deletion, while temporary bridge files, timers, listeners, and child processes do not.
- Keep existing Git/jj safety tests intact. If a regression exposes a defect outside assigned files, report the precise blocker rather than widening the commit.
Verification:
- `node --test pi/tests/planner-builder-supervised.test.ts pi/tests/planner-builder-jj.test.ts`
- `node --test pi/tests/planner-builder*.test.ts`
- `node --test --test-concurrency=1 pi/tests/planner-builder*.test.ts`
- All commands must terminate without leaked children, use no models/remotes, and pass both parallel and serial test execution.

### Task T09: Document opt-in supervision and safe operating guidance
Status: pending
Depends on: T07
Files:
- pi/.pi/agent/extensions/planner-builder/README.md
- pi/.pi/agent/extensions/README.md
- pi/.pi/agent/README.md
- pi/.pi/agent/APPEND_SYSTEM.md
- pi/.pi/agent/agents/builder.md
- pi/.pi/agent/agents/planner.md
Instructions:
- Document tool examples using `supervisionMode: "steer"` and `"advisory"`, `/plan-build --supervise`, `/plan-build --advisory`, supervisor selection, normalized limits, and off-by-default behavior.
- Explain manual inspection, identity-qualified steering/cancellation, advisory proposals, delivery receipts, checkpoint closure, and why steering does not interrupt a running shell tool.
- Explain supervisor disablement and watchdog fallback, human-question serialization/deadlines, and dashboard closure versus build cancellation.
- Document external journal/session locations, sensitive transcript retention, attempt mappings, and manual inspection. Explicitly state there is no automatic crash recovery or reattachment; existing VCS recovery is authoritative.
- Preserve the distinction between supervision and opt-in verifier review. Update model-facing workflow guidance without making supervision or verifier review automatic.
- Update builder guidance for fresh-conversation restarts, retained-work inspection, and preserving/amending the existing single task commit. Do not broaden its tool list or extension privileges.
- Update planner guidance to record approved decisions, constraints, and verification criteria explicitly in plans. Do not give the planner supervisor/spawning tools.
- Update only relevant workflow documentation; leave unrelated MCP documentation/configuration changes outside this task.
- Explain that this checkout uses individual Stow links. Provide a dry-run deployment check and warn against force/adopt/restow/prune while unrelated changes exist; actual home-directory deployment is not a builder task.
Verification:
- `node --test pi/tests/planner-builder*.test.ts`
- `stow --simulate --verbose pi`
- Check documented command names/defaults against `controls.ts` and `PlanBuildParams`, and confirm neither agent’s existing tool privileges were expanded.

---

## Critical Files

All paths below are repository-relative.

| File | Action |
|---|---|
| `pi/.pi/agent/extensions/planner-builder/build-state.ts` | New: contracts, bounded observations, configuration |
| `pi/.pi/agent/extensions/planner-builder/run-journal.ts` | New: append-only bounded decision journal |
| `pi/.pi/agent/extensions/planner-builder/rpc-agent.ts` | New: subprocess protocol transport |
| `pi/.pi/agent/extensions/planner-builder/supervisor-bridge.ts` | New: narrow injected tools |
| `pi/.pi/agent/extensions/planner-builder/question-queue.ts` | New: serialized parent interaction |
| `pi/.pi/agent/extensions/planner-builder/task-evidence.ts` | New: validated bounded inspection |
| `pi/.pi/agent/extensions/planner-builder/build-controller.ts` | New: control authority and integration barrier |
| `pi/.pi/agent/extensions/planner-builder/supervisor.ts` | New: bounded event-driven supervisor |
| `pi/.pi/agent/extensions/planner-builder/builder-runner.ts` | New: RPC attempts and watchdog lifecycle |
| `pi/.pi/agent/extensions/planner-builder/controls.ts` | New: manual-control parsing/adapters |
| `pi/.pi/agent/extensions/planner-builder/index.ts` | Modify: lifecycle wiring, options, ownership |
| `pi/.pi/agent/extensions/planner-builder/dashboard.ts` | Modify: planner-builder-specific presentation |
| `pi/.pi/agent/agents/supervisor.md` | New: restricted supervisor prompt |
| `pi/.pi/agent/agents/builder.md` | Modify: steering/restart commit guidance |
| `pi/.pi/agent/agents/planner.md` | Modify: recorded decisions and constraints |
| `pi/.pi/agent/extensions/planner-builder/README.md` | Modify: operating reference |
| `pi/.pi/agent/extensions/README.md` | Modify: workflow discoverability |
| `pi/.pi/agent/README.md` | Modify: supervision overview |
| `pi/.pi/agent/APPEND_SYSTEM.md` | Modify: opt-in workflow guidance |
| `pi/tests/planner-builder-harness.ts` | Modify: explicit test injection boundaries |
| `pi/tests/planner-builder-scheduler.test.ts` | Modify: builder lifecycle injection |
| `pi/tests/planner-builder-jj.test.ts` | Modify: injection and preservation regressions |
| `pi/tests/fixtures/planner-builder-rpc-child.mjs` | New: deterministic fake subprocess |
| `pi/tests/planner-builder-events.test.ts` | New: event/snapshot tests |
| `pi/tests/planner-builder-journal.test.ts` | New: persistence tests |
| `pi/tests/planner-builder-rpc.test.ts` | New: protocol/process tests |
| `pi/tests/planner-builder-bridge.test.ts` | New: bridge/question tests |
| `pi/tests/planner-builder-evidence.test.ts` | New: inspection safety tests |
| `pi/tests/planner-builder-controller.test.ts` | New: authorization/race tests |
| `pi/tests/planner-builder-supervisor.test.ts` | New: scheduler/budget tests |
| `pi/tests/planner-builder-builder-runner.test.ts` | New: attempt/watchdog tests |
| `pi/tests/planner-builder-controls.test.ts` | New: command/control tests |
| `pi/tests/planner-builder-lifecycle.test.ts` | New: ownership/shutdown tests |
| `pi/tests/planner-builder-supervised.test.ts` | New: transport-through-integration tests |
| `pi/.pi/agent/extensions/planner-builder/vcs.ts` | Reference: unchanged VCS authority |
| `pi/.pi/agent/extensions/planner-builder/result-marker.ts` | Reference: unchanged marker parser |
| `pi/.pi/agent/extensions/subagent/user-question.ts` | Reference/reuse: existing question bridge/UI |
| `pi/.pi/agent/extensions/subagent/agents.ts` | Reference/reuse: agent discovery |
| `pi/.pi/agent/extensions/shared/agent-dashboard.ts` | Reference/reuse: existing dashboard |
| `pi/tests/planner-builder-git.test.ts` | Reference/run: unchanged Git regression suite |
| `pi/tests/planner-builder-fixtures.ts` | Reference/reuse: disposable Git fixtures |

## Reusable Components (no changes needed)

- **`detectVcs()` and `GitBackend`** — retain nearest-checkout detection, cleanliness checks, recovery records, isolated integration, and safe finalization.
- **jj validation/integration helpers** — remain the authority for one-commit validation and serial integration.
- **`parsePlanTaskResultMarker()`** — retain existing standalone-marker semantics.
- **`surfaceUserQuestion()` and question bridge helpers** — reuse through a build-wide serialization adapter.
- **`AgentDashboard`** — retain navigation, rendering, and question UI; keep control authority elsewhere.
- **`discoverAgents()`** — discover supervisor definitions without changing generic agent behavior.
- **One-shot planner/verifier and generic subagent execution** — remain outside the RPC-builder feature expansion.

## Verification

1. Run `node --test pi/tests/planner-builder*.test.ts`, then repeat with `--test-concurrency=1`. Both must pass without models, remotes, or leaked processes.
2. Inspect each task commit with jj: exactly one nonempty commit, assigned paths only, and no active plan/report edits. Preserve the six unrelated paths’ original contents or deletion state.
3. Exercise the fake supervised build in off, advisory, and steer modes; verify accepted, queued, delivered, rejected, and cancelled outcomes match actual child events.
4. Confirm integration never starts before the control barrier closes and owned builders stop. Repeat with restart, human wait, timeout, and unexpected exit.
5. Check dashboard hide/show separately from explicit cancellation; verify reload/session shutdown joins children and releases ownership.
6. Run `stow --simulate --verbose pi` only as a deployment preview. Do not apply broad configuration/link cleanup as part of these tasks.
7. Main-assistant review should inspect privilege restrictions, cancellation ordering, journal bounds, and unchanged VCS validation. No verifier-agent review is requested.
