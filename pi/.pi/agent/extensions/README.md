# Pi extensions

Store pi extension source files here.

Pi loads these from `~/.pi/agent/extensions`. This checkout uses individual Stow links; new files need a separate deployment review. See [safe deployment checks](../README.md#safe-deployment-check), not a broad home-directory resynchronization.

Examples:

```text
extensions/
├── my-extension.ts
└── larger-extension/
    ├── index.ts
    └── helpers.ts
```

Extension files should default-export a function that receives `ExtensionAPI`.

## Dashboard UI

`dashboard/` is the local adaptation of the UI ideas from `davis7dotsh/my-pi-setup`:

- gradient pi header
- two-line footer with cwd, model/effort, context usage, cost, tokens/sec, and Jujutsu status
- themed working spinner
- `/dashboard [on|off|refresh]`
- `/github-theme` to switch to the bundled `github-dark-default` theme

The VCS status is intentionally Jujutsu-based and does not call `git`.

## File search

`file-search/` registers first-class `fd` and `rg` tools. Unlike the upstream example, it does not download fallback binaries at startup; `fd` and `ripgrep` are installed by Nix in `modules/dev/ai.nix`. It probes all PATH candidates and uses the first executable that actually runs, so stale downloaded binaries under `~/.pi/agent/bin` do not shadow the Nix binaries.

## Subagents

`subagent/` registers:

| Tool | Purpose |
| --- | --- |
| `agent_list` | List agents discovered from `~/.pi/agent/agents` and, when requested, trusted project `.pi/agents` directories. |
| `subagent` | Spawn one or more agents in isolated `pi --mode json --no-session` subprocesses. |

Subagent subprocesses use `--no-extensions` by default unless an agent frontmatter sets `includeExtensions: true`; pass `includeExtensions` to the tool to override that behavior for a specific call. If an agent's tool allowlist contains `ask_user`, the extension injects an isolated question bridge so the subprocess can pause, send a system notification, collect a suggested or custom answer in the live dashboard, and continue. Concurrent agent questions are announced and shown one at a time.

Subagent calls open a full-screen dashboard modeled after `davis7dotsh/my-pi-setup`: every running agent is visible in the bordered list, each row opens a full-height live output view, and pending questions temporarily replace the navigator with an interactive response view. It also registers `/subagents` to hide or restore that dashboard and `/agents [user|project|both]` for interactive discovery.

## Planner-builder workflow

`planner-builder/` registers:

| Tool | Purpose |
| --- | --- |
| `plan_file_create` | Run the `planner` agent with the model and effort selected in the main pi process, show its live output in the full-screen subagent dashboard, surface material planner questions through the parent UI, and save a structured plan file under `.pi/plans`. |
| `plan_file_build` | Auto-select jj workspaces when checkout `.jj` metadata exists, otherwise Git worktrees. Run independent builders in parallel and serially integrate one non-empty commit per task. Git requires locally committed clean source on an attached branch (not pushed) and safely fast-forwards from a separate integration checkout. Verifier review is skipped by default; set `runVerifier: true` to run the unchanged structured `verifier` subprocess with the same selection and write `.pi/outputs/findings.html`. |
| `plan_file_list` | List recent plan files. |

It registers `/plan-create`, `/plan-build`, and `/plan-list`. **Supervision and verifier review are independently off by default.** Use `/plan-build --supervise` or `plan_file_build` with `supervisionMode: "steer"` for bounded live guidance; use `--advisory` or `supervisionMode: "advisory"` for recorded proposals only, including manual requests. The tool's `supervisorAgent` defaults to `"supervisor"`; `supervisionOptions` supplies normalized bounded limits. Only `--verify` or `runVerifier: true` enables the separate post-build verifier.

Manual controls are `/plan-inspect [runId] [taskId]`, `/plan-steer <runId> <taskId> <attemptId> <guidance>`, and `/plan-cancel <runId> [taskId attemptId]`. Copy current identities from inspection; stale attempts are rejected. Accepted/queued guidance is not delivered until matching message evidence is observed. Steering waits for current-turn tools and cannot interrupt a shell command. Closing/toggling the dashboard with `Alt+X` does not cancel a build; use `/plan-cancel` explicitly. Human questions are serialized with finite deadlines, and supervisor failure/budget exhaustion visibly disables supervision while healthy builders retain watchdog handling.

Plan builds create checkouts under `PI_PLAN_WORKSPACE_ROOT` or `~/.pi/plan-workspaces` using `jj workspace add` or `git worktree add` from the latest integrated head. Colocated repos prefer jj; broken jj is an error, never a Git fallback. Builder RPC output streams into the dashboard, but structured state—not display tails—controls completion. Before validation the parent closes guidance admission, drains controls, and stops/joins the settled child. The last standalone, unfenced `PLAN_TASK_RESULT: done|failed|blocked` line classifies the completed task before commit validation.

Stuck restarts use a fresh conversation in the same checkout. Builders must inspect retained edits/history and reuse or amend their existing single task commit, never add a second. Successfully integrated jj workspaces are forgotten and deleted. Git cleans up only after safe source finalization, without force-removing new work; interrupted builds retain an integration branch/worktree and recovery JSON. Failed, blocked, cancelled, stuck-exhausted, validation-failed, or conflicted workspaces are retained for inspection. Planner questions and optional verifier review retain their one-shot subprocess behavior.

Run journals live under `PI_PLAN_RUN_ROOT` or `~/.pi/plan-runs`; supervised builder/supervisor sessions are retained there with attempt mappings. Treat transcripts as sensitive: they are not automatically pruned. There is no automatic crash recovery or reattachment; existing VCS recovery is authoritative. See [planner-builder/README.md](planner-builder/README.md) for examples, exact limits, receipts/checkpoints, question deadlines, manual inspection, Git preconditions, verifier bases, and recovery instructions.

## Remote MCP extensions

`linear_mcp.ts` and `pulumi_mcp.ts` use the reusable helper in `mcp_bridge/bridge.ts` to start remote MCP servers. The bridge is lazy by default: startup only registers a small loader tool, and the remote MCP process is started/listed when the loader tool or reload command is used. Set `loadOnSessionStart: true` in a bridge config to opt back into eager loading. On Linux it uses the Nix/Home Manager `mcp-remote` command; on macOS and other platforms it uses `npx -y mcp-remote`.

Equivalent commands:

```text
# Linux / NixOS
mcp-remote https://mcp.linear.app/mcp
mcp-remote https://mcp.ai.pulumi.com/mcp

# macOS / other
npx -y mcp-remote https://mcp.linear.app/mcp
npx -y mcp-remote https://mcp.ai.pulumi.com/mcp
```

`modules/dev/ai.nix` installs `mcp-remote` as a Nix/Home Manager command wrapper for Linux/NixOS. The wrapper runs `npx -y mcp-remote` with Nix's `nodejs` in PATH.

Registered loader tools, tool prefixes, and commands:

| Extension | Loader tool | MCP tool prefix after load | Commands |
| --- | --- | --- | --- |
| `linear_mcp.ts` | `linear_mcp_load` | `linear_` | `/linear-mcp-status`, `/linear-mcp-reload` |
| `pulumi_mcp.ts` | `pulumi_mcp_load` | `pulumi_` | `/pulumi-mcp-status`, `/pulumi-mcp-reload` |

The first lazy load may require the OAuth flow that `mcp-remote` opens/prompts for.
