if status is-interactive
    # Commands to run in interactive sessions can go here
	starship init fish | source
end

fish_add_path ~/.local/bin

# Tell ripgrep (including Telescope searches) where to load its defaults.
set -gx RIPGREP_CONFIG_PATH "$HOME/.ripgreprc"

# Use the 1Password SSH agent for authentication and signing.
set -gx SSH_AUTH_SOCK "$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"

# Added by OrbStack: command-line tools and integration
# This won't be added again if you remove it.
source ~/.orbstack/shell/init2.fish 2>/dev/null || :
