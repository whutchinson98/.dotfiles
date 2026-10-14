#!/usr/bin/env bash
# Install kubectl from the official stable release to ~/.local/bin.
# Override the release with KUBECTL_VERSION=v1.35.0.
SCRIPT_DESC="Install kubectl from dl.k8s.io (SHA-256 checked)."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have kubectl && already kubectl "$(kubectl version --client 2>/dev/null | head -1)"

[ "$(uname -s)" = Linux ] || die "kubectl installer supports Linux only"
case "$ARCH_ALT" in
    amd64|arm64) ;;
    *) die "unsupported arch for kubectl release: $ARCH_RAW" ;;
esac

ensure_curl
tag="${KUBECTL_VERSION:-$(curl --proto '=https' --tlsv1.2 -fsSL https://dl.k8s.io/release/stable.txt)}"
[ -n "$tag" ] || die "could not determine latest kubectl release"
# Accept version pins with or without the leading v.
tag="v${tag#v}"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid kubectl version: $tag"
base="https://dl.k8s.io/release/${tag}/bin/linux/${ARCH_ALT}"
log "kubectl $tag"

ensure_local_bin
mktempdir
download "$base/kubectl" "$TMP_DIR/kubectl"
download "$base/kubectl.sha256" "$TMP_DIR/kubectl.sha256"
if [ "$DRY_RUN" = "1" ]; then
    log "would verify SHA-256 checksum for kubectl"
else
    (
        cd "$TMP_DIR"
        checksum="$(<kubectl.sha256)"
        [[ "$checksum" =~ ^[[:xdigit:]]{64}$ ]] || die "invalid kubectl checksum"
        printf '%s  kubectl\n' "$checksum" | sha256sum --check --strict -
    )
fi
run install -m755 "$TMP_DIR/kubectl" "$LOCAL_BIN/kubectl"
ok "kubectl $tag installed to $LOCAL_BIN"
