#!/usr/bin/env bash
# Install Neovim from the official GitHub release tarball into /opt, matching
# this machine's existing /opt/nvim-linux-x86_64 layout. config.fish already
# has /opt/nvim-linux-x86_64/bin on PATH.
#
# Distro packages are deliberately not used: the nvim config calls
# vim.lsp.config(), which needs Neovim 0.11+, and Ubuntu ships older.
#
# Set NVIM_VERSION to pin a release (e.g. NVIM_VERSION=v0.11.2), otherwise
# the latest stable release is used.
SCRIPT_DESC="Install Neovim from the GitHub release tarball into /opt."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

case "$ARCH" in
    x86_64)  dirname_="nvim-linux-x86_64" ;;
    aarch64) dirname_="nvim-linux-arm64"  ;;
    *) die "no Neovim release build for arch: $ARCH" ;;
esac

tag="${NVIM_VERSION:-$(github_latest_tag neovim/neovim)}"
[ -n "$tag" ] || die "could not determine latest Neovim release (set NVIM_VERSION to pin one)"

if have nvim; then
    current="$(nvim --version | head -1 | awk '{print $2}')"
    # Already current: nothing to do, even under --update. Re-extracting an
    # identical tarball would only cost a download and a sudo rm -rf.
    if [ "$current" = "$tag" ]; then
        ok "nvim already at the current version ($current)"
        exit 0
    fi
    if [ "$UPDATE" != "1" ]; then
        ok "nvim already installed ($current); latest is $tag"
        log "to upgrade: just update neovim"
        exit 0
    fi
    log "updating nvim $current -> $tag"
fi

need_sudo
tmp="$(mktempdir)"
download "https://github.com/neovim/neovim/releases/download/${tag}/${dirname_}.tar.gz" "$tmp/nvim.tar.gz"

log "extracting to /opt/${dirname_}"
run tar -xzf "$tmp/nvim.tar.gz" -C "$tmp"
run $SUDO rm -rf "/opt/${dirname_}"
run $SUDO mv "$tmp/${dirname_}" "/opt/${dirname_}"

# A stable symlink so PATH does not depend on the arch-specific directory.
run $SUDO ln -sfn "/opt/${dirname_}" /opt/nvim

if [ "$dirname_" != "nvim-linux-x86_64" ]; then
    warn "config.fish adds /opt/nvim-linux-x86_64/bin to PATH; on this arch nvim is at /opt/${dirname_}/bin"
    warn "add /opt/nvim/bin to PATH, or adjust fish/.config/fish/config.fish"
fi

ok "Neovim $tag installed to /opt/${dirname_}"
log "plugins install on first launch (lazy.nvim); lazy-lock.json is tracked in the nvim package"
