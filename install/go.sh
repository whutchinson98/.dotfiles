#!/usr/bin/env bash
# Install Go from the official tarball into /usr/local/go, matching this
# machine. config.fish already has /usr/local/go/bin on PATH and exports
# GO_PATH=$HOME/go/bin.
#
# Set GO_VERSION to pin (e.g. GO_VERSION=1.24.0), otherwise the current
# stable release is resolved from go.dev.
SCRIPT_DESC="Install Go from the official tarball into /usr/local/go."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

ensure_curl

if [ -n "${GO_VERSION:-}" ]; then
    ver="go${GO_VERSION#go}"
else
    ver="$(curl --proto '=https' --tlsv1.2 -fsSL https://go.dev/VERSION?m=text 2>/dev/null | head -1)"
fi
[ -n "$ver" ] || die "could not determine current Go version (set GO_VERSION to pin one)"

if have go; then
    current="$(go version | awk '{print $3}')"
    # Already current: nothing to do, even under --update. Re-extracting an
    # identical tarball would only cost a download and a sudo rm -rf.
    if [ "$current" = "$ver" ]; then
        ok "go already at the current version ($current)"
        exit 0
    fi
    if [ "$UPDATE" != "1" ]; then
        ok "go already installed ($current); latest is $ver"
        log "to upgrade: just update go"
        exit 0
    fi
    log "updating go $current -> $ver"
fi

case "$ARCH" in
    x86_64)  goarch=amd64 ;;
    aarch64) goarch=arm64 ;;
    *) die "no Go release build for arch: $ARCH" ;;
esac

need_sudo
tmp="$(mktempdir)"
download "https://go.dev/dl/${ver}.linux-${goarch}.tar.gz" "$tmp/go.tar.gz"

log "extracting to /usr/local/go"
run $SUDO rm -rf /usr/local/go
run $SUDO tar -C /usr/local -xzf "$tmp/go.tar.gz"

ok "$ver installed to /usr/local/go"
