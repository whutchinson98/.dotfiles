#!/usr/bin/env bash
# Install bun via its official script. config.fish exports BUN_INSTALL=~/.bun
# and puts $BUN_INSTALL/bin on PATH.
SCRIPT_DESC="Install bun to ~/.bun via the official install script."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have bun && already bun "$(bun --version 2>/dev/null)"
ensure_curl
have unzip || pkg_install unzip
log "installing bun to \$HOME/.bun"
run_shell "curl --proto '=https' --tlsv1.2 -fsSL https://bun.sh/install | bash"
ok "bun installed"
