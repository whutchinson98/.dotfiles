# Hutch pi agent package

User-scoped pi resources linked into `~/.pi/agent` by `modules/dev/ai.nix`.

This directory intentionally mirrors a pi package layout:

- `extensions/` — TypeScript extensions loaded by pi
- `skills/` — Agent skills
- `agents/` — Markdown subagent definitions used by the local subagent extension
- `prompts/` — Prompt templates
- `themes/` — Theme JSON files

The dashboard extension adds a custom header/footer, model/context/cost status, Jujutsu working-copy status, and a themed working spinner. Use `/dashboard off`, `/dashboard on`, or `/dashboard refresh` inside pi.

The file-search extension registers first-class `fd` and `rg` tools backed by Nix-provided `fd` and `ripgrep` binaries. It probes PATH for working executables instead of downloading fallback binaries.
