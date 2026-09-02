-- Standalone port of nixos-config/modules/terminal/neovim{.nix,/}
--
-- Load order mirrors the Home Manager mkOrder values:
--   editor  (mkOrder  500) -- leaders must be set before plugins load
--   plugins (default 1000)
--   lsp     (mkOrder 1200)

require("editor")
require("plugins")
require("lsp")
