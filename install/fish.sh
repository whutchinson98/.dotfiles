#!/usr/bin/env bash
# Install fish shell from the distro package manager.
SCRIPT_DESC="Install fish shell from the distro package manager."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have fish && already fish "$(fish --version 2>/dev/null | head -1)"
pkg_install fish fish
ok "fish installed"
