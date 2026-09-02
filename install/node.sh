#!/usr/bin/env bash
# Install the current LTS node through fnm and set it as default.
#
# conf.d/fnm.fish runs `fnm env --shell fish`, which puts the active node's
# bin on PATH. That is how `pi` resolves, so nothing here hardcodes a version
# or an absolute path.
#
# Set NODE_VERSION to pick a specific version (e.g. NODE_VERSION=22).
SCRIPT_DESC="Install node via fnm and set it as the default version."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

require_cmd fnm fnm
want="${NODE_VERSION:-lts-latest}"

if have node; then
    ok "node already installed ($(node --version))"
    log "to change versions: fnm install $want && fnm default $want"
    exit 0
fi

log "installing node ($want) via fnm"
run fnm install "$want"
run fnm default "$want"
ok "node installed — open a new fish shell, or run: fnm env --shell fish | source"
