#!/usr/bin/env bash
# Install SOPS from an official release binary to ~/.local/bin.
# Override the release with SOPS_VERSION=v3.13.3.
SCRIPT_DESC="Install SOPS from an official GitHub release (SHA-256 checked)."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have sops && already sops "$(sops --version 2>/dev/null | head -1)"

[ "$(uname -s)" = Linux ] || die "SOPS installer supports Linux only"
case "$ARCH_ALT" in
    amd64|arm64) ;;
    *) die "unsupported arch for SOPS release: $ARCH_RAW" ;;
esac

ensure_curl
tag="${SOPS_VERSION:-$(github_latest_tag getsops/sops)}"
[ -n "$tag" ] || die "could not determine latest SOPS release"
# Accept version pins with or without the leading v.
tag="v${tag#v}"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid SOPS version: $tag"
asset="sops-${tag}.linux.${ARCH_ALT}"
base="https://github.com/getsops/sops/releases/download/${tag}"
log "SOPS $tag"

ensure_local_bin
mktempdir
download "$base/$asset" "$TMP_DIR/$asset"
download "$base/sops-${tag}.checksums.txt" "$TMP_DIR/checksums.txt"
if [ "$DRY_RUN" = "1" ]; then
    log "would verify SHA-256 checksum for $asset"
else
    (
        cd "$TMP_DIR"
        awk -v asset="$asset" '$2 == asset { print }' checksums.txt | sha256sum --check --strict -
    )
fi
run install -m755 "$TMP_DIR/$asset" "$LOCAL_BIN/sops"
ok "SOPS $tag installed to $LOCAL_BIN"
