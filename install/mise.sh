#!/usr/bin/env bash
# Install mise via its official script (lands in ~/.local/bin).
# config.fish activates it with `mise activate fish | source`.
SCRIPT_DESC="Install mise via the official install script (~/.local/bin)."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have mise && already mise "$(mise --version 2>/dev/null | head -1)"
ensure_curl
ensure_local_bin
log "installing mise"
run_shell "curl --proto '=https' --tlsv1.2 -fsSL https://mise.run | sh"
ok "mise installed — config.fish already runs 'mise activate fish'"
