import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { formatSize, truncateHead, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";

const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const STDERR_TAIL_LIMIT = 20_000;

type JsonRpcId = number | string;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonObject = Record<string, unknown>;

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  cleanupAbort?: () => void;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
}

interface McpListToolsResult {
  tools?: McpTool[];
  nextCursor?: string;
}

interface McpToolResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

interface LoadToolsResult {
  toolCount: number;
  alreadyLoaded: boolean;
}

export interface McpBridgeConfig {
  /** Human-readable server name, for example "Linear". */
  serverName: string;
  /** Prefix for pi tool names. MCP tool `search` becomes `${toolPrefix}_search`. */
  toolPrefix: string;
  /** Command that starts an MCP stdio server, for example `mcp-remote` or `npx`. */
  command: string;
  /** Arguments for `command`, for example `["https://..."]` or `["-y", "mcp-remote", "https://..."]`. */
  args?: string[];
  /** Extra environment variables for the MCP server process. */
  env?: Record<string, string | undefined>;
  /** Working directory for the MCP server process. Defaults to pi's cwd. */
  cwd?: string;
  /** MCP initialize protocol version. */
  protocolVersion?: string;
  /** Timeout for initial connect/list-tools. */
  startupTimeoutMs?: number;
  /** Timeout for normal MCP requests/tool calls. */
  requestTimeoutMs?: number;
  /** Connect and list MCP tools at session start instead of waiting for the loader tool or reload command. Defaults to false. */
  loadOnSessionStart?: boolean;
  /** Extra tool-specific guidelines added while the MCP tools are active. */
  promptGuidelines?: string[];
}

type ResolvedMcpBridgeConfig = Required<Omit<McpBridgeConfig, "env" | "cwd" | "promptGuidelines" | "loadOnSessionStart">> &
  Pick<McpBridgeConfig, "env" | "cwd"> & { promptGuidelines: string[]; loadOnSessionStart: boolean };

