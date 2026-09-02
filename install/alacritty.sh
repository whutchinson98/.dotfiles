#!/usr/bin/env bash
# Install the Alacritty terminal from the distro package manager.
SCRIPT_DESC="Install the Alacritty terminal from the distro package manager."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have alacritty && already alacritty "$(alacritty --version 2>/dev/null | head -1)"
pkg_install alacritty alacritty
ok "alacritty installed"
