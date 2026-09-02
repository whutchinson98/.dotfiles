#!/usr/bin/env bash
#
# _installed.sh <program> — exit 0 if that program is present, 1 otherwise.
#
# Most programs are proved by a same-named binary, but a few need a different
# probe: ripgrep ships `rg`, neovim ships `nvim`, `rust` means rustup, Debian
# names fd's binary `fdfind`, and `fonts` is not a binary at all. The justfile's
# install-list and install-status both defer to this so the mapping lives in
# one place.
set -uo pipefail

prog="${1:?usage: _installed.sh <program>}"

has() { command -v "$1" >/dev/null 2>&1; }

case "$prog" in
    ripgrep) has rg     && exit 0 || exit 1 ;;
    neovim)  has nvim   && exit 0 || exit 1 ;;
    rust)    has rustup && exit 0 || exit 1 ;;
    fd)
        # Debian installs fd-find's binary as fdfind to avoid a name clash.
        has fd     && exit 0
        has fdfind && exit 0
        exit 1 ;;
    fonts)
        # Considered installed once fontconfig can see a GeistMono face.
        has fc-list || exit 1
        [ "$(fc-list 2>/dev/null | grep -ci geistmono)" -gt 0 ] && exit 0
        exit 1 ;;
    *) has "$prog" && exit 0 || exit 1 ;;
esac