class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private stdoutBuffer = "";
  private stderrTail = "";
  private closed = false;

  constructor(private readonly config: ResolvedMcpBridgeConfig) {}

  isRunning(): boolean {
    return this.child !== undefined && !this.closed && this.child.exitCode === null;
  }

  diagnostics(): string {
    return this.stderrTail.trim();
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;

    const command = resolveExecutable(this.config.command);
    if (!command) {
      throw new Error(
        `${this.config.serverName} MCP command not found: ${this.config.command}. Install it or make sure pi's PATH includes it.`,
      );
    }

    this.closed = false;
    this.child = spawn(command, this.config.args, {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: "pipe",
      windowsHide: true,
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");

    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => this.appendStderr(chunk));
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.rejectAll(new Error(`${this.config.serverName} MCP process exited (code ${code ?? "null"}, signal ${signal ?? "null"})`));
    });

    await this.request(
      "initialize",
      {
        protocolVersion: this.config.protocolVersion,
        capabilities: {},
        clientInfo: { name: "pi-mcp-bridge", version: "0.1.0" },
      },
      undefined,
      this.config.startupTimeoutMs,
    );

    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;

    do {
      const result = (await this.request(
        "tools/list",
        cursor ? { cursor } : {},
        undefined,
        this.config.startupTimeoutMs,
      )) as McpListToolsResult;
      tools.push(...(Array.isArray(result.tools) ? result.tools : []));
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    } while (cursor);

    return tools;
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpToolResult> {
    return (await this.request(
      "tools/call",
      { name, arguments: isJsonObject(args) ? args : {} },
      signal,
      this.config.requestTimeoutMs,
    )) as McpToolResult;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error(`${this.config.serverName} MCP client closed`));

    if (!this.child) return;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    setTimeout(() => {
      if (this.child && this.child.exitCode === null) this.child.kill("SIGKILL");
    }, 1_000).unref?.();
  }

  private request(method: string, params: JsonObject, signal?: AbortSignal, timeoutMs = this.config.requestTimeoutMs): Promise<unknown> {
    if (!this.child || this.closed) {
      return Promise.reject(new Error(`${this.config.serverName} MCP process is not running`));
    }

    if (signal?.aborted) {
      return Promise.reject(new Error(`${this.config.serverName} MCP request cancelled: ${method}`));
    }

    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        pending.cleanupAbort?.();
        this.pending.delete(id);
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`${this.config.serverName} MCP request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);

      const onAbort = () => {
        cleanup();
        reject(new Error(`${this.config.serverName} MCP request cancelled: ${method}`));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, {
        method,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timeout,
        cleanupAbort: signal ? () => signal.removeEventListener("abort", onAbort) : undefined,
      });

      try {
        this.child!.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: JsonObject): void {
    if (!this.child || this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) return;

      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;

      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.appendStderr(`\n[non-JSON MCP stdout] ${line}\n`);
        continue;
      }

      this.handleMessage(message);
    }
  }

  private handleMessage(message: unknown): void {
    if (!isJsonObject(message) || !("id" in message)) return;

    const id = message.id as JsonRpcId;
    const pending = this.pending.get(id);
    if (!pending) return;

    if ("error" in message) {
      pending.reject(formatJsonRpcError(this.config.serverName, pending.method, message.error));
      return;
    }

    pending.resolve((message as { result?: unknown }).result);
  }

  private appendStderr(chunk: string): void {
    this.stderrTail += chunk;
    if (this.stderrTail.length > STDERR_TAIL_LIMIT) {
      this.stderrTail = this.stderrTail.slice(this.stderrTail.length - STDERR_TAIL_LIMIT);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of [...this.pending.values()]) {
      pending.reject(error);
    }
  }
}

export function mcpRemoteCommand(url: string): Pick<McpBridgeConfig, "command" | "args"> {
  if (process.platform === "linux") {
    return { command: "mcp-remote", args: [url] };
  }

  return { command: "npx", args: ["-y", "mcp-remote", url] };
}

export function registerMcpBridge(pi: ExtensionAPI, config: McpBridgeConfig): void {
  const resolvedConfig = resolveConfig(config);
  const loaderToolName = sanitizeSegment(`${resolvedConfig.toolPrefix}_mcp_load`);
  const toolNameByMcpName = new Map<string, string>();
  const reservedToolNames = new Set([loaderToolName]);
  let client: McpStdioClient | undefined;
  let connectPromise: Promise<McpStdioClient> | undefined;
  let loadPromise: Promise<LoadToolsResult> | undefined;
  let loadGeneration = 0;
  let toolsLoaded = false;
  let loadedToolCount = 0;
  let disposed = false;

  const statusKey = `${resolvedConfig.toolPrefix}-mcp`;
  const commandPrefix = resolvedConfig.toolPrefix.replace(/_/g, "-");

  async function getClient(): Promise<McpStdioClient> {
    if (client?.isRunning()) return client;
    if (connectPromise) return connectPromise;

    const nextClient = new McpStdioClient(resolvedConfig);
    connectPromise = nextClient
      .start()
      .then(() => {
        client = nextClient;
        return nextClient;
      })
      .catch((error) => {
        nextClient.close();
        throw withDiagnostics(error, nextClient.diagnostics());
      })
      .finally(() => {
        connectPromise = undefined;
      });

    return connectPromise;
  }

  async function ensureToolsLoaded(ctx: ExtensionContext, reason: "startup" | "manual" | "tool"): Promise<LoadToolsResult> {
    if (toolsLoaded) return { toolCount: loadedToolCount, alreadyLoaded: true };
    if (loadPromise) return loadPromise;

    let nextLoad: Promise<LoadToolsResult>;
    nextLoad = loadTools(ctx, reason).finally(() => {
      if (loadPromise === nextLoad) loadPromise = undefined;
    });
    loadPromise = nextLoad;
    return nextLoad;
  }

  async function loadTools(ctx: ExtensionContext, reason: "startup" | "manual" | "tool"): Promise<LoadToolsResult> {
    const generation = ++loadGeneration;
    if (ctx.hasUI) ctx.ui.setStatus(statusKey, `${resolvedConfig.serverName} MCP: connecting`);

    try {
      const mcp = await getClient();
      if (disposed || generation !== loadGeneration) return { toolCount: loadedToolCount, alreadyLoaded: toolsLoaded };

      if (ctx.hasUI) ctx.ui.setStatus(statusKey, `${resolvedConfig.serverName} MCP: loading tools`);
      const tools = await mcp.listTools();
      if (disposed || generation !== loadGeneration) return { toolCount: loadedToolCount, alreadyLoaded: toolsLoaded };

      for (const tool of tools) {
        registerMcpTool(pi, resolvedConfig, getClient, tool, toolNameByMcpName, reservedToolNames);
      }

      toolsLoaded = true;
      loadedToolCount = tools.length;

      if (ctx.hasUI && reason !== "tool") {
        ctx.ui.notify(
          `${resolvedConfig.serverName} MCP ${reason === "manual" ? "reloaded" : "loaded"}: ${tools.length} tool(s)`,
          "info",
        );
      }

      return { toolCount: tools.length, alreadyLoaded: false };
    } catch (error) {
      if (ctx.hasUI && reason !== "tool") ctx.ui.notify(formatUnknownError(`${resolvedConfig.serverName} MCP failed`, error), "error");
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      if (ctx.hasUI) ctx.ui.setStatus(statusKey, undefined);
    }
  }

  registerMcpLoaderTool(pi, resolvedConfig, loaderToolName, (ctx) => ensureToolsLoaded(ctx, "tool"));

  pi.on("session_start", (_event, ctx) => {
    disposed = false;
    if (resolvedConfig.loadOnSessionStart) {
      void ensureToolsLoaded(ctx, "startup").catch(() => undefined);
    }
  });

  pi.on("session_shutdown", async () => {
    disposed = true;
    loadGeneration++;
    client?.close();
    client = undefined;
    connectPromise = undefined;
    loadPromise = undefined;
  });

  pi.registerCommand(`${commandPrefix}-mcp-reload`, {
    description: `Reconnect to ${resolvedConfig.serverName} MCP and refresh tools`,
    handler: async (_args, ctx) => {
      loadGeneration++;
      client?.close();
      client = undefined;
      connectPromise = undefined;
      loadPromise = undefined;
      toolsLoaded = false;
      loadedToolCount = 0;
      await ensureToolsLoaded(ctx, "manual");
    },
  });

  pi.registerCommand(`${commandPrefix}-mcp-status`, {
    description: `Show ${resolvedConfig.serverName} MCP bridge status`,
    handler: async (_args, ctx) => {
      const diagnostics = client?.diagnostics();
      const state = client?.isRunning() ? "connected" : toolsLoaded ? "tools registered (not connected)" : "not loaded";
      const lines = [
        `${resolvedConfig.serverName} MCP: ${state}`,
        `Loader tool: ${loaderToolName}`,
        `Registered MCP tools: ${toolNameByMcpName.size}`,
      ];
      if (!toolsLoaded) lines.push(`Use ${loaderToolName} or /${commandPrefix}-mcp-reload to load on demand.`);
      if (diagnostics) lines.push("", "Recent MCP stderr:", diagnostics);
      ctx.ui.notify(lines.join("\n"), client?.isRunning() || toolsLoaded ? "info" : "warning");
    },
  });

  pi.on("before_agent_start", (event) => {
    if (toolNameByMcpName.size === 0 || resolvedConfig.promptGuidelines.length === 0) return;

    const guidance = resolvedConfig.promptGuidelines.map((line) => `- ${line}`).join("\n");
    return {
      systemPrompt: `${event.systemPrompt}\n\n${resolvedConfig.serverName} MCP guidance:\n${guidance}`,
    };
  });
}

function registerMcpLoaderTool(
  pi: ExtensionAPI,
  config: ResolvedMcpBridgeConfig,
  loaderToolName: string,
  loadTools: (ctx: ExtensionContext) => Promise<LoadToolsResult>,
): void {
  pi.registerTool({
    name: loaderToolName,
    label: `${config.serverName}: load MCP tools`,
    description: [
      `Load and register ${config.serverName} MCP tools on demand.`,
      `Use this first when the user asks for ${config.serverName} data or actions and the specific ${config.toolPrefix}_* MCP tools are not available yet.`,
      `The ${config.serverName} MCP server is not started until this tool runs.`,
    ].join(" "),
    promptSnippet: `Load ${config.serverName} MCP tools on demand before calling ${config.toolPrefix}_* tools`,
    promptGuidelines: [
      `Use ${loaderToolName} first when the user asks for ${config.serverName} data or actions and the specific ${config.toolPrefix}_* MCP tools are not available yet.`,
      `After ${loaderToolName} returns, continue the task with the newly available ${config.toolPrefix}_* tools.`,
    ],
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId, _params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error(`${config.serverName} MCP load cancelled`);

      onUpdate?.({
        content: [{ type: "text", text: `Loading ${config.serverName} MCP tools...` }],
        details: { server: config.serverName, pending: true },
      });

      const result = await loadTools(ctx);
      if (signal?.aborted) throw new Error(`${config.serverName} MCP load cancelled`);

      const guidance = config.promptGuidelines.length
        ? `\n\n${config.serverName} MCP guidance:\n${config.promptGuidelines.map((line) => `- ${line}`).join("\n")}`
        : "";
      const state = result.alreadyLoaded ? "already loaded" : "loaded";

      return {
        content: [
          {
            type: "text",
            text: `${config.serverName} MCP ${state}: ${result.toolCount} tool(s) available. Use the ${config.toolPrefix}_* tools now to complete the request.${guidance}`,
          },
        ],
        details: { server: config.serverName, loaderTool: loaderToolName, toolCount: result.toolCount, alreadyLoaded: result.alreadyLoaded },
      };
    },
  });
}

function registerMcpTool(
  pi: ExtensionAPI,
  config: ResolvedMcpBridgeConfig,
  getClient: () => Promise<McpStdioClient>,
  tool: McpTool,
  toolNameByMcpName: Map<string, string>,
  reservedToolNames: Set<string>,
): void {
  if (!tool?.name) return;

  const piToolName = getPiToolName(config.toolPrefix, tool.name, toolNameByMcpName, reservedToolNames);
  const description = [
    tool.description?.trim() || `${config.serverName} MCP tool ${tool.name}`,
    `\nOriginal MCP tool name: ${tool.name}`,
  ].join("\n");

  pi.registerTool({
    name: piToolName,
    label: `${config.serverName}: ${tool.name}`,
    description,
    promptSnippet: `${config.serverName} MCP tool: ${tool.description?.trim() || tool.name}`,
    parameters: Type.Unsafe<Record<string, unknown>>(normalizeInputSchema(tool.inputSchema)),
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({
        content: [{ type: "text", text: `Calling ${config.serverName} MCP tool ${tool.name}...` }],
        details: { server: config.serverName, tool: tool.name, pending: true },
      });

      const mcp = await getClient();
      const result = await mcp.callTool(tool.name, params, signal);
      const content = mcpResultToPiContent(result);

      if (result.isError) {
        throw new Error(extractText(content) || `${config.serverName} MCP tool ${tool.name} returned an error`);
      }

      return {
        content,
        details: { server: config.serverName, tool: tool.name, result },
      };
    },
  });
}

function resolveConfig(config: McpBridgeConfig): ResolvedMcpBridgeConfig {
  return {
    serverName: config.serverName,
    toolPrefix: sanitizeSegment(config.toolPrefix || config.serverName),
    command: config.command,
    args: config.args ?? [],
    env: config.env,
    cwd: config.cwd,
    protocolVersion: config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
    startupTimeoutMs: config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    loadOnSessionStart: config.loadOnSessionStart ?? false,
    promptGuidelines: config.promptGuidelines ?? [
      `Use ${sanitizeSegment(config.toolPrefix || config.serverName)}_* tools when the user asks for data or actions from ${config.serverName}.`,
    ],
  };
}

function normalizeInputSchema(schema: unknown): JsonObject {
  if (!isJsonObject(schema)) {
    return { type: "object", properties: {}, additionalProperties: false };
  }

  return schema;
}

function getPiToolName(prefix: string, mcpName: string, toolNameByMcpName: Map<string, string>, reservedToolNames: Set<string>): string {
  const existing = toolNameByMcpName.get(mcpName);
  if (existing) return existing;

  const used = new Set([...toolNameByMcpName.values(), ...reservedToolNames]);
  const base = sanitizeSegment(`${prefix}_${mcpName}`);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}_${suffix++}`;

  toolNameByMcpName.set(mcpName, candidate);
  return candidate;
}

function sanitizeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toLowerCase();

  if (!sanitized) return "mcp";
  if (/^[0-9]/.test(sanitized)) return `mcp_${sanitized}`;
  return sanitized;
}

function mcpResultToPiContent(result: McpToolResult): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  const out: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  const textParts: string[] = [];

  const flushText = () => {
    if (textParts.length === 0) return;
    out.push({ type: "text", text: truncateText(textParts.join("\n\n")) });
    textParts.length = 0;
  };

  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (!isJsonObject(item)) {
      textParts.push(stringify(item));
      continue;
    }

    if (item.type === "text" && typeof item.text === "string") {
      textParts.push(item.text);
      continue;
    }

    if (item.type === "image" && typeof item.data === "string") {
      flushText();
      out.push({ type: "image", data: item.data, mimeType: typeof item.mimeType === "string" ? item.mimeType : "image/png" });
      continue;
    }

    textParts.push(stringify(item));
  }

  flushText();

  if (out.length === 0) {
    out.push({ type: "text", text: truncateText(stringify(result.structuredContent ?? result)) });
  }

  return out;
}

function truncateText(text: string): string {
  const truncation = truncateHead(text);
  if (!truncation.truncated) return truncation.content;

  return `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
    truncation.outputBytes,
  )} of ${formatSize(truncation.totalBytes)}).]`;
}

