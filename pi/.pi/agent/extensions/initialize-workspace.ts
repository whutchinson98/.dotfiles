import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createBashTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const INITIALIZED_ROOTS = new Set<string>();
const NIX_BASH_ROOTS = new Set<string>();
const NIX_DEVELOP_COMMANDS = ["cargo", "bun", "npm", "pnpm", "go", "just", "doppler"] as const;
const SETUP_TIMEOUT_MS = 60_000;
const REMOTE_REPOSITORIES_COMMAND = String.raw`jj git remote list \
  | awk '{print $2}' \
  | sed -E 's#^(git@|https://)([^/:]+)[:/]##; s#\.git$##'`;

function findFlakeRoot(cwd: string): string | undefined {
  let current = path.resolve(cwd);

  while (true) {
    if (fs.existsSync(path.join(current, "flake.nix"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function isConfiguredWorkspace(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  const result = await pi.exec("bash", ["-lc", REMOTE_REPOSITORIES_COMMAND], {
    cwd,
    timeout: 5_000,
  });
  if (result.code !== 0) return false;

  const remoteRepositories = result.stdout.split(/\r?\n/).filter(Boolean);
  if (remoteRepositories.length === 0) return false;

  const workspaceRepositoriesPath = path.join(os.homedir(), "workspace-repos");
  if (!fs.existsSync(workspaceRepositoriesPath)) return false;

  const workspaceRepositories = new Set(
    fs.readFileSync(workspaceRepositoriesPath, "utf8").split(/\r?\n/).filter(Boolean),
  );

  return remoteRepositories.some((repository) => workspaceRepositories.has(repository));
}

function isSubagentProcess(): boolean {
  return process.env.PI_SUBAGENT === "1";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandExists(command: string): boolean {
  const result = spawnSync("bash", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
    stdio: "ignore",
    timeout: 5_000,
  });

  return result.status === 0;
}

function nixDevelopCommandWrappers(flakeRoot: string): string {
  const quotedFlakeRoot = shellQuote(flakeRoot);

  return NIX_DEVELOP_COMMANDS.map(
    (command) => `${command}() {
  PI_SUBAGENT_NIX_DEVELOP=1 nix develop ${quotedFlakeRoot} -c ${command} "$@"
}`,
  ).join("\n\n");
}

function registerSubagentNixBashTool(pi: ExtensionAPI, cwd: string, flakeRoot: string): void {
  if (!isSubagentProcess() || NIX_BASH_ROOTS.has(flakeRoot) || !commandExists("nix")) return;

  NIX_BASH_ROOTS.add(flakeRoot);

  const commandWrappers = nixDevelopCommandWrappers(flakeRoot);
  const bashTool = createBashTool(cwd, {
    spawnHook: ({ command, cwd, env }) => ({
      command: `${commandWrappers}\n\n${command}`,
      cwd,
      env,
    }),
  });

  pi.registerTool({
    ...bashTool,
    execute: async (id, params, signal, onUpdate) => bashTool.execute(id, params, signal, onUpdate),
  });
}

function direnvSetupScript(): string {
  return [
    "set -euo pipefail",
    "",
    "is_nixos() {",
    '  [ -e /etc/NIXOS ] || { [ -f /etc/os-release ] && . /etc/os-release && [ "${ID:-}" = "nixos" ]; }',
    "}",
    "",
    "if ! is_nixos; then",
    '  echo "direnv-setup-skipped: requires NixOS"',
    "  exit 0",
    "fi",
    "",
    "if ! command -v direnv >/dev/null 2>&1; then",
    '  echo "direnv-setup-skipped: direnv unavailable"',
    "  exit 0",
    "fi",
    "",
    "[ -f .envrc ] || : > .envrc",
    "",
    "ensure_envrc_line() {",
    '  local line="$1"',
    "",
    '  if ! grep -qxF "$line" .envrc; then',
    '    if [ -s .envrc ] && [ "$(tail -c 1 .envrc)" != "" ]; then',
    "      printf '\\n' >> .envrc",
    "    fi",
    '    printf "%s\\n" "$line" >> .envrc',
    "  fi",
    "}",
    "",
    'ensure_envrc_line "use flake"',
    'ensure_envrc_line "watch_file nix/*.nix"',
    "",
    'echo "direnv-allow: $(pwd)"',
    "direnv allow",
    'echo "direnv-setup-ran"',
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const flakeRoot = findFlakeRoot(ctx.cwd);
    if (!flakeRoot || !(await isConfiguredWorkspace(pi, flakeRoot))) return;

    registerSubagentNixBashTool(pi, ctx.cwd, flakeRoot);

    if (INITIALIZED_ROOTS.has(flakeRoot)) return;

    INITIALIZED_ROOTS.add(flakeRoot);

    const result = await pi.exec("bash", ["-lc", direnvSetupScript()], {
      cwd: flakeRoot,
      timeout: SETUP_TIMEOUT_MS,
    });

    if (!ctx.hasUI) return;

    const output = `${result.stdout}${result.stderr}`.trim();
    if (result.code === 0) {
      ctx.ui.notify(output || "Workspace initialization skipped", "info");
      return;
    }

    ctx.ui.notify(output || `Workspace initialization failed with exit code ${result.code}`, "error");
  });
}
