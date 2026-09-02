#!/usr/bin/env bash
# Install GNU Stow from the distro package manager.
SCRIPT_DESC="Install GNU Stow from the distro package manager."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have stow && already stow "$(stow --version 2>/dev/null | head -1)"
pkg_install stow stow
ok "stow installed"
