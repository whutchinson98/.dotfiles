#!/usr/bin/env bash
# Install Tailscale from Tailscale's own apt/dnf repository, via their official
# install script.
#
# Unlike 1Password (op.sh), the repo layout here is per-distro-release —
# Debian/Ubuntu need the codename in both the key and the sources URL
# (.../stable/ubuntu/noble.noarmor.gpg), and Fedora needs `dnf config-manager
# addrepo` on dnf5 but `--add-repo` on dnf4. install.sh maps all of that from
# /etc/os-release, so it is delegated rather than reimplemented. It is fully
# non-interactive and ends in `dnf/apt-get install tailscale`, so re-running it
# under --update pulls the current release from the repo it just configured.
#
# TAILSCALE_VERSION=1.102.3 pins a version; the install script reads it.
#
# The package does not log the machine in: `tailscale up` needs a browser or an
# auth key, so it stays a manual step.
SCRIPT_DESC="Install Tailscale from its apt/dnf repo (needs 'tailscale up' after)."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have tailscale && already tailscale "$(tailscale version 2>/dev/null | head -1)"
require_known_os
need_sudo
ensure_curl

log "installing tailscale via https://tailscale.com/install.sh"
run_shell "curl --proto '=https' --tlsv1.2 -fsSL https://tailscale.com/install.sh | sh"

# install.sh already runs `systemctl enable --now tailscaled`; asserting it
# again is free and repairs a daemon that was later disabled by hand.
if have systemctl && [ -d /run/systemd/system ]; then
    run $SUDO systemctl enable --now tailscaled
else
    warn "no systemd here — start tailscaled yourself"
fi

ok "tailscale installed"
if [ "$DRY_RUN" != "1" ] && ! tailscale status >/dev/null 2>&1; then
    log "this machine is not on a tailnet yet — log in with: sudo tailscale up"
fi
