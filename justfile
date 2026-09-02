# Dotfiles managed with GNU Stow.
#
# Packages are discovered dynamically: every top-level directory is a stow
# package except those in NON_PACKAGES. Target and --no-folding come from
# .stowrc, so plain `stow <pkg>` from this directory behaves identically.

set shell := ["bash", "-uc"]

REPO := justfile_directory()
TARGET := env("HOME")

# Top-level dirs that are NOT stow packages.
NON_PACKAGES := "docs install"

# Install order for `install-all`: prerequisites before their dependants.
# rust before the cargo tools, go before gopls, fnm before node before pi.
INSTALL_ORDER := "git stow fish tmux alacritty eza fzf fd fonts starship mise rust jj ripgrep just go gopls neovim fnm node pi bun pnpm op claude herdr"

# Shell snippet that prints one package name per line.
pkgs := "ls -1 " + REPO + " | while read -r d; do [ -d '" + REPO + "'/\"$d\" ] || continue; case \" " + NON_PACKAGES + " \" in *\" $d \"*) continue;; esac; echo \"$d\"; done"

_default:
    @just --list --unsorted

# List the discovered stow packages.
[group('info')]
list:
    @{{ pkgs }} | tr '\n' ' '; echo
    @echo "($({{ pkgs }} | wc -l) packages -> {{ TARGET }})"

# Dry run: show what a sync would do, changing nothing.
[group('info')]
check:
    @cd {{ REPO }} && stow --simulate --verbose $({{ pkgs }} | tr '\n' ' ') 2>&1 || true

# Symlink every package into $HOME. Safe and idempotent.
[group('sync')]
sync:
    @cd {{ REPO }} && stow --verbose $({{ pkgs }} | tr '\n' ' ')
    @echo "synced $({{ pkgs }} | wc -l) packages -> {{ TARGET }}"

# Symlink a single package, e.g. `just sync-one nvim`.
[group('sync')]
sync-one PKG:
    @cd {{ REPO }} && stow --verbose {{ PKG }}

# Re-link everything, clearing stale links left by renamed or deleted files.
[group('sync')]
resync:
    @cd {{ REPO }} && stow --restow --verbose $({{ pkgs }} | tr '\n' ' ')
    @echo "restowed $({{ pkgs }} | wc -l) packages"

# Remove all symlinks this repo owns. Leaves the repo untouched.
[group('sync')]
unsync:
    @cd {{ REPO }} && stow --delete --verbose $({{ pkgs }} | tr '\n' ' ')
    @echo "unstowed — $HOME no longer links to this repo"

# How `force` works: stow --adopt moves a conflicting live file INTO the repo
# (overwriting the tracked copy), then `git checkout` throws that away and
# restores the committed version. Net effect: the link is created and the
# repo's content wins, and the conflicting $HOME file is gone.
#
# It refuses to run with uncommitted changes to TRACKED files, since those are
# exactly what `git checkout` would discard. Untracked files are never at risk.

# Force this repo to win over conflicting real files in $HOME.
[group('sync')]
force:
    #!/usr/bin/env bash
    set -euo pipefail
    cd {{ REPO }}
    if ! git diff --quiet || ! git diff --cached --quiet; then
        echo "refusing: you have uncommitted changes to tracked files, which force would discard."
        echo "commit or stash them first:"
        git status --short --untracked-files=no
        exit 1
    fi
    before=$(git ls-files --others --exclude-standard | sort)
    stow --adopt --verbose $({{ pkgs }} | tr '\n' ' ')
    git checkout -- .
    after=$(git ls-files --others --exclude-standard | sort)
    echo "force-synced — repo content now wins; conflicting \$HOME files were replaced by links"
    stray=$(comm -13 <(echo "$before") <(echo "$after") || true)
    if [ -n "$stray" ]; then
        echo "note: --adopt pulled in files with no tracked counterpart; review or delete them:"
        echo "$stray" | sed 's/^/  /'
    fi

# The inverse of `force`: whatever is currently in $HOME wins. Review the
# resulting diff before committing.

# Pull live $HOME edits back into the repo, then show the diff.
[group('sync')]
adopt:
    @cd {{ REPO }} && stow --adopt --verbose $({{ pkgs }} | tr '\n' ' ')
    @cd {{ REPO }} && git --no-pager diff --stat
    @echo "adopted live files — review the diff above, then commit"

# Example: just track nvim .config/nvim/lua/keymaps.lua

# Move a live $HOME file into a package and link it back.
[group('sync')]
track PKG REL:
    #!/usr/bin/env bash
    set -euo pipefail
    src="{{ TARGET }}/{{ REL }}"
    dst="{{ REPO }}/{{ PKG }}/{{ REL }}"
    [ -e "$src" ] || { echo "no such file: $src"; exit 1; }
    [ -L "$src" ] && { echo "already a symlink (tracked?): $src"; exit 1; }
    mkdir -p "$(dirname "$dst")"
    cp -p "$src" "$dst"
    cmp -s "$src" "$dst" || { echo "copy mismatch, aborting"; exit 1; }
    rm "$src"
    cd {{ REPO }} && stow --verbose "{{ PKG }}"
    echo "tracked {{ REL }} in package {{ PKG }}"

