#!/usr/bin/env bash
# Finalize the current jj working copy as one commit, put a bookmark on it,
# and push that bookmark to the git remote.
#
# Usage:
#   publish.sh <bookmark-name> <commit-message-file> [remote]
#
# The commit message file lets the caller pass a multi-line message without
# shell-quoting headaches. Exits non-zero (and pushes nothing) when the
# working copy has no changes, the bookmark name is invalid, or the repo is
# not a jj repo. Prints the pushed bookmark and its commit on success.
set -euo pipefail

bookmark="${1:-}"
message_file="${2:-}"
remote="${3:-origin}"

die() { printf 'publish.sh: %s\n' "$*" >&2; exit 1; }

[[ -n "$bookmark" ]] || die "usage: publish.sh <bookmark-name> <commit-message-file> [remote]"
[[ -n "$message_file" && -s "$message_file" ]] || die "commit message file '$message_file' is missing or empty"
jj root >/dev/null 2>&1 || die "not inside a jj repository (run 'jj git init --colocate' first?)"

# Git ref rules, kept strict on purpose: lowercase, digits, . _ - and / as a
# namespace separator. Anything else tends to fail at push time with a much
# less helpful error.
[[ "$bookmark" =~ ^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$ ]] \
  || die "bookmark '$bookmark' is not a valid name (use lowercase, digits, '.', '_', '-', '/')"

if jj bookmark list "$bookmark" 2>/dev/null | grep -q .; then
  die "bookmark '$bookmark' already exists; pick another name or delete it with 'jj bookmark delete $bookmark'"
fi

# jj tracks the working copy as a real commit. If it has no diff there is
# nothing to publish, and pushing an empty commit is almost always a mistake.
if [[ -z "$(jj diff -r @ --summary 2>/dev/null)" ]]; then
  die "working copy (@) has no changes; nothing to publish"
fi

# Turn @ into a described commit and start a fresh empty @ on top, so the
# bookmark points at the finished work rather than at a moving working copy.
jj commit --message "$(cat "$message_file")" >/dev/null
jj bookmark create "$bookmark" --revision '@-' >/dev/null

# A bookmark the remote has never seen is created and tracked automatically.
jj git push --remote "$remote" --bookmark "$bookmark"

printf '\npushed %s -> %s\n' "$bookmark" "$remote"
jj log -r "$bookmark" --no-graph \
  -T 'change_id.short() ++ " " ++ commit_id.short() ++ " " ++ description.first_line() ++ "\n"'
