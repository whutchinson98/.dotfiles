function tmux_new_session
    set -l session_name (basename $PWD | tr '.' '_')
    tmux new-session -A -s $session_name
end
