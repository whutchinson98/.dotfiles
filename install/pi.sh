#!/usr/bin/env bash
# Install the pi coding agent as a global npm package on fnm's active node.
#
# The agent config — extensions, skills, agents, prompts, themes — is not
# installed here: it comes from the 'pi' stow package, which links it into
# ~/.pi/agent. Mutable state (auth.json, sessions/) stays out of the repo,
# so run `pi` once afterwards to authenticate.
SCRIPT_DESC="Install the pi coding agent globally via npm."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

PI_PKG="@earendil-works/pi-coding-agent"

have pi && already pi "$(pi --version 2>/dev/null | head -1)"
require_cmd npm node
log "npm install -g $PI_PKG"
run npm install -g "$PI_PKG"
ok "pi installed"
log "config comes from the 'pi' stow package; run 'pi' once to authenticate (writes ~/.pi/agent/auth.json)"
