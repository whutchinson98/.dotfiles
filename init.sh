#!/usr/bin/env bash
#
# Bootstrap this machine to the point where `just sync` works:
# detect the OS family, then install GNU Stow and just.
#
# Supports Debian/Ubuntu-style (apt) and Fedora/RHEL-style (dnf/yum) hosts,
# including derivatives (Pop!_OS, Mint, Rocky, Alma, Nobara, ...).
# Idempotent — re-running it on a provisioned machine is a no-op.
#
#   ./init.sh            install what is missing
#   ./init.sh --sync     install, then stow every package
#   ./init.sh --dry-run  report what would be installed
#
# OS detection and package-manager plumbing are shared with the install/
# scripts via install/lib.sh, so there is one implementation of each.
set -euo pipefail

REPO="$(dirname "$(readlink -f "$0")")"

for arg in "$@"; do
    case "$arg" in
        --help|-h)
            cat <<'EOF'
Bootstrap this machine to the point where `just sync` works:
detect the OS family, then install GNU Stow and just.

Supports Debian/Ubuntu-style (apt) and Fedora/RHEL-style (dnf/yum) hosts.
Idempotent — re-running it on a provisioned machine is a no-op.

  ./init.sh            install what is missing
  ./init.sh --sync     install, then stow every package
  ./init.sh --dry-run  report what would be installed
  ./init.sh --help     this message
EOF
            exit 0 ;;
    esac
done

# shellcheck source=install/lib.sh
. "$REPO/install/lib.sh"

DO_SYNC=0
ARGS=()
for arg in "$@"; do
    case "$arg" in
        --sync|-s)    DO_SYNC=1 ;;
        --dry-run|-n) ARGS+=("$arg") ;;
        *) die "unknown option: $arg (try --help)" ;;
    esac
done
lib_parse_args "${ARGS[@]+"${ARGS[@]}"}"

PRETTY="$( [ -r /etc/os-release ] && . /etc/os-release && echo "${PRETTY_NAME:-$OS_FAMILY}" )"
[ -n "$PKG_MGR" ] || die "unsupported OS: ${PRETTY:-unknown}. This script handles Debian/Ubuntu- and Fedora/RHEL-style hosts."
log "detected ${PRETTY} — ${OS_FAMILY} family, using ${PKG_MGR}"

# --- stow ---------------------------------------------------------------------

if have stow; then
    ok "stow already present ($(stow --version | head -1))"
else
    pkg_install stow
fi

# --- just ---------------------------------------------------------------------
#
# just is packaged by Fedora and by Debian 13+/Ubuntu 24.04+, but is missing
# from older apt releases. Fall back to the upstream installer there.

install_just_fallback() {
    log "just not available from $PKG_MGR — installing to $LOCAL_BIN from upstream"
    ensure_curl
    ensure_local_bin
    run_shell "curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | bash -s -- --to '$LOCAL_BIN'"
}

if have just; then
    ok "just already present ($(just --version))"
elif pkg_available just; then
    pkg_install just
    have just || [ "$DRY_RUN" = "1" ] || install_just_fallback
else
    install_just_fallback
fi

# --- done ---------------------------------------------------------------------

if [ "$DRY_RUN" = "1" ]; then
    log "dry run complete — nothing was changed"
    exit 0
fi

MISSING=""
have stow || MISSING="$MISSING stow"
have just || MISSING="$MISSING just"
[ -n "$MISSING" ] && die "still missing:$MISSING — is $LOCAL_BIN on your PATH?"

ok "ready — $(stow --version | head -1), $(just --version)"

if [ "$DO_SYNC" -eq 1 ]; then
    cd "$REPO"
    log "syncing packages"
    just sync
else
    echo
    echo "Next: cd $REPO && just sync"
    echo "      just --list        # all commands"
    echo "      just install-all   # install the programs these configs are for"
fi
