# Abbreviations and aliases — converted from nixos-config/modules/terminal/fish.nix
# (programs.fish.shellAbbrs / shellAliases)

status is-interactive; or exit 0

# --- Basic ---
abbr -a c -- clear
abbr -a ls -- 'eza --long --git --icons --all'
abbr -a l -- ls

# --- Git ---
abbr -a gp -- 'git push'
abbr -a gpu -- 'git pull'
abbr -a gs -- 'git status'
abbr -a glo -- 'git log --oneline'
abbr -a gwtc -- 'git config --get remote.origin.fetch'
abbr -a gwtf -- 'git config remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"'
abbr -a cleangit -- "git branch | awk '{print \$1}' | xargs git branch -D && git fetch -p"
abbr -a gitlfsfix -- 'git rm --cached -r . && git reset --hard'

# --- Nix ---
abbr -a nd -- 'nix develop -c $SHELL'

# --- Cargo ---
abbr -a cb -- 'cargo build'
abbr -a cbr -- 'cargo build --release'
abbr -a cr -- 'cargo run'
abbr -a ct -- 'cargo test'

# --- Aliases (shellAliases) ---
alias jjw jj_workspace_add
alias tm tmux_new_session
