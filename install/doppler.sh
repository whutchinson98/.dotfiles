#!/usr/bin/env bash
# Install the Doppler CLI via its official script, which targets /usr/local/bin
# and works on any distro — no vendor repo needed.
#
# Doppler does publish apt/dnf repos, but their rpm config pins
# sslcacert=/etc/pki/tls/certs/ca-bundle.crt, which current Fedora no longer
# ships (only /etc/pki/ca-trust/extracted/pem/...), so metadata fetches fail
# with curl error 77 — and their skip_if_unavailable=1 hides that behind a bare
# "No match for argument: doppler". The install script sidesteps all of it.
SCRIPT_DESC="Install the Doppler CLI via the official install script (/usr/local/bin)."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have doppler && already doppler "$(doppler --version 2>/dev/null | head -1)"
ensure_curl
need_sudo
log "installing doppler to /usr/local/bin"
run_shell "(curl -Ls --tlsv1.2 --proto '=https' --retry 3 https://cli.doppler.com/install.sh \
    || wget -t 3 -qO- https://cli.doppler.com/install.sh) | $SUDO sh"
ok "doppler installed"
