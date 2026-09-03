#!/usr/bin/env bash
# Install AWS CLI v2 from Amazon's official bundled installer. Distro packages
# are deliberately avoided because they may still provide AWS CLI v1.
SCRIPT_DESC="Install AWS CLI v2 from Amazon's official bundled installer."
. "$(dirname "$(readlink -f "$0")")/lib.sh"
lib_parse_args "$@"

if have aws; then
    already aws "$(aws --version 2>&1 | head -1)"
fi

case "$ARCH" in
    x86_64)  awsarch=x86_64 ;;
    aarch64) awsarch=aarch64 ;;
    *) die "no AWS CLI v2 release build for arch: $ARCH" ;;
esac

ensure_curl
have unzip || pkg_install unzip unzip
need_sudo
mktempdir
download "https://awscli.amazonaws.com/awscli-exe-linux-${awsarch}.zip" "$TMP_DIR/awscliv2.zip"
run unzip -q "$TMP_DIR/awscliv2.zip" -d "$TMP_DIR"

log "installing AWS CLI v2 to /usr/local/aws-cli"
if [ -d /usr/local/aws-cli/v2/current ]; then
    run $SUDO "$TMP_DIR/aws/install" \
        --bin-dir /usr/local/bin \
        --install-dir /usr/local/aws-cli \
        --update
else
    run $SUDO "$TMP_DIR/aws/install" \
        --bin-dir /usr/local/bin \
        --install-dir /usr/local/aws-cli
fi

ok "AWS CLI v2 installed ($(if [ "$DRY_RUN" = "1" ]; then echo dry run; else aws --version 2>&1; fi))"
