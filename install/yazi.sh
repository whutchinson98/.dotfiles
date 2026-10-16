#!/usr/bin/env bash
# Install Yazi and its companion CLI (ya) via the upstream Cargo build helper.
SCRIPT_DESC="Install Yazi (yazi + ya) via cargo install yazi-build, plus file and chafa."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

# Fill missing runtime dependencies even when Yazi is already installed.
have file || pkg_install file
have chafa || pkg_install chafa

have yazi && have ya && already yazi "$(yazi --version 2>/dev/null | head -1)"
require_cmd cargo rust
# Upstream requires yazi-build rather than installing yazi-fm/yazi-cli directly.
# --force re-runs the helper even when it is already installed.
log "cargo install yazi-build (this compiles from source and takes a while)"
run cargo install --force yazi-build
ok "yazi and ya installed to $HOME/.cargo/bin"
