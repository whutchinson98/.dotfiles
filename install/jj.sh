#!/usr/bin/env bash
# Install jujutsu (jj) via cargo install.
SCRIPT_DESC="Install jujutsu (jj) via cargo install."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have jj && already jj "$(jj --version 2>/dev/null | head -1)"
require_cmd cargo rust
log "cargo install jj-cli (this compiles from source and takes a while)"
run cargo install --locked jj-cli
ok "jj installed to $HOME/.cargo/bin"
