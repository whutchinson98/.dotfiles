function jj_workspace_add --argument workspace_name
    if test -z "$workspace_name"
        echo "Usage jj_workspace_add <workspace_name"
        return 1
    end
    set folder (basename (pwd))
    jj workspace add "../$folder-$workspace_name"
end
