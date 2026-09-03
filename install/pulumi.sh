#!/usr/bin/env bash
# Install Pulumi via its official installer. config.fish puts ~/.pulumi/bin on PATH.
SCRIPT_DESC="Install Pulumi to ~/.pulumi via the official install script."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have pulumi && already pulumi "$(pulumi version 2>/dev/null)"
ensure_curl
log "installing Pulumi to \$HOME/.pulumi"
run_shell "curl --proto '=https' --tlsv1.2 -fsSL https://get.pulumi.com | sh"
ok "Pulumi installed"
