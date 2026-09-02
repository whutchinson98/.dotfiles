#!/usr/bin/env bash
# Install git from the distro package manager.
SCRIPT_DESC="Install git from the distro package manager."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have git && already git "$(git --version 2>/dev/null | head -1)"
pkg_install git git
ok "git installed"
