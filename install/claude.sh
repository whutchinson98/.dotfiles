#!/usr/bin/env bash
# Install Claude Code via its official installer (lands in ~/.local/bin).
SCRIPT_DESC="Install Claude Code CLI to ~/.local/bin."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have claude && already claude "$(claude --version 2>/dev/null | head -1)"
ensure_curl
ensure_local_bin
log "installing Claude Code"
run_shell "curl --proto '=https' --tlsv1.2 -fsSL https://claude.ai/install.sh | bash"
ok "claude installed — settings.json comes from the 'claude' stow package"
