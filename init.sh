#!/usr/bin/env bash
#
# Bootstrap this machine to the point where `just sync` works:
# detect the OS family, then install GNU Stow and just.
#
# Supports Debian/Ubuntu-style (apt) and Fedora/RHEL-style (dnf/yum) hosts.
# Idempotent — re-running it on a provisioned machine is a no-op.
#
#   ./init.sh            install what is missing
#   ./init.sh --sync     install, then stow every package
#   ./init.sh --dry-run  report what would be installed
set -euo pipefail

DRY_RUN=0
DO_SYNC=0
for arg in "$@"; do
    case "$arg" in
        --dry-run|-n) DRY_RUN=1 ;;
        --sync|-s)    DO_SYNC=1 ;;
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
        *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
    esac
done

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# --- privilege escalation -----------------------------------------------------

if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
elif command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
else
    die "need root or sudo to install packages"
fi

# --- OS detection -------------------------------------------------------------

detect_family() {
    [ -r /etc/os-release ] || { echo unknown; return; }
    # shellcheck disable=SC1091
    . /etc/os-release
    # ID_LIKE covers derivatives (Pop!_OS, Mint, Rocky, Alma, Nobara, ...)
    for id in ${ID:-} ${ID_LIKE:-}; do
        case "$id" in
            debian|ubuntu)               echo debian; return ;;
            fedora|rhel|centos|rocky|almalinux) echo fedora; return ;;
        esac
    done
    echo unknown
}

FAMILY=$(detect_family)
PRETTY=$( [ -r /etc/os-release ] && . /etc/os-release && echo "${PRETTY_NAME:-$FAMILY}" )

case "$FAMILY" in
    debian) PKG_MGR="apt"                    ;;
    fedora) PKG_MGR=$(command -v dnf >/dev/null 2>&1 && echo dnf || echo yum) ;;
    *) die "unsupported OS: ${PRETTY:-unknown}. This script handles Debian/Ubuntu- and Fedora/RHEL-style hosts." ;;
esac

log "detected ${PRETTY} — ${FAMILY} family, using ${PKG_MGR}"

# --- install helpers ----------------------------------------------------------

REFRESHED=0
pkg_refresh() {
    [ "$REFRESHED" -eq 1 ] && return
    if [ "$PKG_MGR" = "apt" ]; then
        log "refreshing apt index"
        [ "$DRY_RUN" -eq 1 ] || $SUDO apt-get update -qq
    fi
    REFRESHED=1
}

pkg_install() {
    local pkg="$1"
    pkg_refresh
    if [ "$DRY_RUN" -eq 1 ]; then
        log "would install: $pkg (via $PKG_MGR)"
        return 0
    fi
    log "installing $pkg"
    case "$PKG_MGR" in
        apt) $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$pkg" ;;
        dnf) $SUDO dnf install -y -q "$pkg" ;;
        yum) $SUDO yum install -y -q "$pkg" ;;
    esac
}

# --- stow ---------------------------------------------------------------------

if command -v stow >/dev/null 2>&1; then
    log "stow already present ($(stow --version | head -1))"
else
    # Packaged as "stow" on both families.
    pkg_install stow
fi

# --- just ---------------------------------------------------------------------
#
# just is in Fedora's repos and in Debian 13+/Ubuntu 24.04+, but missing from
# older apt releases. Fall back to the upstream install script (to ~/.local/bin)
# when the distro cannot provide it.

install_just_fallback() {
    local bindir="$HOME/.local/bin"
    log "just not in repos — installing to $bindir from upstream"
    if [ "$DRY_RUN" -eq 1 ]; then
        log "would run: prebuilt-mpr just installer -> $bindir"
        return 0
    fi
    command -v curl >/dev/null 2>&1 || pkg_install curl
    mkdir -p "$bindir"
    curl --proto '=https' --tlsv1.2 -sSf \
        https://just.systems/install.sh | bash -s -- --to "$bindir"
    case ":$PATH:" in
        *":$bindir:"*) ;;
        *) warn "$bindir is not on PATH — add it to your shell profile" ;;
    esac
}

if command -v just >/dev/null 2>&1; then
    log "just already present ($(just --version))"
elif [ "$DRY_RUN" -eq 1 ]; then
    log "would install: just (via $PKG_MGR, falling back to upstream installer)"
else
    if ! pkg_install just 2>/dev/null; then
        install_just_fallback
    elif ! command -v just >/dev/null 2>&1; then
        install_just_fallback
    fi
fi

# --- done ---------------------------------------------------------------------

if [ "$DRY_RUN" -eq 1 ]; then
    log "dry run complete — nothing was changed"
    exit 0
fi

MISSING=""
command -v stow >/dev/null 2>&1 || MISSING="$MISSING stow"
command -v just >/dev/null 2>&1 || MISSING="$MISSING just"
[ -n "$MISSING" ] && die "still missing:$MISSING"

log "ready — stow $(stow --version | sed 's/.*version //;q'), $(just --version)"

if [ "$DO_SYNC" -eq 1 ]; then
    cd "$(dirname "$(readlink -f "$0")")"
    log "syncing packages"
    just sync
else
    echo
    echo "Next: cd $(dirname "$(readlink -f "$0")") && just sync"
    echo "      just --list   # all available commands"
fi
