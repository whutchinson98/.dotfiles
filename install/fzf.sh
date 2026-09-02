#!/usr/bin/env bash
# Install fzf. Required by scripts/tmux-sessionizer, which is bound to Ctrl-F
# in config.fish — without fzf that keybinding does nothing useful.
# Distro package first, falling back to the upstream release.
SCRIPT_DESC="Install fzf, falling back to a GitHub release on older distros."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have fzf && already fzf "$(fzf --version 2>/dev/null)"

if pkg_available fzf; then
    pkg_install fzf
    ok "fzf installed from $PKG_MGR"
    exit 0
fi

warn "fzf not in $PKG_MGR repos — installing from GitHub release"
ensure_local_bin
tag="$(github_latest_tag junegunn/fzf)"
[ -n "$tag" ] || die "could not determine latest fzf release"
ver="${tag#v}"
log "fzf $tag"

mktempdir
download "https://github.com/junegunn/fzf/releases/download/${tag}/fzf-${ver}-linux_${ARCH_ALT}.tar.gz" "$TMP_DIR/fzf.tar.gz"
run tar -xzf "$TMP_DIR/fzf.tar.gz" -C "$TMP_DIR"
run install -m755 "$TMP_DIR/fzf" "$LOCAL_BIN/fzf"
ok "fzf $tag installed to $LOCAL_BIN"
