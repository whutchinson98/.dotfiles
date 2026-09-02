#!/usr/bin/env bash
# Install just via cargo install.
SCRIPT_DESC="Install just via cargo install."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have just && already just "$(just --version 2>/dev/null | head -1)"
require_cmd cargo rust
log "cargo install just (this compiles from source and takes a while)"
run cargo install --locked just
ok "just installed to $HOME/.cargo/bin"
