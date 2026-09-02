-- Port of modules/terminal/neovim/plugins.nix
--
-- Under Nix these came from pkgs.vimPlugins and were placed on the runtimepath
-- directly; here lazy.nvim fetches them. Each `config` below is verbatim from
-- the corresponding attribute in plugins.nix.

-- Bootstrap lazy.nvim
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not (vim.uv or vim.loop).fs_stat(lazypath) then
  local out = vim.fn.system({
    "git",
    "clone",
    "--filter=blob:none",
    "--branch=stable",
    "https://github.com/folke/lazy.nvim.git",
    lazypath,
  })
  if vim.v.shell_error ~= 0 then
    error("Failed to clone lazy.nvim:\n" .. out)
  end
end
vim.opt.rtp:prepend(lazypath)

require("lazy").setup({
  spec = {
    -- Plugins with no configuration of their own in plugins.nix
    { "rafamadriz/friendly-snippets" },
    { "ellisonleao/gruvbox.nvim" },
    { "neovim/nvim-lspconfig" },
    { "nvim-tree/nvim-web-devicons" },
    { "nvim-lua/plenary.nvim" },
    { "folke/which-key.nvim" },

    {
      -- Nix used nvim-treesitter.withPlugins with these parsers. No setup()
      -- call was made there either, so parsers are installed but treesitter
      -- highlighting stays off — see the note in the README.
      "nvim-treesitter/nvim-treesitter",
      branch = "master",
      build = ":TSUpdate",
      config = function()
        require("nvim-treesitter.configs").setup({
          ensure_installed = { "lua", "vim", "rust", "typescript" },
          auto_install = false,
        })
      end,
    },

    {
      "saghen/blink.cmp",
      version = "*", -- release tag ships the prebuilt rust fuzzy matcher
      dependencies = { "rafamadriz/friendly-snippets" },
      config = function()
        require("blink.cmp").setup({
          keymap = { preset = "default" },
          appearance = {
            nerd_font_variant = "mono",
          },
          completion = {
            documentation = { auto_show = false },
          },
          sources = {
            default = { "lsp", "path" },
          },
          fuzzy = { implementation = "prefer_rust" },
        })
      end,
    },

    {
      "ThePrimeagen/harpoon",
      branch = "harpoon2",
      dependencies = { "nvim-lua/plenary.nvim" },
      config = function()
        local harpoon = require("harpoon")

        harpoon:setup()

        vim.keymap.set(
          "n",
          "<C-S-T>",
          function() harpoon.ui:toggle_quick_menu(harpoon:list()) end,
          { desc = "show harpoon quick menu" }
        )

        vim.keymap.set(
          "n",
          "<leader>h",
          function() harpoon:list():add() end,
          { desc = "add file" }
        )

        vim.keymap.set(
          "n",
          "<leader>jf",
          function() harpoon:list():select(1) end,
          { desc = "harpoon nav file 1" }
        )

        vim.keymap.set(
          "n",
          "<leader>jd",
          function() harpoon:list():select(2) end,
          { desc = "harpoon nav file 2" }
        )

        vim.keymap.set(
          "n",
          "<leader>js",
          function() harpoon:list():select(3) end,
          { desc = "harpoon nav file 3" }
        )

        vim.keymap.set(
          "n",
          "<leader>ja",
          function() harpoon:list():select(4) end,
          { desc = "harpoon nav file 4" }
        )

        vim.keymap.set(
          "n",
          "<C-S-P>",
          function() harpoon:list():prev() end,
          { desc = "harpoon previous file" }
        )

        vim.keymap.set(
          "n",
          "<C-S-N>",
          function() harpoon:list():next() end,
          { desc = "harpoon next file" }
        )
      end,
    },

    {
      "nvim-lualine/lualine.nvim",
      config = function()
        require("lualine").setup({
          options = {
            icons_enabled = true,
            theme = "auto",
            component_separators = { left = "", right = "" },
            section_separators = { left = "", right = "" },
            disabled_filetypes = {
              statusline = {},
              winbar = {},
            },
            ignore_focus = {},
            always_divide_middle = true,
            always_show_tabline = true,
            globalstatus = false,
            refresh = {
              statusline = 1000,
              tabline = 1000,
              winbar = 1000,
              refresh_time = 16,
              events = {
                "WinEnter",
                "BufEnter",
                "BufWritePost",
                "SessionLoadPost",
                "FileChangedShellPost",
                "VimResized",
                "Filetype",
                "CursorMoved",
                "CursorMovedI",
                "ModeChanged",
              },
            },
          },
          sections = {
            lualine_a = { "filename" },
            lualine_b = {},
            lualine_x = { "filetype" },
            lualine_y = { "progress" },
            lualine_z = { "location" },
          },
          inactive_sections = {
            lualine_a = {},
            lualine_b = {},
            lualine_c = {},
            lualine_x = {},
            lualine_y = {},
            lualine_z = {},
          },
          tabline = {},
          winbar = {},
          inactive_winbar = {},
          extensions = {},
        })
      end,
    },

    {
      "echasnovski/mini.icons",
      config = function()
        require("mini.icons").setup({})
      end,
    },

    {
      "stevearc/oil.nvim",
      config = function()
        require("oil").setup()

        vim.keymap.set(
          "n",
          "-",
          "<CMD>Oil<CR>",
          { desc = "toggle oil" }
        )
      end,
    },

    {
      "ojroques/nvim-osc52",
      config = function()
        vim.keymap.set("v", "<leader>y", require("osc52").copy_visual)
      end,
    },

    {
      "nvim-telescope/telescope.nvim",
      dependencies = { "nvim-lua/plenary.nvim" },
      config = function()
        require("telescope").setup({
          defaults = {
            file_ignore_patterns = { "^%.direnv/" },
          },
        })

        local builtin = require("telescope.builtin")
        vim.keymap.set("n", "<leader>ff", builtin.find_files, { desc = "Telescope find files" })
        vim.keymap.set("n", "<leader>fw", builtin.live_grep, { desc = "Telescope live grep" })
        vim.keymap.set("n", "<leader>fb", builtin.buffers, { desc = "Telescope buffers" })
      end,
    },

    {
      -- Last in plugins.nix, so it wins the colorscheme; priority keeps that
      -- ordering under lazy.nvim.
      "shaunsingh/nord.nvim",
      priority = 1000,
      config = function()
        vim.cmd("colorscheme nord")
        vim.cmd(":hi statusline guibg=NONE")
      end,
    },
  },

  -- Nix pinned every plugin in the flake lock; lazy-lock.json is the analogue.
  -- No update checker, matching the declarative-config feel.
  install = { colorscheme = { "nord", "habamax" } },
  checker = { enabled = false },
  change_detection = { notify = false },
})
