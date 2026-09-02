#!/usr/bin/env bash
# Install tmux from the distro package manager.
SCRIPT_DESC="Install tmux from the distro package manager."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have tmux && already tmux "$(tmux --version 2>/dev/null | head -1)"
pkg_install tmux tmux
ok "tmux installed"
