#!/usr/bin/env bash
# Install GeistMono Nerd Font into ~/.local/share/fonts.
#
# alacritty.toml names "GeistMono Nerd Font" for all four styles; without it
# Alacritty silently falls back to a default face, and the starship prompt
# plus nvim's devicons render as boxes.
#
# Set NERD_FONTS_VERSION to pin a ryanoasis/nerd-fonts release tag.
SCRIPT_DESC="Install GeistMono Nerd Font to ~/.local/share/fonts."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

FONT_NAME="GeistMono"
FONT_DIR="$HOME/.local/share/fonts"

if have fc-list && [ "$(fc-list 2>/dev/null | grep -ci geistmono)" -gt 0 ]; then
    already "GeistMono Nerd Font" "$(fc-list | grep -ci geistmono) faces"
fi

have unzip || pkg_install unzip
tag="${NERD_FONTS_VERSION:-$(github_latest_tag ryanoasis/nerd-fonts)}"
[ -n "$tag" ] || die "could not determine latest nerd-fonts release (set NERD_FONTS_VERSION to pin one)"
log "nerd-fonts $tag — $FONT_NAME"

tmp="$(mktempdir)"
download "https://github.com/ryanoasis/nerd-fonts/releases/download/${tag}/${FONT_NAME}.zip" "$tmp/font.zip"

run mkdir -p "$FONT_DIR"
log "unpacking into $FONT_DIR"
run unzip -oq "$tmp/font.zip" -d "$FONT_DIR" -x 'README*' 'LICENSE*' 'OFL*'

if have fc-cache; then
    log "rebuilding font cache"
    run fc-cache -f "$FONT_DIR"
else
    warn "fc-cache not found — install fontconfig, or log out and back in for fonts to register"
fi

ok "$FONT_NAME Nerd Font $tag installed"
