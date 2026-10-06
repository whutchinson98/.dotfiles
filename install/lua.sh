#!/usr/bin/env bash
# Install Lua from the distro package manager.
SCRIPT_DESC="Install Lua from the distro package manager."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have lua && already lua "$(lua -v 2>&1 | head -1)"
pkg_install lua5.4 lua
ok "lua installed"
