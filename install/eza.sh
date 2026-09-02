#!/usr/bin/env bash
# Install eza (used by the `ls` abbreviation in conf.d/abbreviations.fish).
# Distro package first; falls back to the upstream release, since eza is
# absent from Ubuntu repos before 24.04.
SCRIPT_DESC="Install eza, falling back to a GitHub release on older distros."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have eza && already eza "$(eza --version 2>/dev/null | sed -n 2p)"

if pkg_available eza; then
    pkg_install eza
    ok "eza installed from $PKG_MGR"
    exit 0
fi

warn "eza not in $PKG_MGR repos — installing from GitHub release"
ensure_local_bin
tag="$(github_latest_tag eza-community/eza)"
[ -n "$tag" ] || die "could not determine latest eza release"
log "eza $tag"

case "$ARCH" in
    x86_64)  target="x86_64-unknown-linux-gnu" ;;
    aarch64) target="aarch64-unknown-linux-gnu" ;;
    *) die "unsupported arch for eza release: $ARCH" ;;
esac

tmp="$(mktempdir)"
download "https://github.com/eza-community/eza/releases/download/${tag}/eza_${target}.tar.gz" "$tmp/eza.tar.gz"
run tar -xzf "$tmp/eza.tar.gz" -C "$tmp"
run install -m755 "$tmp/eza" "$LOCAL_BIN/eza"
ok "eza $tag installed to $LOCAL_BIN"
