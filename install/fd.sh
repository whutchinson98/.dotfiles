#!/usr/bin/env bash
# Install fd. Needed by pi's file-search extension, which registers a
# first-class `fd` tool; it probes for both `fd` and `fdfind`, so Debian's
# fdfind naming works without extra shimming.
SCRIPT_DESC="Install fd (Debian names the binary fdfind)."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

if have fd; then
    already fd "$(fd --version 2>/dev/null)"
elif have fdfind; then
    already fdfind "$(fdfind --version 2>/dev/null)"
fi

# The package is fd-find on both families; Debian installs it as `fdfind`
# to avoid a clash with the unrelated `fd` package.
pkg_install fd-find fd-find

if have fd; then
    ok "fd installed"
elif have fdfind; then
    ok "fd installed as 'fdfind' (pi's file-search extension detects this name)"
else
    die "fd-find installed but neither fd nor fdfind is on PATH"
fi
