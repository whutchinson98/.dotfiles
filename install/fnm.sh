#!/usr/bin/env bash
# Install fnm via its official script. conf.d/fnm.fish expects it at
# ~/.local/share/fnm and sources `fnm env --shell fish`.
SCRIPT_DESC="Install fnm (node version manager) to ~/.local/share/fnm."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have fnm && already fnm "$(fnm --version 2>/dev/null)"
ensure_curl
have unzip || pkg_install unzip
log "installing fnm to \$HOME/.local/share/fnm"
run_shell "curl --proto '=https' --tlsv1.2 -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir \"\$HOME/.local/share/fnm\" --skip-shell"
ok "fnm installed — conf.d/fnm.fish wires it into fish"
