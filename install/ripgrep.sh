#!/usr/bin/env bash
# Install ripgrep (rg) via cargo install.
SCRIPT_DESC="Install ripgrep (rg) via cargo install."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have rg && already ripgrep "$(rg --version 2>/dev/null | head -1)"
require_cmd cargo rust
log "cargo install ripgrep (this compiles from source and takes a while)"
run cargo install --locked ripgrep
ok "ripgrep installed to $HOME/.cargo/bin"
