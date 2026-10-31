-- Standalone port of nixos-config/modules/terminal/neovim{.nix,/}
--
-- Load order mirrors the Home Manager mkOrder values:
--   editor  (mkOrder  500) -- leaders must be set before plugins load
--   plugins (default 1000)
--   lsp     (mkOrder 1200)

-- Also load ripgrep defaults when Neovim is launched outside Fish.
if not vim.env.RIPGREP_CONFIG_PATH or vim.env.RIPGREP_CONFIG_PATH == "" then
  vim.env.RIPGREP_CONFIG_PATH = vim.fn.expand("~/.ripgreprc")
end

require("editor")
require("plugins")
require("lsp")
