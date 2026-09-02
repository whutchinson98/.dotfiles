#!/usr/bin/env bash
# Install pnpm via its official script. config.fish sets
# PNPM_HOME=~/.local/share/pnpm and prepends $PNPM_HOME/bin to PATH.
SCRIPT_DESC="Install pnpm to ~/.local/share/pnpm via the official install script."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have pnpm && already pnpm "$(pnpm --version 2>/dev/null)"
ensure_curl
log "installing pnpm to \$HOME/.local/share/pnpm"
run_shell "curl --proto '=https' --tlsv1.2 -fsSL https://get.pnpm.io/install.sh | env PNPM_HOME=\"\$HOME/.local/share/pnpm\" SHELL=bash sh -"
ok "pnpm installed"
