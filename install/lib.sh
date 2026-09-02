#!/usr/bin/env bash
#
# Shared helpers for the install/ scripts. Source this, don't execute it:
#
#   . "$(dirname "$(readlink -f "$0")")/lib.sh"
#
# Provides: log/warn/die, OS-family detection, pkg_install, have, run
# (dry-run aware), download, github_latest_tag, and arch detection.
# Every script that sources this accepts --dry-run and --help.

[ -n "${_DOTFILES_LIB_SOURCED:-}" ] && return 0
_DOTFILES_LIB_SOURCED=1

set -euo pipefail

# --- output -------------------------------------------------------------------

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !!\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m xx\033[0m %s\n' "$*" >&2; exit 1; }

# --- argument parsing ---------------------------------------------------------
# DRY_RUN may also be set in the environment (the justfile uses that).

DRY_RUN="${DRY_RUN:-0}"
# UPDATE makes an installer act on a program that is already present, instead
# of exiting early — see already(). Without it nothing is ever upgraded, so
# `install-all` is a safe no-op on a provisioned machine.
UPDATE="${UPDATE:-0}"

lib_parse_args() {
    for arg in "$@"; do
        case "$arg" in
            --dry-run|-n) DRY_RUN=1 ;;
            --update|-u)  UPDATE=1 ;;
            --help|-h)
                echo "usage: $(basename "$0") [--dry-run] [--update]"
                [ -n "${SCRIPT_DESC:-}" ] && echo "$SCRIPT_DESC"
                exit 0 ;;
            *) die "unknown option: $arg" ;;
        esac
    done
}

# run <cmd> [args...]  — execute, or print it under --dry-run.
run() {
    if [ "$DRY_RUN" = "1" ]; then
        printf '   would run: %s\n' "$*"
    else
        "$@"
    fi
}

# run_shell '<shell string>' — for pipelines and redirection.
run_shell() {
    if [ "$DRY_RUN" = "1" ]; then
        printf '   would run: %s\n' "$1"
    else
        bash -c "$1"
    fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# Every installer starts with this, which is what makes `install-all`
# idempotent: by default it reports the existing install and exits 0.
#
# Under --update it instead RETURNS, so the caller falls through to its normal
# install path. That is the update mechanism for every installer: re-running
# apt/dnf, an upstream install script, `cargo install`, `npm -g` or a release
# download all fetch the current version. Installers needing more than a
# re-run (go, neovim, node, rust) handle UPDATE explicitly as well.
already() {
    local name="$1" ver="${2:-}"
    if [ "$UPDATE" = "1" ]; then
        log "$name present${ver:+ ($ver)} — updating because --update was given"
        return 0
    fi
    ok "$name already installed${ver:+ ($ver)}"
    exit 0
}

# --- privilege ----------------------------------------------------------------

if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
elif have sudo; then
    SUDO="sudo"
else
    SUDO=""
fi

need_sudo() {
    [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ] \
        || die "this installer needs root or sudo"
}

# --- OS / arch detection ------------------------------------------------------

detect_family() {
    [ -r /etc/os-release ] || { echo unknown; return; }
    # shellcheck disable=SC1091
    . /etc/os-release
    # ID_LIKE catches derivatives: Pop!_OS, Mint, Rocky, Alma, Nobara, ...
    for _id in ${ID:-} ${ID_LIKE:-}; do
        case "$_id" in
            debian|ubuntu) echo debian; return ;;
            fedora|rhel|centos|rocky|almalinux) echo fedora; return ;;
        esac
    done
    echo unknown
}

OS_FAMILY="$(detect_family)"
case "$OS_FAMILY" in
    debian) PKG_MGR="apt" ;;
    fedora) PKG_MGR="$(have dnf && echo dnf || echo yum)" ;;
    *)      PKG_MGR="" ;;
esac

require_known_os() {
    [ -n "$PKG_MGR" ] || die "unsupported OS — this script needs Debian/Ubuntu- or Fedora/RHEL-style"
}

# Normalised machine arch, in the spelling upstreams usually use.
ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
    x86_64|amd64)  ARCH=x86_64;  ARCH_ALT=amd64  ;;
    aarch64|arm64) ARCH=aarch64; ARCH_ALT=arm64  ;;
    *) ARCH="$ARCH_RAW"; ARCH_ALT="$ARCH_RAW" ;;
esac

# --- package manager ----------------------------------------------------------

_PKG_REFRESHED=0
pkg_refresh() {
    [ "$_PKG_REFRESHED" -eq 1 ] && return 0
    if [ "$PKG_MGR" = "apt" ]; then
        need_sudo
        log "refreshing apt index"
        run $SUDO apt-get update -qq
    fi
    _PKG_REFRESHED=1
}

# pkg_install <debian-name> [fedora-name]
# Falls back to the Debian name when no Fedora name is given.
pkg_install() {
    local deb="$1" fed="${2:-$1}" pkg
    require_known_os
    need_sudo
    case "$PKG_MGR" in
        apt) pkg="$deb" ;;
        *)   pkg="$fed" ;;
    esac
    pkg_refresh
    log "installing $pkg via $PKG_MGR"
    case "$PKG_MGR" in
        apt) run $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$pkg" ;;
        dnf) run $SUDO dnf install -y -q "$pkg" ;;
        yum) run $SUDO yum install -y -q "$pkg" ;;
    esac
}

# True when the package manager knows about a package at all.
pkg_available() {
    local deb="$1" fed="${2:-$1}"
    case "$PKG_MGR" in
        apt) pkg_refresh; apt-cache show "$deb" >/dev/null 2>&1 ;;
        dnf) dnf info -q "$fed" >/dev/null 2>&1 ;;
        yum) yum info -q "$fed" >/dev/null 2>&1 ;;
        *)   return 1 ;;
    esac
}

# --- download helpers ---------------------------------------------------------

ensure_curl() { have curl || pkg_install curl; }

LOCAL_BIN="$HOME/.local/bin"
ensure_local_bin() {
    run mkdir -p "$LOCAL_BIN"
    case ":${PATH}:" in
        *":$LOCAL_BIN:"*) ;;
        *) warn "$LOCAL_BIN is not on PATH in this shell (config.fish adds it for fish)" ;;
    esac
}

# download <url> <dest>
download() {
    ensure_curl
    log "downloading $1"
    run curl --proto '=https' --tlsv1.2 -fsSL "$1" -o "$2"
}

# github_latest_tag <owner/repo> — prints the latest release tag, or empty.
github_latest_tag() {
    ensure_curl
    curl --proto '=https' --tlsv1.2 -fsSL \
        "https://api.github.com/repos/$1/releases/latest" 2>/dev/null \
        | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1
}

# Scratch dir, cleaned up on exit.
mktempdir() {
    local d
    d="$(mktemp -d)"
    # shellcheck disable=SC2064
    trap "rm -rf '$d'" EXIT
    printf '%s' "$d"
}

# Warn when a tool is being installed but its prerequisite is missing.
require_cmd() {
    have "$1" || die "$1 is required first — run: just install $2"
}
