#!/usr/bin/env bash
# Install the Flux CLI via its official installer.
SCRIPT_DESC="Install the Flux CLI via the official install script (/usr/local/bin)."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have flux && already flux "$(flux --version 2>/dev/null)"
ensure_curl
need_sudo
log "installing flux to /usr/local/bin"
run_shell "set -o pipefail; curl --proto '=https' --tlsv1.2 -fsSL https://fluxcd.io/install.sh | $SUDO bash"
ok "flux installed"
