#!/usr/bin/env bash
# Install the Rust toolchain via rustup, plus rust-analyzer as a rustup
# component. config.fish adds ~/.cargo/bin to PATH and conf.d/rustup.fish
# sources ~/.cargo/env.fish.
#
# rust-analyzer's user config is tracked in the rust-analyzer stow package
# at ~/.config/rust-analyzer/rust-analyzer.toml; nvim's lsp.lua drives it.
SCRIPT_DESC="Install rustup + the stable toolchain, and rust-analyzer as a component."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

if have rustup; then
    if [ "$UPDATE" = "1" ]; then
        log "updating the rust toolchain (rustup update)"
        run rustup update
    else
        ok "rustup already installed ($(rustup --version 2>/dev/null | head -1))"
    fi
else
    ensure_curl
    have cc || pkg_install build-essential gcc
    log "installing rustup + stable toolchain"
    run_shell "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path"
    # shellcheck disable=SC1091
    [ "$DRY_RUN" = "1" ] || . "$HOME/.cargo/env"
fi

if have rust-analyzer && [ "$UPDATE" != "1" ]; then
    ok "rust-analyzer already installed"
else
    log "adding/updating the rust-analyzer component"
    run rustup component add rust-analyzer
fi

ok "rust toolchain ready"
