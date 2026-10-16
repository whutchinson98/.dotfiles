#!/usr/bin/env bash
# Install Cloudflare's cf CLI as a global npm package on fnm's active node.
# Authentication stays outside this repo; run `cf auth login` afterwards.
SCRIPT_DESC="Install Cloudflare's cf CLI globally via npm."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have cf && already cf "$(cf --version 2>/dev/null | head -1)"
require_cmd npm node
log "npm install --global cf"
run npm install --global cf
ok "cf installed — run 'cf auth login' to authenticate"
