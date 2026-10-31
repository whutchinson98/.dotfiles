if status is-interactive
    # Commands to run in interactive sessions can go here
	starship init fish | source
end

fish_add_path ~/.local/bin

# Use the 1Password SSH agent for authentication and signing.
set -gx SSH_AUTH_SOCK "$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