function extractText(content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>): string {
  return content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n\n")
    .trim();
}

function formatJsonRpcError(serverName: string, method: string, error: unknown): Error {
  if (isJsonRpcError(error)) {
    const details = error.data === undefined ? "" : `\n${stringify(error.data)}`;
    return new Error(`${serverName} MCP ${method} failed (${error.code}): ${error.message}${details}`);
  }
  return new Error(`${serverName} MCP ${method} failed: ${stringify(error)}`);
}

function isJsonRpcError(error: unknown): error is JsonRpcError {
  return isJsonObject(error) && typeof error.code === "number" && typeof error.message === "string";
}

function withDiagnostics(error: unknown, diagnostics: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(diagnostics ? `${message}\n\nRecent MCP stderr:\n${diagnostics}` : message);
}

function formatUnknownError(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value as JsonValue, null, 2);
  } catch {
    return String(value);
  }
}

function resolveExecutable(command: string): string | undefined {
  if (command.includes("/") || isAbsolute(command)) return isExecutable(command) ? command : undefined;

  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const nixProfileDirs = [
    process.env.HOME ? join(process.env.HOME, ".nix-profile", "bin") : undefined,
    process.env.HOME ? join(process.env.HOME, ".local", "state", "nix", "profiles", "profile", "bin") : undefined,
    process.env.USER ? join("/etc", "profiles", "per-user", process.env.USER, "bin") : undefined,
    "/run/current-system/sw/bin",
    "/nix/var/nix/profiles/default/bin",
  ].filter((dir): dir is string => typeof dir === "string");

  for (const dir of [...pathDirs, ...nixProfileDirs]) {
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }

  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
