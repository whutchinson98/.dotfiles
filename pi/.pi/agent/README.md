# Hutch pi agent package

User-scoped pi resources linked into `~/.pi/agent`. This dotfiles checkout uses individual Stow links (`.stowrc` sets `--no-folding`), not a single linked package directory.

This directory intentionally mirrors a pi package layout:

- `extensions/` — TypeScript extensions loaded by pi
- `skills/` — Agent skills
- `agents/` — Markdown subagent definitions used by the local subagent extension
- `prompts/` — Prompt templates
- `themes/` — Theme JSON files

The dashboard extension adds a custom header/footer, model/context/cost status, Jujutsu working-copy status, and a themed working spinner. Use `/dashboard off`, `/dashboard on`, or `/dashboard refresh` inside pi.

The file-search extension registers first-class `fd` and `rg` tools backed by Nix-provided `fd` and `ripgrep` binaries. It probes PATH for working executables instead of downloading fallback binaries.

## Planner-builder workflow

Use `plan_file_create` or `/plan-create` to save a planner-generated plan, then `plan_file_build` or `/plan-build` when implementation is authorized. Builders run in isolated jj workspaces or Git worktrees with one atomic task commit each; the parent alone owns plan status and integration.

Supervision is **off by default**. Opt in with `supervisionMode: "steer"` (`/plan-build --supervise`) for bounded guidance, or `supervisionMode: "advisory"` (`/plan-build --advisory`) for proposals without delivery. The tool selects `supervisorAgent` (default `"supervisor"`) and bounded `supervisionOptions`. Supervision is not verifier review: only `runVerifier: true` or `--verify` enables that separate post-build step.

Use `/plan-inspect` to discover the active run and current attempt IDs before identity-qualified `/plan-steer` or `/plan-cancel` actions. Closing the dashboard or toggling `Alt+X` does not cancel the build, and steering cannot interrupt a running shell tool. Supervisor disablement is visible; healthy builders continue with watchdog handling. Restarts are fresh conversations that must inspect retained work and preserve the single task commit.

External journals and supervised sessions are retained under `PI_PLAN_RUN_ROOT` or `~/.pi/plan-runs`, with attempt/session mappings. Treat them as sensitive transcripts, not automatic crash recovery or reattachment: existing VCS recovery remains authoritative. See [planner-builder operating guidance](extensions/planner-builder/README.md) for examples, normalized limits, question deadlines, receipts, checkpoint closure, and manual recovery.

## Safe deployment check

Adding repository files does not automatically create new home-directory links. In particular, the supervisor agent and every new planner-builder helper must be present in the installed resource tree before using supervision.

From the dotfiles root, preview deployment without changing home-directory contents:

```sh
stow --simulate --verbose pi
```

Review all proposed links, targets, and conflicts, including files outside `.pi/agent`. `.stowrc` targets `/home/hutch`; a dry run from a temporary task workspace can report ownership conflicts with links belonging to the main checkout. Stop on conflicts and have the owner inspect them; do not deploy links pointing at a disposable task workspace.

**Actual home-directory deployment is not a builder task.** Do not force/overwrite links, use `--adopt`, restow (`--restow`/`-R`), or prune/remove links while unrelated changes exist. Do not reconcile unrelated MCP/settings changes or dangling links as part of this workflow. A dry-run failure is a deployment warning to report, not permission to repair the home directory. After integration and explicit owner review, deployment and any Pi reload are separate operations; reload cancels an active owned build.
