# jj (Jujutsu) command-line completions.
# jj ships dynamic completions via clap_complete since v0.24; they cover
# subcommands, aliases, revisions, bookmarks, files, remotes and operation ids.
if status is-interactive
    and command -q jj
    COMPLETE=fish jj | source
end
