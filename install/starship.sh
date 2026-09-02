#!/usr/bin/env bash
# Install starship via its official script, which targets /usr/local/bin —
# matching where it already lives on this machine. config.fish runs
# `starship init fish | source` in its interactive block.
SCRIPT_DESC="Install starship prompt via the official install script (/usr/local/bin)."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have starship && already starship "$(starship --version 2>/dev/null | head -1)"
ensure_curl
need_sudo
log "installing starship to /usr/local/bin"
run_shell "curl --proto '=https' --tlsv1.2 -sSf https://starship.rs/install.sh | $SUDO sh -s -- --yes"
ok "starship installed"