# Report broken symlinks in $HOME that point into this repo.
[group('info')]
doctor:
    #!/usr/bin/env bash
    set -uo pipefail
    echo "== broken links pointing into this repo =="
    found=0
    while IFS= read -r l; do
        tgt=$(readlink -m "$l")
        case "$tgt" in {{ REPO }}*) echo "  BROKEN  $l -> $(readlink "$l")"; found=1;; esac
    done < <(find "{{ TARGET }}" -maxdepth 4 -xtype l 2>/dev/null)
    [ "$found" -eq 0 ] && echo "  none"
    echo "== conflicts blocking a sync =="
    cd {{ REPO }} && stow --simulate $({{ pkgs }} | tr '\n' ' ') 2>&1 \
        | grep -i 'existing target\|cannot stow\|conflict' || echo "  none"

# Remove broken symlinks in $HOME that point into this repo.
[group('sync')]
prune:
    #!/usr/bin/env bash
    set -uo pipefail
    n=0
    while IFS= read -r l; do
        tgt=$(readlink -m "$l")
        case "$tgt" in {{ REPO }}*) rm "$l"; echo "removed $l"; n=$((n+1));; esac
    done < <(find "{{ TARGET }}" -maxdepth 4 -xtype l 2>/dev/null)
    echo "pruned $n broken link(s)"

# Install just + stow for this OS (see init.sh), then sync.
[group('setup')]
bootstrap:
    @cd {{ REPO }} && ./init.sh
    @just sync

# --- installers ---------------------------------------------------------------

# List every program install/ can install, with its method.
[group('install')]
install-list:
    #!/usr/bin/env bash
    set -euo pipefail
    printf '%-12s %-9s %s\n' PROGRAM STATUS METHOD
    printf '%-12s %-9s %s\n' ------- ------ ------
    for s in {{ REPO }}/install/*.sh; do
        n=$(basename "$s" .sh)
        case "$n" in lib|_*) continue ;; esac
        desc=$(sed -n 's/^SCRIPT_DESC="\(.*\)"$/\1/p' "$s" | head -1)
        if {{ REPO }}/install/_installed.sh "$n"; then st=installed; else st=MISSING; fi
        printf '%-12s %-9s %s\n' "$n" "$st" "$desc"
    done

# Show which programs are installed and which are missing.
[group('install')]
install-status:
    #!/usr/bin/env bash
    set -euo pipefail
    missing=()
    for n in {{ INSTALL_ORDER }}; do
        {{ REPO }}/install/_installed.sh "$n" || missing+=("$n")
    done
    total=$(echo {{ INSTALL_ORDER }} | wc -w)
    echo "$((total - ${#missing[@]}))/$total installed"
    if [ ${#missing[@]} -gt 0 ]; then
        echo "missing: ${missing[*]}"
        echo "install them with: just install ${missing[0]}   (or: just install-all)"
    fi

# Install one program, e.g. `just install neovim`. Pass --dry-run to preview.
[group('install')]
install PROG *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    s="{{ REPO }}/install/{{ PROG }}.sh"
    if [ ! -x "$s" ]; then
        echo "no installer for '{{ PROG }}' — available:" >&2
        ls -1 {{ REPO }}/install/*.sh | xargs -n1 basename | sed 's/\.sh$//' \
            | grep -vx lib | grep -v '^_' | sort | tr '\n' ' ' >&2; echo >&2
        exit 1
    fi
    "$s" {{ ARGS }}

# Preview what installing a program would do, changing nothing.
[group('install')]
install-check PROG:
    @just install {{ PROG }} --dry-run

# Example: just update neovim. Installers leave existing installs alone by
# default, which is what keeps install-all a safe no-op; --update opts in.

# Update one already-installed program to its current version.
[group('install')]
update PROG *ARGS:
    @just install {{ PROG }} --update {{ ARGS }}

# Re-runs every installer, so it re-downloads release archives and recompiles
# the cargo tools. Slow; go and neovim skip work when already current.

# Update every installed program.
[group('install')]
update-all *ARGS:
    @just install-all --update {{ ARGS }}

# Install everything that is missing, in dependency order.
[group('install')]
install-all *ARGS:
    #!/usr/bin/env bash
    set -uo pipefail
    failed=()
    for n in {{ INSTALL_ORDER }}; do
        echo
        echo "───── $n ─────"
        if ! "{{ REPO }}/install/$n.sh" {{ ARGS }}; then
            echo "  !! $n failed" >&2
            failed+=("$n")
        fi
    done
    echo
    if [ ${#failed[@]} -gt 0 ]; then
        echo "finished with failures: ${failed[*]}" >&2
        exit 1
    fi
    echo "all installers completed"

# Full setup on a fresh machine: install everything, then stow everything.
[group('setup')]
setup:
    @cd {{ REPO }} && ./init.sh
    @just install-all
    @just sync
    @just install-status
