# AWS

Raw dotfiles equivalent of `modules/dev/aws.nix`.

Stow this package from `~/.dotfiles` to create:

- `~/.aws/config` with `work` and `personal` profiles
- `~/.local/bin/op-aws-work-creds`
- `~/.local/bin/op-aws-creds`

Install AWS CLI v2 with `just install aws`. The credential helpers read AWS access keys from 1Password with `op` and emit the JSON shape expected by AWS CLI `credential_process`. They require `op` and `jq` on `PATH`.

If you want the Nix module's `default-chain` behavior instead of 1Password-backed credentials, remove or comment the `credential_process` lines in `.aws/config`.
