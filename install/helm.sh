#!/usr/bin/env bash
# Install Helm from an official release tarball to ~/.local/bin.
# Override the release with HELM_VERSION=v4.0.0.
SCRIPT_DESC="Install Helm from get.helm.sh (SHA-256 checked)."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have helm && already helm "$(helm version --short 2>/dev/null)"

[ "$(uname -s)" = Linux ] || die "Helm installer supports Linux only"
case "$ARCH_ALT" in
    amd64|arm64) ;;
    *) die "unsupported arch for Helm release: $ARCH_RAW" ;;
esac

ensure_curl
tag="${HELM_VERSION:-$(github_latest_tag helm/helm)}"
[ -n "$tag" ] || die "could not determine latest Helm release"
tag="v${tag#v}"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid Helm version: $tag"
asset="helm-${tag}-linux-${ARCH_ALT}.tar.gz"
log "Helm $tag"

ensure_local_bin
mktempdir
download "https://get.helm.sh/$asset" "$TMP_DIR/$asset"
download "https://get.helm.sh/$asset.sha256" "$TMP_DIR/checksum"
if [ "$DRY_RUN" = "1" ]; then
    log "would verify SHA-256 checksum for $asset"
else
    (
        cd "$TMP_DIR"
        checksum="$(<checksum)"
        [[ "$checksum" =~ ^[[:xdigit:]]{64}$ ]] || die "invalid Helm checksum"
        printf '%s  %s\n' "$checksum" "$asset" | sha256sum --check --strict -
    )
fi
run tar -xzf "$TMP_DIR/$asset" -C "$TMP_DIR" "linux-${ARCH_ALT}/helm"
run install -m755 "$TMP_DIR/linux-${ARCH_ALT}/helm" "$LOCAL_BIN/helm"
ok "Helm $tag installed to $LOCAL_BIN"
