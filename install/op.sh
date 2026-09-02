#!/usr/bin/env bash
# Install the 1Password CLI from 1Password's own repository, matching this
# machine (op is in /usr/bin).
#
# config.fish sources ~/.config/op/plugins.sh, which defines the `pulumi`
# plugin alias, and points SSH_AUTH_SOCK at the 1Password SSH agent.
SCRIPT_DESC="Install the 1Password CLI (op) from 1Password's apt/dnf repo."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have op && already op "$(op --version 2>/dev/null)"
require_known_os
need_sudo
ensure_curl

case "$PKG_MGR" in
apt)
    case "$ARCH" in
        x86_64)  debarch=amd64 ;;
        aarch64) debarch=arm64 ;;
        *) die "no 1Password CLI build for arch: $ARCH" ;;
    esac
    have gpg || pkg_install gnupg
    log "adding 1Password apt repository"
    run_shell "curl -sS https://downloads.1password.com/linux/keys/1password.asc \
        | $SUDO gpg --dearmor --yes --output /usr/share/keyrings/1password-archive-keyring.gpg"
    run_shell "echo 'deb [arch=$debarch signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$debarch stable main' \
        | $SUDO tee /etc/apt/sources.list.d/1password.list >/dev/null"

    # 1Password's debsig policy, required for their package verification.
    run $SUDO mkdir -p /etc/debsig/policies/AC2D62742012EA22/ \
        /usr/share/debsig/keyrings/AC2D62742012EA22/
    run_shell "curl -sS https://downloads.1password.com/linux/debian/debsig/1password.pol \
        | $SUDO tee /etc/debsig/policies/AC2D62742012EA22/1password.pol >/dev/null"
    run_shell "curl -sS https://downloads.1password.com/linux/keys/1password.asc \
        | $SUDO gpg --dearmor --yes --output /usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg"

    _PKG_REFRESHED=0   # force a re-index now that the repo is added
    pkg_install 1password-cli
    ;;
dnf|yum)
    log "adding 1Password dnf repository"
    run_shell "$SUDO rpm --import https://downloads.1password.com/linux/keys/1password.asc"
    run_shell "$SUDO tee /etc/yum.repos.d/1password.repo >/dev/null <<'REPO'
[1password]
name=1Password Stable Channel
baseurl=https://downloads.1password.com/linux/rpm/stable/\$basearch
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=\"https://downloads.1password.com/linux/keys/1password.asc\"
REPO"
    pkg_install 1password-cli 1password-cli
    ;;
esac

ok "1Password CLI installed"
