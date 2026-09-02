import { homedir } from "node:os";
import { relative } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type Rgb = [number, number, number];

interface ModelDashboardState {
  provider: string;
  modelId: string;
  thinking: string;
  contextWindow: number;
  contextPercent: number | null;
  cost: number;
  tokensPerSecond: number | null;
  generating: boolean;
}

interface JjDashboardState {
  isRepository: boolean;
  changeId: string | null;
  commitId: string | null;
  description: string | null;
  changedFiles: number;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CHARS_PER_ESTIMATED_TOKEN = 4;
const LIVE_UPDATE_INTERVAL_MS = 200;
const JJ_TIMEOUT_MS = 3_000;

const PALETTE: Rgb[] = [
  [22, 83, 189],
  [48, 129, 247],
  [93, 171, 255],
  [151, 205, 255],
  [93, 171, 255],
  [48, 129, 247],
];

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const TITLE_LINES = [
  "  ██████╗  ██╗ ",
  "  ██╔══██╗ ██║ ",
  "  ██████╔╝ ██║ ",
  "  ██╔═══╝  ██║ ",
  "  ██║      ██║ ",
  "  ╚═╝      ╚═╝ ",
];

// eslint-disable-next-line no-control-regex
const OSC_PATTERN = /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

function emptyModelState(): ModelDashboardState {
  return {
    provider: "",
    modelId: "no-model",
    thinking: "off",
    contextWindow: 0,
    contextPercent: null,
    cost: 0,
    tokensPerSecond: null,
    generating: false,
  };
}

function emptyJjState(): JjDashboardState {
  return {
    isRepository: false,
    changeId: null,
    commitId: null,
    description: null,
    changedFiles: 0,
  };
}

function sanitizeTerminalLabel(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function mix(a: number, b: number, amount: number) {
  return Math.round(a + (b - a) * amount);
}

function sampleGradient(position: number): Rgb {
  const wrapped = ((position % 1) + 1) % 1;
  const scaled = wrapped * PALETTE.length;
  const index = Math.floor(scaled);
  const nextIndex = (index + 1) % PALETTE.length;
  const amount = scaled - index;
  const start = PALETTE[index]!;
  const end = PALETTE[nextIndex]!;

  return [
    mix(start[0], end[0], amount),
    mix(start[1], end[1], amount),
    mix(start[2], end[2], amount),
  ];
}

function foreground([red, green, blue]: Rgb, text: string) {
  return `\x1b[38;2;${red};${green};${blue}m${text}${RESET}`;
}

function gradientText(text: string, phase: number) {
  const characters = [...text];
  const span = Math.max(characters.length - 1, 1);

  return characters
    .map((character, index) =>
      character === " " ? character : foreground(sampleGradient(index / span + phase), character),
    )
    .join("");
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  const display = cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
  return sanitizeTerminalLabel(display);
}

function center(text: string, width: number) {
  const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return truncateToWidth(`${" ".repeat(padding)}${text}`, width, "");
}

function columns(left: string, right: string, width: number) {
  if (!right) return truncateToWidth(left, width, "");

  const naturalGap = width - visibleWidth(left) - visibleWidth(right);
  if (naturalGap >= 1) return `${left}${" ".repeat(naturalGap)}${right}`;

  const leftWidth = Math.max(1, Math.floor(width * 0.45));
  const rightWidth = Math.max(1, width - leftWidth - 1);
  const fittedLeft = truncateToWidth(left, leftWidth, "");
  const fittedRight = truncateToWidth(right, rightWidth, "");
  const gap = Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(fittedRight));
  return truncateToWidth(`${fittedLeft}${" ".repeat(gap)}${fittedRight}`, width, "");
}

function formatTokens(tokens: number) {
  if (tokens < 1_000) return `${Math.round(tokens)}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getSessionCost(ctx: ExtensionContext) {
  let cost = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    cost += numberValue(entry.message.usage?.cost?.total);
  }
  return cost;
}

function estimateContentTokens(characters: number) {
  return Math.ceil(characters / CHARS_PER_ESTIMATED_TOKEN);
}

function countChangedFiles(summary: string) {
  return summary
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function parseJjHead(value: string): Pick<JjDashboardState, "changeId" | "commitId" | "description"> {
  const [changeId, commitId, ...descriptionParts] = value.trimEnd().split("\t");
  return {
    changeId: changeId || null,
    commitId: commitId || null,
    description: descriptionParts.join("\t").trim() || null,
  };
}

export default function dashboard(pi: ExtensionAPI) {
  let enabled = true;
  let title = "pi";
  let modelState = emptyModelState();
  let jjState = emptyJjState();
  let requestRender: (() => void) | undefined;
  let jjRefreshGeneration = 0;

  let contentStreamStart: number | null = null;
  let lastContentDeltaAt: number | null = null;
  let contentCharacters = 0;
  let firstContentDeltaCharacters = 0;
  let contentDeltaCount = 0;
  let runContentTokens = 0;
  let runContentStreamMs = 0;
  let lastLiveUpdate = 0;

  function resetMessageTracking() {
    contentStreamStart = null;
    lastContentDeltaAt = null;
    contentCharacters = 0;
    firstContentDeltaCharacters = 0;
    contentDeltaCount = 0;
    lastLiveUpdate = 0;
  }

  function refreshModel(ctx: ExtensionContext) {
    const model = ctx.model;
    const usage = ctx.getContextUsage();
    modelState = {
      ...modelState,
      provider: model?.provider ?? "",
      modelId: model?.id ?? "no-model",
      thinking: model?.reasoning ? pi.getThinkingLevel() : "off",
      contextWindow: usage?.contextWindow ?? model?.contextWindow ?? 0,
      contextPercent: usage?.percent ?? null,
      cost: getSessionCost(ctx),
    };
    requestRender?.();
  }

  async function refreshJj(ctx: ExtensionContext, snapshotWorkingCopy: boolean) {
    const generation = ++jjRefreshGeneration;
    const prefix = ["--ignore-working-copy"];

    try {
      if (snapshotWorkingCopy) {
        const snapshot = await pi.exec("jj", ["status", "--no-pager", "--color", "never"], { timeout: JJ_TIMEOUT_MS });
        if (generation !== jjRefreshGeneration) return;
        if (snapshot.code !== 0) {
          jjState = emptyJjState();
          requestRender?.();
          return;
        }
      }

      const root = await pi.exec("jj", [...prefix, "root"], { timeout: JJ_TIMEOUT_MS });
      if (generation !== jjRefreshGeneration) return;
      if (root.code !== 0) {
        jjState = emptyJjState();
        requestRender?.();
        return;
      }

      const [head, diff] = await Promise.all([
        pi.exec(
          "jj",
          [
            ...prefix,
            "log",
            "-r",
            "@",
            "--no-graph",
            "--color",
            "never",
            "-T",
            'change_id.short() ++ "\\t" ++ commit_id.short() ++ "\\t" ++ description.first_line() ++ "\\n"',
          ],
          { timeout: JJ_TIMEOUT_MS },
        ),
        pi.exec("jj", [...prefix, "diff", "--summary", "--color", "never"], { timeout: JJ_TIMEOUT_MS }),
      ]);
      if (generation !== jjRefreshGeneration) return;

      if (head.code !== 0 || diff.code !== 0) {
        jjState = emptyJjState();
      } else {
        jjState = {
          isRepository: true,
          ...parseJjHead(head.stdout),
          changedFiles: countChangedFiles(diff.stdout),
        };
      }
      requestRender?.();
    } catch {
      if (generation !== jjRefreshGeneration) return;
      jjState = emptyJjState();
      requestRender?.();
    }
  }

  function renderJj(theme: Theme) {
    if (!jjState.isRepository) return "";

    const fileLabel = jjState.changedFiles === 1 ? "file" : "files";
    const change = jjState.changeId ? `jj ${jjState.changeId}` : "jj";
    const description = jjState.description ? ` · ${jjState.description}` : "";
    return theme.fg("muted", `${change} · ${jjState.changedFiles} ${fileLabel} changed${description}`);
  }

  function install(ctx: ExtensionContext) {
    if (!enabled || ctx.mode !== "tui") return;

    ctx.ui.setHeader((tui) => {
      requestRender = () => tui.requestRender();
      return {
        render(width: number) {
          const art = TITLE_LINES.map((line, row) => center(gradientText(line, row * 0.045), width));
          const subtitle = center(`${BOLD}${gradientText(title, 0.18)}${RESET}`, width);
          return ["", ...art, subtitle, ""];
        },
        invalidate() {},
      };
    });

    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      return {
        invalidate() {},
        render(width: number) {
          const directory = theme.fg("text", formatDirectory(ctx.cwd));
          const model = modelState.provider
            ? `${modelState.provider}/${modelState.modelId} · ${modelState.thinking}`
            : modelState.modelId;
          const contextPercent = modelState.contextPercent === null ? "?" : `${Math.round(modelState.contextPercent)}`;
          const contextWindow = modelState.contextWindow > 0 ? formatTokens(modelState.contextWindow) : "?";
          const tps = modelState.tokensPerSecond === null ? "— tok/s" : `${Math.round(modelState.tokensPerSecond)} tok/s`;
          const usage = `${contextPercent}%/${contextWindow} · $${modelState.cost.toFixed(2)} · ${tps}`;
          const jj = renderJj(theme);

          const lines = [
            columns(directory, theme.fg("muted", model), width),
            columns(theme.fg("muted", usage), jj, width),
          ];

          const statuses = footerData.getExtensionStatuses();
          const statusLines = Array.from(statuses.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([, text]) => text.split("\n"));

          for (const statusLine of statusLines) {
            lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
          }

          return lines;
        },
      };
    });

    ctx.ui.setWorkingIndicator({
      frames: SPINNER_FRAMES.map((frame, index) => foreground(PALETTE[index % PALETTE.length]!, frame)),
      intervalMs: 80,
    });
    ctx.ui.setTitle(`pi · ${title}`);
  }

  function uninstall(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader(undefined);
    ctx.ui.setFooter(undefined);
    ctx.ui.setWorkingIndicator();
    requestRender = undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    title = formatDirectory(ctx.cwd);
    modelState = { ...emptyModelState(), generating: false };
    jjState = emptyJjState();
    resetMessageTracking();
    runContentTokens = 0;
    runContentStreamMs = 0;
    refreshModel(ctx);
    install(ctx);
    void refreshJj(ctx, false);
  });

  pi.on("model_select", (_event, ctx) => refreshModel(ctx));

  pi.on("thinking_level_select", (_event, ctx) => refreshModel(ctx));

  pi.on("input", (_event, ctx) => {
    void refreshJj(ctx, true);
    return { action: "continue" as const };
  });

  pi.on("agent_start", (_event, ctx) => {
    resetMessageTracking();
    runContentTokens = 0;
    runContentStreamMs = 0;
    modelState = { ...modelState, tokensPerSecond: null, generating: true };
    refreshModel(ctx);
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;

    const streamEvent = event.assistantMessageEvent;
    if (streamEvent.type !== "text_delta" && streamEvent.type !== "thinking_delta") return;
    if (!streamEvent.delta) return;

    const now = Date.now();
    if (contentStreamStart === null) {
      contentStreamStart = now;
      firstContentDeltaCharacters = streamEvent.delta.length;
    }
    lastContentDeltaAt = now;
    contentCharacters += streamEvent.delta.length;
    contentDeltaCount += 1;

    const elapsedMs = now - contentStreamStart;
    const streamedCharacters = contentCharacters - firstContentDeltaCharacters;
    if (contentDeltaCount < 2 || elapsedMs <= 0 || streamedCharacters <= 0 || now - lastLiveUpdate < LIVE_UPDATE_INTERVAL_MS) {
      return;
    }
    lastLiveUpdate = now;
    modelState = {
      ...modelState,
      tokensPerSecond: estimateContentTokens(streamedCharacters) / (elapsedMs / 1000),
    };
    requestRender?.();
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;

    if (contentStreamStart !== null && contentCharacters > 0) {
      const streamEnd = lastContentDeltaAt ?? contentStreamStart;
      const streamMs = streamEnd - contentStreamStart;
      const estimatedFirstDeltaTokens = estimateContentTokens(firstContentDeltaCharacters);
      const streamedTokens = Math.max(0, numberValue(event.message.usage?.output) - estimatedFirstDeltaTokens);

      if (contentDeltaCount >= 2 && streamMs >= 50 && streamedTokens > 0) {
        runContentTokens += streamedTokens;
        runContentStreamMs += streamMs;
        modelState = {
          ...modelState,
          tokensPerSecond: runContentTokens / (runContentStreamMs / 1000),
        };
      }
    }

    resetMessageTracking();
    refreshModel(ctx);
  });

  pi.on("tool_execution_end", (_event, ctx) => {
    void refreshJj(ctx, true);
  });

  pi.on("turn_end", (_event, ctx) => refreshModel(ctx));

  pi.on("agent_settled", (_event, ctx) => {
    modelState = { ...modelState, generating: false };
    refreshModel(ctx);
    void refreshJj(ctx, true);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    uninstall(ctx);
  });

  pi.registerCommand("dashboard", {
    description: "Toggle or refresh the custom pi dashboard UI: /dashboard [on|off|refresh]",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();

      if (action === "off") {
        enabled = false;
        uninstall(ctx);
        ctx.ui.notify("Dashboard disabled", "info");
        return;
      }

      if (action === "on" || action === "") {
        enabled = true;
        title = formatDirectory(ctx.cwd);
        refreshModel(ctx);
        install(ctx);
        await refreshJj(ctx, true);
        ctx.ui.notify("Dashboard enabled", "info");
        return;
      }

      if (action === "refresh") {
        refreshModel(ctx);
        await refreshJj(ctx, true);
        ctx.ui.notify("Dashboard refreshed", "info");
        return;
      }

      ctx.ui.notify("Usage: /dashboard [on|off|refresh]", "warning");
    },
  });

  pi.registerCommand("github-theme", {
    description: "Switch to the bundled github-dark-default theme",
    handler: async (_args, ctx) => {
      const result = ctx.ui.setTheme("github-dark-default");
      if (result.success) ctx.ui.notify("Theme set to github-dark-default", "success");
      else ctx.ui.notify(`Could not set theme: ${result.error}`, "error");
    },
  });
}
