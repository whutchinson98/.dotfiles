#!/usr/bin/env bash
# Install gopls, the Go language server. nvim's lsp.lua configures it with
# cmd = { "gopls" }, so it just needs to be on PATH.
# `go install` puts it in $GOPATH/bin (~/go/bin), which config.fish adds
# to PATH via GO_PATH.
SCRIPT_DESC="Install gopls via go install."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

have gopls && already gopls "$(gopls version 2>/dev/null | head -1)"
require_cmd go go
log "go install golang.org/x/tools/gopls@latest"
run go install golang.org/x/tools/gopls@latest
ok "gopls installed to $(go env GOPATH 2>/dev/null || echo '$HOME/go')/bin"
