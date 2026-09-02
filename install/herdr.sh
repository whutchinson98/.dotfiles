#!/usr/bin/env bash
# Install herdr via its official script.
SCRIPT_DESC="Install herdr via https://herdr.dev/install.sh."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have herdr && already herdr "$(herdr --version 2>/dev/null | head -1)"
ensure_curl
ensure_local_bin
log "installing herdr"
run_shell "curl -fsSL https://herdr.dev/install.sh | sh"
ok "herdr installed — config.toml comes from the 'herdr' stow package"
