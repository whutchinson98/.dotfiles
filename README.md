# Dotfiles

Personal configuration, managed with [GNU Stow](https://www.gnu.org/software/stow/)
and driven by [just](https://github.com/casey/just).

Every top-level directory is a **stow package** whose internal layout mirrors
`$HOME`. So `nvim/.config/nvim/init.lua` links to `~/.config/nvim/init.lua`.

## Bootstrap a new machine

```sh
git clone <this repo> ~/d/dotfiles
cd ~/d/dotfiles
./init.sh          # install stow + just
just setup         # install every program, then stow every package
```

`init.sh` detects the OS family (Debian/Ubuntu-style via `apt`, Fedora/RHEL-style
via `dnf`/`yum`, including derivatives such as Pop!_OS, Mint, Rocky and Alma),
installs `stow` and `just`, and can stow everything with `--sync`. If `just` is
not in the distro's repos — it is missing from older apt releases — it falls back
to the upstream installer targeting `~/.local/bin`.

Prefer to go step by step? `./init.sh --sync` gets you configs only; add
`just install-all` when you want the programs too.

## Installing the programs

`install/` holds one script per program, each idempotent and each accepting
`--dry-run`. OS detection and package plumbing live in `install/lib.sh`, shared
with `init.sh`.

```sh
just install-list          # every program, its status and install method
just install-status        # short summary of what is missing
just install neovim        # install one
just install-check neovim  # preview it, changing nothing
just install-all           # install everything missing, in dependency order
```

`install-all` never touches anything already present, so it is safe to re-run —
it only fills gaps. Upgrading is a separate, explicit action:

```sh
just update neovim     # update one program
just update-all        # update everything installed
```

Under the hood both pass `--update`, which every installer honours by falling
through to its normal install path — re-running apt/dnf, the upstream install
script, `cargo install`, `npm -g`, or a fresh release download, whichever that
program uses. `go` and `neovim` compare against the upstream version first and
skip the work when already current. `rust` runs `rustup update`, and `node`
installs the requested version through fnm.

`update-all` re-runs everything, which means recompiling the cargo tools — it
is slow by nature.

Versions can be pinned per-run: `NVIM_VERSION=v0.11.2`, `GO_VERSION=1.24.0`,
`NODE_VERSION=22`, `NERD_FONTS_VERSION=v3.4.0`, `TAILSCALE_VERSION=1.102.3`.

### Install methods

| Program | Method |
| --- | --- |
| fish, tmux, git, alacritty, stow | distro package |
| eza, fzf | distro package, falling back to a GitHub release on older distros |
| fd | distro package `fd-find` (Debian names the binary `fdfind`) |
| op | 1Password's own apt/dnf repository |
| tailscale | Tailscale's own apt/dnf repository, added by their install script |
| starship, mise, fnm, bun, pnpm, claude, herdr, doppler | upstream install script |
| neovim, go, fonts | official release tarball/zip |
| rust (rustup) | rustup.rs; rust-analyzer as a rustup component |
| jj, ripgrep, just | `cargo install --locked` |
| node | `fnm install` |
| pi | `npm install -g @earendil-works/pi-coding-agent` |
| gopls | `go install` |

Dependency order is declared once, in `INSTALL_ORDER` in the justfile: rustup
before the cargo tools, go before gopls, fnm before node before pi. Individual
scripts also guard their own prerequisites, so `just install jj` on a machine
without cargo tells you to run `just install rust` first rather than failing
obscurely.

`tailscale` is the one installer that leaves a manual step behind: it installs
the package and enables `tailscaled`, but joining a tailnet needs a browser or
an auth key, so it prints a reminder to run `sudo tailscale up` and stops
there. Nothing in this repo stores tailnet credentials.

`install/` is not a stow package — it, and `docs/`, are listed in
`NON_PACKAGES`.

## Day to day

```sh
just              # list all recipes
just list         # show discovered packages
just check        # dry run: what would a sync do?
just sync         # link everything into $HOME (safe, idempotent)
just sync-one jj  # link a single package
just resync       # re-link, clearing links stale after a rename/delete
just unsync       # remove every link this repo owns
just doctor       # report broken links and sync conflicts
```

Packages are discovered dynamically, so a new top-level directory is picked up
with no edit to the justfile. `docs/` is the one directory excluded — see
`NON_PACKAGES` in the justfile.

### Adding a config

```sh
just track nvim .config/nvim/lua/keymaps.lua
```

Moves the live file into the package, verifies the copy, deletes the original
and links it back. Then commit.

### When $HOME and the repo disagree

Stow refuses to overwrite a real file, so a fresh machine with distro-default
configs will report conflicts. Two ways to resolve, depending on which side
should win:

```sh
just force    # repo wins: replace conflicting $HOME files with links
just adopt    # $HOME wins: pull live files into the repo, then review the diff
```

`force` requires a clean worktree for tracked files, because it works by letting
`stow --adopt` pull the conflicting file in and then discarding that with
`git checkout`. `adopt` is the inverse and leaves you a diff to inspect before
committing.

## What is deliberately *not* here

Generated state, caches and credentials are excluded on purpose. `.stowrc` sets
`--no-folding` so stow creates real directories and links individual files —
that way tools which write state next to their config (fish writing
`fish_variables`, pi writing `auth.json`) do not end up writing into this repo.

Notable exclusions:

| Path | Why |
| --- | --- |
| `~/.config/fish/fish_variables` | Generated by fish; also duplicates PATH already set in `config.fish` |
| `~/.config/fish/completions/{bun,aws}.fish` | Vendored by the tools' installers |
| `~/.config/nvim.bak/` | Stock AstroNvim template plus a stale nested duplicate |
| `~/.config/jj/repos/` | Per-workspace local state with absolute paths |
| `~/.pi/agent/auth.json` | **Live OAuth tokens** |
| `~/.pi/agent/{sessions,trust.json,models-store.json}` | Transcripts, local trust decisions, fetched model cache |
| `~/.claude/` except `settings.json` | Transcripts, plugin cache and prompt history; credentials in `.credentials.json` |
| `~/.claude/hooks/herdr-agent-state.sh` | Self-declared "managed by herdr"; reinstalling herdr overwrites it |
| `~/.cursor/`, `~/.config/Cursor/` | Almost entirely state; credentials in cookie stores. `~/.cursor/.gitignore` ignores `*`, so Cursor itself declares it not-for-VC |
| `~/.config/{go,bruno}/` | Telemetry counters and Electron cache |
| `~/.config/{kdeglobals,gtk-3.0,gtk-4.0,qt5ct,qt6ct,cosmic}` | Generated by COSMIC's theme bridge |
| `~/.bashrc`, `~/.profile` | Stock Debian defaults; fish is the real shell |

`.gitignore` guards the credential paths defensively, so an accidental recursive
copy of `~/.pi` or `~/.claude` into this repo cannot leak secrets.

## Notes

- `pi/` vendors the full agent config — extensions, skills, agents, prompts and
  themes — so pi bootstraps from this repo standalone. It previously lived in
  `nixos-config/configs/pi` and was symlinked in by `modules/dev/ai.nix`.
  `docs/pi.md` is that config's own README, kept out of the stow tree so it is
  never linked into `$HOME`; its description of Home Manager doing the linking
  is now historical.
- `pi/.pi/agent/settings.json` is mutable — pi rewrites `lastChangelogVersion`
  and any theme/model change through the symlink, so expect occasional churn.
  `claude/.claude/settings.json` behaves the same way: changing theme or model
  via `/config` writes through the link.
- `claude/.claude/settings.json` is the live file as of 2026-09-02. A larger,
  independently-diverged copy exists at `nixos-config/configs/claude/settings.json`
  with a `permissions` allow/ask block, a `notify-send` Notification hook, a
  model pin and several flags — deliberately not merged. Its `SessionStart` hook
  points at the herdr-managed `~/.claude/hooks/herdr-agent-state.sh` by absolute
  path, which will not exist on a fresh machine until herdr is installed; the
  hook failing is non-fatal.
- Several files still carry `# Converted from nixos-config/...` headers.
- `scripts/tmux-sessionizer` is bound to `Ctrl-F` in `config.fish`, so fish and
  that script need to stay stowed together. It shells out to `fzf`.
- `config.fish` sets `RIPGREP_CONFIG_PATH=~/.ripgreprc`, but no such file is
  tracked here and none exists. Harmless — ripgrep ignores a missing config —
  but the variable is currently pointing at nothing.
- `config.fish` activates **mise** and `conf.d/fnm.fish` sets up **fnm**; both
  are installed deliberately. node comes from fnm, and `fnm env` is what puts
  pi on `PATH`.
- `fish_user_paths` (in the untracked `fish_variables`) has accumulated
  duplicates — `~/.bun/bin` appears 6 times on `PATH`, fnm's dir 5 times —
  because `fish_add_path` writes to a universal variable that persists while
  `config.fish` re-adds the same entries each session. Cosmetic, but worth a
  `set -e fish_user_paths` someday.
