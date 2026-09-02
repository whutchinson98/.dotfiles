# nvim

Standalone port of `~/nixos-config/modules/terminal/neovim{.nix,/}`.

| Source                      | Here                    |
| --------------------------- | ----------------------- |
| `neovim/editor.nix`         | `lua/editor.lua`        |
| `neovim/plugins.nix`        | `lua/plugins.lua`       |
| `neovim/lsp.nix`            | `lua/lsp.lua`           |
| `lsp.nix` -> `xdg.configFile` | `~/.config/rust-analyzer/rust-analyzer.toml` |

Load order in `init.lua` mirrors the Home Manager `mkOrder` values: editor
(500, sets the leaders) -> plugins (1000) -> lsp (1200).

## What Nix did that this config cannot

`neovim.nix` had no Lua in it — it only set `programs.neovim` options:

- `withNodeJs`/`withPython3`/`withRuby = false` — irrelevant without the Nix
  wrapper; no providers are installed here anyway.
- `extraPackages` put tool binaries on Neovim's PATH. Install these yourself:
  `lua-language-server`, `nixfmt`, `nixd`, `tree-sitter`, `ripgrep`.

`lua/lsp.lua` also expects these on PATH (same as under Nix, where they came
from project devshells): `gopls`, `just-lsp`, `pyright-langserver`,
`rust-analyzer`, `typescript-language-server`. A missing one just means that
server never attaches.

## Note on treesitter

`plugins.nix` listed `nvim-treesitter.withPlugins` with no `config`, so parsers
were available but `nvim-treesitter.configs.setup` was never called and
treesitter highlighting was off. This config keeps that behaviour — it installs
the same four parsers (lua, vim, rust, typescript) and leaves `highlight`
disabled. Add `highlight = { enable = true }` in `lua/plugins.lua` to turn it on.

## Plugins

lazy.nvim replaces `pkgs.vimPlugins`; `lazy-lock.json` replaces the flake lock.
`:Lazy` to manage, `:Lazy update` to bump.
