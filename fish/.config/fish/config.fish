if status is-interactive
    # Commands to run in interactive sessions can go here
end
fish_add_path /usr/local/go/bin
mise activate fish | source

# Pi
fish_add_path "/home/hutch/.local/share/fnm/node-versions/v26.8.1/installation/bin"

# ============================================================================
# Converted from nixos-config/modules/terminal/fish.nix (programs.fish.shellInit)
# ============================================================================

# Disable fish greeting
set -U fish_greeting ""

# Load 1Password CLI plugins
if test -f ~/.config/op/plugins.sh
    source ~/.config/op/plugins.sh
end

# --- Environment variables ---
set -gx TERM screen-256color
set -gx GO_PATH $HOME/go/bin
set -gx DOCKER_GATEWAY_HOST 172.17.0.1
set -gx RIPGREP_CONFIG_PATH $HOME/.ripgreprc
set -gx EDITOR nvim

if test -e "$HOME/.config/1Password/ssh/agent.toml"
    set -gx SSH_AUTH_SOCK "$HOME/.1password/agent.sock"
end

# --- Bun ---
set -gx BUN_INSTALL "$HOME/.bun"
fish_add_path "$BUN_INSTALL/bin"

# --- PATH additions ---
fish_add_path $HOME/bin /usr/local/bin $HOME/.local/bin
fish_add_path /opt/nvim-linux-x86_64/bin
fish_add_path $HOME/.config/emacs/bin
fish_add_path $HOME/.pulumi/bin

# These come from the Nix config unquoted/unguarded; guard them so an unset
# variable can't inject a bare "/bin" into PATH.
set -q CARGO_HOME; and fish_add_path "$CARGO_HOME/bin"
set -q PNPM_HOME; and fish_add_path "$PNPM_HOME"

# Conditional path additions
test -d "$GO_PATH"; and fish_add_path "$GO_PATH"
set -q JAVA_HOME; and test -d "$JAVA_HOME/bin"; and fish_add_path "$JAVA_HOME/bin"
set -q DOTNET_ROOT; and test -d "$DOTNET_ROOT"; and fish_add_path "$DOTNET_ROOT"

# Rustup/Cargo setup (note: conf.d/rustup.fish already sources ~/.cargo/env.fish)
if test -d "$HOME/.cargo"
    fish_add_path "$HOME/.cargo/bin"
end

# --- Interactive-only setup ---
if status is-interactive
    # Key bindings
    bind \cf 'fish -c "~/scripts/tmux-sessionizer"'

    # Initialize tools
    starship init fish | source
end

# bun
set --export BUN_INSTALL "$HOME/.bun"
set --export PATH $BUN_INSTALL/bin $PATH
source /home/hutch/.config/op/plugins.sh

# pnpm
set -gx PNPM_HOME "/home/hutch/.local/share/pnpm"
if not string match -q -- "$PNPM_HOME/bin" $PATH
  set -gx PATH "$PNPM_HOME/bin" $PATH
end
# pnpm end
