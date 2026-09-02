# Pi extensions

Store pi extension source files here.

Pi will load these from `~/.pi/agent/extensions` once linked by Home Manager.

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

## Workspace initialization

`initialize-workspace.ts` runs on Pi session startup. It searches from the session cwd up to the nearest `flake.nix`, normalizes the repository paths reported by `jj git remote list`, and continues only when at least one exactly matches a line in `~/workspace-repos`. For matching repositories on NixOS with `direnv` installed, it ensures `.envrc` contains `use flake` and `watch_file nix/*.nix`, then runs `direnv allow` from the flake root.

Managed agent runs set `PI_SUBAGENT=1`. When this extension sees that environment variable and `nix` is available, it overrides only that agent process's `bash` tool with wrappers for `cargo`, `bun`, `npm`, `pnpm`, `go`, `just`, and `doppler`. Invocations of those commands run through `nix develop <flake-root> -c`; all other commands run directly. The main Pi process still uses its normal bash tool.

Builder agents opt in to loading extensions, so the startup hook and subagent-only command wrappers run inside planner-builder's locally managed builder subprocesses.

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
| `plan_file_build` | Create ready independent task workspaces with `jj workspace add`, run each `builder` as a locally managed structured subprocess in parallel, stream output into the main dashboard, and serially integrate each atomic `jj` commit. Verifier review is skipped by default; set `runVerifier: true` to run the unchanged structured `verifier` subprocess with the same selection and write `.pi/outputs/findings.html`. |
| `plan_file_list` | List recent plan files. |

It also registers `/plan-create`, `/plan-build`, and `/plan-list`. Pass `--verify` to `/plan-build` to opt into verifier review. Plan builds create workspaces under `PI_PLAN_WORKSPACE_ROOT` or `~/.pi/plan-workspaces` by running `jj workspace add --name <workspace> <path> -r <integrated-head>` directly.

Builder output is streamed from each subprocess into the main planner-builder dashboard. Cancellation and stuck handling terminate the local subprocess, and stuck restarts launch a new subprocess in the same checkout. The last standalone, unfenced `PLAN_TASK_RESULT: done|failed|blocked` line classifies the completed task before commit validation.

Successfully integrated workspaces are forgotten by Jujutsu and deleted. Failed, blocked, cancelled, stuck-exhausted, validation-failed, or conflicted workspaces are retained for inspection. Planner questions and optional verifier review retain their existing locally spawned structured subprocess behavior.

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
