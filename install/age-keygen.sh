#!/usr/bin/env bash
# Install age-keygen (and age) from the distro package manager.
SCRIPT_DESC="Install age-keygen via the distro age package."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have age-keygen && already age-keygen "$(age-keygen --version 2>/dev/null | head -1)"
pkg_install age age
ok "age-keygen installed"
