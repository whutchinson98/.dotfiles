#!/usr/bin/env bash
# Install the OpenAI Codex CLI as a global npm package on fnm's active node.
#
# Auth and config (~/.codex/) are not managed here; run `codex` once
# afterwards to sign in.
SCRIPT_DESC="Install the OpenAI Codex CLI globally via npm."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

CODEX_PKG="@openai/codex"

have codex && already codex "$(codex --version 2>/dev/null | head -1)"
require_cmd npm node
log "npm install -g $CODEX_PKG"
run npm install -g "$CODEX_PKG"
ok "codex installed — run 'codex' once to authenticate (writes ~/.codex/auth.json)"
