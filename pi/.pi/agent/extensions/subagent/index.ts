import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum, Type } from "@mariozechner/pi-ai";
import {
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
  AgentDashboard,
  type AgentDashboardData,
  hideAgentDashboard,
  renderAgentDashboardDetails,
  showAgentDashboard,
} from "../shared/agent-dashboard";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "./agents";
import {
  createUserQuestionBridge,
  parseUserQuestion,
  removeUserQuestionBridge,
  surfaceUserQuestion,
  USER_QUESTION_TOOL_NAME,
  type UserQuestionBridge,
  type UserQuestionHandler,
  type UserQuestionResponse,
  writeUserQuestionResponse,
} from "./user-question";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const STDERR_TAIL_LIMIT = 20_000;

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface AgentRunResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  cwd: string;
  exitCode: number;
  started?: boolean;
  finalOutput: string;
  liveOutput?: string;
  transcript?: string;
  progressMessage?: string;
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

interface AgentProcessEvent {
  type?: string;
  message?: Message;
  messages?: Message[];
  assistantMessageEvent?: { delta?: unknown };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
}

interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  userAgentsDir: string;
  projectAgentsDir: string | null;
  results: AgentRunResult[];
}

interface AgentListDetails {
  userAgentsDir: string;
  projectAgentsDir: string | null;
  agents: Array<Omit<AgentConfig, "systemPrompt">>;
}

type TextContent = { type: "text"; text: string };
type ToolUpdate = { content: TextContent[]; details: SubagentDetails };
type OnUpdateCallback = (partial: ToolUpdate) => void;

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description: 'Which agent directories to use. Default: "user" loads ~/.pi/agent/agents. Use "project" or "both" only for trusted repos.',
  default: "user",
});

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for this agent process. Relative paths resolve from pi's cwd." })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task for this step. Use {previous} to include the prior step's output." }),
  cwd: Type.Optional(Type.String({ description: "Working directory for this agent process. Relative paths resolve from pi's cwd." })),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke for single-agent mode" })),
  task: Type.Optional(Type.String({ description: "Task to delegate for single-agent mode" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks. Each entry is { agent, task, cwd? }." })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential steps. Each entry is { agent, task, cwd? }." })),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory for the single-agent process. Relative paths resolve from pi's cwd." })),
  includeExtensions: Type.Optional(
    Type.Boolean({
      description:
        "Load configured extensions inside subagent subprocesses. If omitted, uses the agent's includeExtensions frontmatter value, otherwise false.",
    }),
  ),
});

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function appendStderrTail(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= STDERR_TAIL_LIMIT) return next;
  return next.slice(next.length - STDERR_TAIL_LIMIT);
}

function truncateText(text: string, maxBytes = 50 * 1024, maxLines = 2_000): string {
  const truncation = truncateHead(text, { maxBytes, maxLines });
  if (!truncation.truncated) return truncation.content;

  return `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
    truncation.outputBytes,
  )} of ${formatSize(truncation.totalBytes)}).]`;
}

function messageText(message: Message): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .filter((part): part is TextContent => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

function finalAssistantOutput(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;

    const text = messageText(message);
    if (text) return text;
  }

  return "";
}

function updateUsageFromMessage(result: AgentRunResult, message: Message): void {
  if (message.role !== "assistant") return;

  result.usage.turns++;

  const usage = message.usage;
  if (usage) {
    result.usage.input += usage.input || 0;
    result.usage.output += usage.output || 0;
    result.usage.cacheRead += usage.cacheRead || 0;
    result.usage.cacheWrite += usage.cacheWrite || 0;
    result.usage.cost += usage.cost?.total || 0;
    result.usage.contextTokens = usage.totalTokens || 0;
  }

  if (!result.model && message.model) result.model = message.model;
  if (message.stopReason) result.stopReason = message.stopReason;
  if (message.errorMessage) result.errorMessage = message.errorMessage;
}

function isAgentErrored(result: AgentRunResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function summarizeFailure(result: AgentRunResult): string {
  return result.errorMessage || result.stderr.trim() || result.finalOutput || `pi exited with code ${result.exitCode}`;
}

function appendTranscript(result: AgentRunResult, text: string): void {
  const next = [result.transcript?.trimEnd(), text.trim()].filter(Boolean).join("\n\n");
  result.transcript = next.length <= 24_000 ? next : `... earlier activity omitted ...\n\n${next.slice(-23_960)}`;
}

function formatActivityArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";

  const record = args as Record<string, unknown>;
  for (const key of ["path", "pattern", "query", "command", "glob"]) {
    const value = record[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const compact = value.replace(/\s+/g, " ").trim();
    return ` ${compact.length > 100 ? `${compact.slice(0, 97)}...` : compact}`;
  }
  return "";
}

function dashboardOutput(result: AgentRunResult): string {
  const settledOutput = result.transcript?.trim() || result.finalOutput.trim();
  const liveOutput = result.liveOutput?.trim();
  const stderr = isAgentErrored(result) ? summarizeFailure(result) : "";
  return [settledOutput, liveOutput, stderr && !settledOutput.includes(stderr) ? stderr : ""].filter(Boolean).join("\n\n");
}

function subagentDashboardData(details: SubagentDetails): AgentDashboardData {
  return {
    path: details.mode,
    agents: details.results.map((result, index) => ({
      id: result.step ? `step-${result.step}` : `sa-${index + 1}`,
      title: result.agent,
      agent: "pi",
      model: result.model,
      status:
        result.exitCode === -1
          ? result.started === false
            ? "pending"
            : "running"
          : isAgentErrored(result)
            ? "failed"
            : "done",
      output: dashboardOutput(result),
      progress:
        result.progressMessage ??
        (result.exitCode === -1 ? result.task : isAgentErrored(result) ? "Subagent failed." : "Subagent finished."),
      exitCode: result.exitCode === -1 ? undefined : result.exitCode,
    })),
  };
}

function formatUsage(usage: UsageStats, model: string | undefined): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.input) parts.push(`input ${usage.input}`);
  if (usage.output) parts.push(`output ${usage.output}`);
  if (usage.cacheRead) parts.push(`cache read ${usage.cacheRead}`);
  if (usage.cacheWrite) parts.push(`cache write ${usage.cacheWrite}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens) parts.push(`ctx ${usage.contextTokens}`);
  if (model) parts.push(model);
  return parts.join(", ");
}

function formatResultSummary(result: AgentRunResult): string {
  const status = isAgentErrored(result) ? "failed" : "completed";
  const output = result.finalOutput || (isAgentErrored(result) ? summarizeFailure(result) : "(no output)");
  const usage = formatUsage(result.usage, result.model);
  const usageLine = usage ? `\nUsage: ${usage}` : "";
  return `Agent ${result.agent} ${status}.\n\n${truncateText(output)}${usageLine}`;
}

function resolveCwd(defaultCwd: string, cwd: string | undefined): string {
  if (!cwd?.trim()) return defaultCwd;

  const normalized = cwd.trim().replace(/^@/, "");
  return path.isAbsolute(normalized) ? normalized : path.resolve(defaultCwd, normalized);
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;

  const workers = new Array(limit).fill(undefined).map(async () => {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await fn(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^A-Za-z0-9_.-]+/g, "_");
  const filePath = path.join(dir, `prompt-${safeName}.md`);

  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  });

  return { dir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");

  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };

  return { command: "pi", args };
}

async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  includeExtensions: boolean,
  userQuestionHandler: UserQuestionHandler,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: AgentRunResult[]) => SubagentDetails,
): Promise<AgentRunResult> {
  const agent = agents.find((candidate) => candidate.name === agentName);
  const resolvedCwd = resolveCwd(defaultCwd, cwd);

  if (!agent) {
    const available = agents.map((candidate) => candidate.name).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      cwd: resolvedCwd,
      exitCode: 1,
      finalOutput: "",
      stderr: `Unknown agent "${agentName}". Available agents: ${available}.`,
      usage: emptyUsage(),
      step,
    };
  }

  const args = ["--mode", "json", "-p", "--no-session"];
  if (!includeExtensions) args.push("--no-extensions");
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

  let promptDir: string | undefined;
  let userQuestionBridge: UserQuestionBridge | undefined;
  const messages: Message[] = [];
  const result: AgentRunResult = {
    agent: agent.name,
    agentSource: agent.source,
    task,
    cwd: resolvedCwd,
    exitCode: -1,
    started: true,
    finalOutput: "",
    progressMessage: `${agent.name} is starting...`,
    stderr: "",
    usage: emptyUsage(),
    model: agent.model,
    step,
  };

  let lastLiveUpdateAt = 0;
  const emitUpdate = (force = false) => {
    const now = Date.now();
    if (!force && now - lastLiveUpdateAt < 50) return;
    lastLiveUpdateAt = now;
    const output = dashboardOutput(result);
    onUpdate?.({
      content: [{ type: "text", text: output ? truncateText(output, 12 * 1024, 400) : `${agent.name} is running...` }],
      details: makeDetails([result]),
    });
  };

  try {
    if (agent.tools?.includes(USER_QUESTION_TOOL_NAME)) {
      userQuestionBridge = await createUserQuestionBridge();
      args.push("--extension", userQuestionBridge.extensionPath);
    }

    if (agent.systemPrompt.trim()) {
      const prompt = await writePromptToTempFile(agent.name, agent.systemPrompt);
      promptDir = prompt.dir;
      args.push("--append-system-prompt", prompt.filePath);
    }

    args.push(`Task: ${task}`);

    let stdoutBuffer = "";
    let wasAborted = false;
    let abortCleanup: (() => void) | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingQuestionWork = Promise.resolve();
    const questionAbortController = new AbortController();
    const forwardQuestionAbort = () => questionAbortController.abort();
    if (signal?.aborted) questionAbortController.abort();
    else signal?.addEventListener("abort", forwardQuestionAbort, { once: true });

    result.exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: resolvedCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          PI_SUBAGENT: "1",
          PI_SUBAGENT_NAME: agent.name,
          ...(userQuestionBridge ? { PI_USER_QUESTION_BRIDGE_DIR: userQuestionBridge.dir } : {}),
        },
      });

      const enqueueUserQuestion = (event: AgentProcessEvent) => {
        if (!userQuestionBridge || event.toolName !== USER_QUESTION_TOOL_NAME || !event.toolCallId) return;

        const bridge = userQuestionBridge;
        const request = parseUserQuestion(event.toolCallId, event.args, agent.name);
        pendingQuestionWork = pendingQuestionWork
          .then(async () => {
            let response: UserQuestionResponse;
            try {
              response = await userQuestionHandler(request, questionAbortController.signal);
            } catch (error) {
              response = { status: "error", message: `Could not ask the user: ${error instanceof Error ? error.message : String(error)}` };
            }

            await writeUserQuestionResponse(bridge.dir, request.toolCallId, response);
          })
          .catch((error) => {
            result.stderr = appendStderrTail(
              result.stderr,
              `Question bridge failed: ${error instanceof Error ? error.message : String(error)}\n`,
            );
            proc.kill("SIGTERM");
          });
      };

      const processLine = (line: string) => {
        if (!line.trim()) return;

        let event: AgentProcessEvent;
        try {
          event = JSON.parse(line) as AgentProcessEvent;
        } catch {
          return;
        }

        if (event.type === "agent_start") {
          result.progressMessage = `${agent.name} started.`;
          emitUpdate(true);
          return;
        }

        if (event.type === "turn_start") {
          result.progressMessage = `${agent.name} is thinking...`;
          emitUpdate(true);
          return;
        }

        if (event.type === "message_update" && event.message?.role === "assistant") {
          const fullText = messageText(event.message);
          const delta = typeof event.assistantMessageEvent?.delta === "string" ? event.assistantMessageEvent.delta : "";
          result.liveOutput = fullText || `${result.liveOutput ?? ""}${delta}`;
          result.progressMessage = `${agent.name} is writing...`;
          emitUpdate();
          return;
        }

        if (event.type === "tool_execution_start") {
          enqueueUserQuestion(event);
          const activity = `→ ${event.toolName ?? "tool"}${formatActivityArgs(event.args)}`;
          appendTranscript(result, activity);
          result.liveOutput = "";
          result.progressMessage = `${agent.name} is running ${event.toolName ?? "a tool"}...`;
          emitUpdate(true);
          return;
        }

        if (event.type === "tool_execution_end") {
          result.progressMessage = `${agent.name} ${event.isError ? "failed" : "finished"} ${event.toolName ?? "tool"}.`;
          emitUpdate(true);
          return;
        }

        if (event.type === "message_end" && event.message) {
          const message = event.message as Message;
          messages.push(message);
          updateUsageFromMessage(result, message);
          result.finalOutput = finalAssistantOutput(messages);
          const text = messageText(message);
          if (message.role === "assistant" && text) appendTranscript(result, text);
          result.liveOutput = "";
          result.progressMessage = text ? `${agent.name} produced output.` : `${agent.name} completed a message.`;
          emitUpdate(true);
          return;
        }

        if (event.type === "agent_end" && messages.length === 0 && Array.isArray(event.messages)) {
          for (const message of event.messages as Message[]) {
            messages.push(message);
            updateUsageFromMessage(result, message);
            const text = messageText(message);
            if (message.role === "assistant" && text) appendTranscript(result, text);
          }
          result.finalOutput = finalAssistantOutput(messages);
          result.liveOutput = "";
          result.progressMessage = `${agent.name} finished.`;
          emitUpdate(true);
        }
      };

      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");

      proc.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (chunk: string) => {
        result.stderr = appendStderrTail(result.stderr, chunk);
      });

      proc.on("error", (error) => {
        result.stderr = appendStderrTail(result.stderr, `${error.message}\n`);
        resolve(1);
      });

      proc.on("close", (code) => {
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        if (killTimer) clearTimeout(killTimer);
        abortCleanup?.();
        questionAbortController.abort();
        signal?.removeEventListener("abort", forwardQuestionAbort);
        resolve(code ?? 0);
      });

      const killProcess = () => {
        wasAborted = true;
        proc.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (proc.exitCode === null) proc.kill("SIGKILL");
        }, 5_000);
        killTimer.unref?.();
      };

      if (signal?.aborted) {
        killProcess();
      } else if (signal) {
        signal.addEventListener("abort", killProcess, { once: true });
        abortCleanup = () => signal.removeEventListener("abort", killProcess);
      }
    });

    await pendingQuestionWork;

    if (wasAborted) {
      result.stopReason = "aborted";
      result.errorMessage = "Subagent was aborted.";
      result.progressMessage = `${agent.name} was aborted.`;
    } else {
      result.progressMessage = isAgentErrored(result) ? `${agent.name} failed.` : `${agent.name} finished.`;
    }
    emitUpdate(true);

    return result;
  } finally {
    if (promptDir) {
      try {
        fs.rmSync(promptDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures.
      }
    }

    try {
      await removeUserQuestionBridge(userQuestionBridge);
    } catch {
      // Ignore cleanup failures.
    }
  }
}

function requestedAgentNames(params: { agent?: string; tasks?: Array<{ agent: string }>; chain?: Array<{ agent: string }> }): Set<string> {
  const names = new Set<string>();
  if (params.agent) names.add(params.agent);
  for (const task of params.tasks ?? []) names.add(task.agent);
  for (const step of params.chain ?? []) names.add(step.agent);
  return names;
}

function shouldIncludeExtensions(agents: AgentConfig[], agentName: string, override: boolean | undefined): boolean {
  if (override !== undefined) return override;
  return agents.find((agent) => agent.name === agentName)?.includeExtensions ?? false;
}

function publicAgent(agent: AgentConfig): Omit<AgentConfig, "systemPrompt"> {
  const { systemPrompt: _systemPrompt, ...publicFields } = agent;
  return publicFields;
}

function formatAgentsForTool(scope: AgentScope, cwd: string): { text: string; details: AgentListDetails } {
  const discovery = discoverAgents(cwd, scope);
  const lines = [
    `Agent scope: ${scope}`,
    `User agents: ${discovery.userAgentsDir}`,
    `Project agents: ${discovery.projectAgentsDir ?? "none discovered from cwd"}`,
    "",
    formatAgentList(discovery.agents),
  ];

  return {
    text: lines.join("\n"),
    details: {
      userAgentsDir: discovery.userAgentsDir,
      projectAgentsDir: discovery.projectAgentsDir,
      agents: discovery.agents.map(publicAgent),
    },
  };
}

export default function (pi: ExtensionAPI) {
  let activeSubagentDashboard: AgentDashboard | undefined;

  const startSubagentDashboard = (ctx: ExtensionContext, details: SubagentDetails) => {
    activeSubagentDashboard?.close();
    const dashboard = new AgentDashboard(details.mode);
    activeSubagentDashboard = dashboard;
    dashboard.update(subagentDashboardData(details));
    showAgentDashboard(ctx, dashboard);
    return dashboard;
  };

  pi.registerTool({
    name: "agent_list",
    label: "List Agents",
    description: "List pi agents discovered from ~/.pi/agent/agents and optionally trusted project .pi/agents directories.",
    promptSnippet: "List available pi agents before delegating with subagent.",
    promptGuidelines: [
      "Use agent_list when the user asks what agents are available or when you need to choose an agent before calling subagent.",
    ],
    parameters: Type.Object({
      agentScope: Type.Optional(AgentScopeSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope: AgentScope = params.agentScope ?? "user";
      const { text, details } = formatAgentsForTool(scope, ctx.cwd);
      return {
        content: [{ type: "text", text }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Spawn specialized pi agents with isolated context windows.",
      "Use single mode with agent + task, parallel mode with tasks, or chain mode with sequential steps and {previous} placeholders.",
      'Default agentScope is "user", which loads ~/.pi/agent/agents.',
      'Only set agentScope to "project" or "both" for trusted repositories or when the user explicitly asks for project-local agents.',
      "Subagent subprocesses disable extensions by default to avoid recursive agents and extension side effects, unless an agent opts in with includeExtensions frontmatter or the tool call passes includeExtensions.",
      `Agents whose tool allowlist includes ${USER_QUESTION_TOOL_NAME} receive an isolated bridge that surfaces their questions through the parent pi UI.`,
    ].join(" "),
    promptSnippet: "Delegate work to specialized pi agents from ~/.pi/agent/agents using isolated pi subprocesses.",
    promptGuidelines: [
      "Use subagent when the user asks you to use, spawn, delegate to, or consult a named agent.",
      'Treat a request that starts with an available agent name, such as "investigate ...", as a request to delegate to that agent.',
      "Use agent_list before subagent if you do not know which agents are available.",
      "Use subagent with agentScope user by default; only use project or both for trusted project-local agents.",
      "Do not call subagent in the same parallel tool batch as edit, write, or bash file mutations; wait for the subagent result before making additional local changes.",
    ],
    parameters: SubagentParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope: AgentScope = params.agentScope ?? "user";
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;
      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      const mode: SubagentDetails["mode"] = hasChain ? "chain" : hasTasks ? "parallel" : "single";
      const makeDetails = (results: AgentRunResult[]): SubagentDetails => ({
        mode,
        agentScope,
        userAgentsDir: discovery.userAgentsDir,
        projectAgentsDir: discovery.projectAgentsDir,
        results,
      });

      if (modeCount !== 1) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Provide exactly one mode: agent+task, tasks, or chain.\n\nAvailable agents:\n${formatAgentList(agents)}`,
            },
          ],
          details: makeDetails([]),
        };
      }

      if (params.tasks && params.tasks.length > MAX_PARALLEL_TASKS) {
        return {
          content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Maximum is ${MAX_PARALLEL_TASKS}.` }],
          details: makeDetails([]),
        };
      }

      const confirmProjectAgents = params.confirmProjectAgents ?? true;
      if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
        const projectAgents = Array.from(requestedAgentNames(params))
          .map((name) => agents.find((agent) => agent.name === name))
          .filter((agent): agent is AgentConfig => agent?.source === "project");

        if (projectAgents.length > 0) {
          const ok = await ctx.ui.confirm(
            "Run project-local agents?",
            [
              `Agents: ${projectAgents.map((agent) => agent.name).join(", ")}`,
              `Source: ${discovery.projectAgentsDir ?? "unknown"}`,
              "",
              "Project agents are repo-controlled prompts. Only continue for trusted repositories.",
            ].join("\n"),
          );

          if (!ok) {
            return {
              content: [{ type: "text", text: "Canceled: project-local agents were not approved." }],
              details: makeDetails([]),
            };
          }
        }
      }

      const placeholder = (agentName: string, task: string, cwd?: string, step?: number): AgentRunResult => ({
        agent: agentName,
        agentSource: agents.find((agent) => agent.name === agentName)?.source ?? "unknown",
        task,
        cwd: resolveCwd(ctx.cwd, cwd),
        exitCode: -1,
        started: false,
        finalOutput: "",
        progressMessage: task,
        stderr: "",
        usage: emptyUsage(),
        model: agents.find((agent) => agent.name === agentName)?.model,
        step,
      });
      const initialResults = params.tasks?.length
        ? params.tasks.map((task) => placeholder(task.agent, task.task, task.cwd))
        : params.chain?.length
          ? [placeholder(params.chain[0].agent, params.chain[0].task, params.chain[0].cwd, 1)]
          : params.agent && params.task
            ? [placeholder(params.agent, params.task, params.cwd)]
            : [];
      const dashboard = startSubagentDashboard(ctx, makeDetails(initialResults));
      let userQuestionQueue: Promise<void> = Promise.resolve();
      const userQuestionHandler: UserQuestionHandler = (request, questionSignal) => {
        const pending = userQuestionQueue.then(() => surfaceUserQuestion(ctx, request, questionSignal, dashboard));
        userQuestionQueue = pending.then(
          () => undefined,
          () => undefined,
        );
        return pending;
      };
      const publishUpdate: OnUpdateCallback = (partial) => {
        dashboard.update(subagentDashboardData(partial.details));
        onUpdate?.(partial);
      };

      if (params.chain?.length) {
        const results: AgentRunResult[] = [];
        let previousOutput = "";

        for (let index = 0; index < params.chain.length; index++) {
          const step = params.chain[index];
          const task = step.task.replace(/\{previous\}/g, previousOutput);
          const update: OnUpdateCallback = (partial) => {
            const current = partial.details.results[0];
            if (!current) return;
            publishUpdate({ content: partial.content, details: makeDetails([...results, current]) });
          };

          const result = await runSingleAgent(
            ctx.cwd,
            agents,
            step.agent,
            task,
            step.cwd,
            index + 1,
            shouldIncludeExtensions(agents, step.agent, params.includeExtensions),
            userQuestionHandler,
            signal,
            update,
            makeDetails,
          );

          results.push(result);
          publishUpdate({
            content: [{ type: "text", text: `${result.agent} ${isAgentErrored(result) ? "failed" : "finished"}.` }],
            details: makeDetails(results),
          });
          if (isAgentErrored(result)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Chain stopped at step ${index + 1} (${result.agent}).\n\n${truncateText(summarizeFailure(result))}`,
                },
              ],
              details: makeDetails(results),
            };
          }

          previousOutput = truncateText(result.finalOutput, 30 * 1024, 1_000);
        }

        const finalResult = results[results.length - 1];
        return {
          content: [{ type: "text", text: finalResult ? formatResultSummary(finalResult) : "Chain completed with no steps." }],
          details: makeDetails(results),
        };
      }

      if (params.tasks?.length) {
        const runningResults: AgentRunResult[] = params.tasks.map((task) =>
          placeholder(task.agent, task.task, task.cwd),
        );

        const emitParallelUpdate = () => {
          const done = runningResults.filter((result) => result.exitCode !== -1).length;
          const running = runningResults.length - done;
          publishUpdate({
            content: [{ type: "text", text: `Parallel subagents: ${done}/${runningResults.length} done, ${running} running.` }],
            details: makeDetails([...runningResults]),
          });
        };

        const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (task, index) => {
          const result = await runSingleAgent(
            ctx.cwd,
            agents,
            task.agent,
            task.task,
            task.cwd,
            undefined,
            shouldIncludeExtensions(agents, task.agent, params.includeExtensions),
            userQuestionHandler,
            signal,
            (partial) => {
              const current = partial.details.results[0];
              if (!current) return;
              runningResults[index] = current;
              emitParallelUpdate();
            },
            makeDetails,
          );

          runningResults[index] = result;
          emitParallelUpdate();
          return result;
        });

        const successCount = results.filter((result) => !isAgentErrored(result)).length;
        const summaries = results.map((result) => {
          const status = isAgentErrored(result) ? "failed" : "completed";
          const output = result.finalOutput || (isAgentErrored(result) ? summarizeFailure(result) : "(no output)");
          return `## ${result.agent} ${status}\n\n${truncateText(output, 12 * 1024, 400)}`;
        });

        return {
          content: [
            {
              type: "text",
              text: `Parallel subagents: ${successCount}/${results.length} succeeded.\n\n${summaries.join("\n\n")}`,
            },
          ],
          details: makeDetails(results),
        };
      }

      if (params.agent && params.task) {
        const result = await runSingleAgent(
          ctx.cwd,
          agents,
          params.agent,
          params.task,
          params.cwd,
          undefined,
          shouldIncludeExtensions(agents, params.agent, params.includeExtensions),
          userQuestionHandler,
          signal,
          publishUpdate,
          makeDetails,
        );

        publishUpdate({
          content: [{ type: "text", text: `${result.agent} ${isAgentErrored(result) ? "failed" : "finished"}.` }],
          details: makeDetails([result]),
        });
        if (isAgentErrored(result)) {
          return {
            content: [{ type: "text", text: `Agent ${result.agent} failed.\n\n${truncateText(summarizeFailure(result))}` }],
            details: makeDetails([result]),
          };
        }

        return {
          content: [{ type: "text", text: formatResultSummary(result) }],
          details: makeDetails([result]),
        };
      }

      return {
        content: [{ type: "text", text: `Invalid parameters.\n\nAvailable agents:\n${formatAgentList(agents)}` }],
        details: makeDetails([]),
      };
    },
    renderCall(args, theme) {
      const count = args.tasks?.length ?? args.chain?.length ?? (args.agent ? 1 : 0);
      const mode = args.tasks?.length ? "parallel" : args.chain?.length ? "chain" : "single";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", mode)}${theme.fg("muted", ` · ${count} agent${count === 1 ? "" : "s"}`)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (details && Array.isArray(details.results)) {
        return renderAgentDashboardDetails(subagentDashboardData(details), expanded, theme);
      }

      const text = result.content
        .filter((item): item is TextContent => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n");
      return new Text(text || "(no output)", 0, 0);
    },
  });

  pi.registerCommand("subagents", {
    description: "Show the latest live subagent dashboard",
    handler: async (_args, ctx) => {
      if (!activeSubagentDashboard) {
        ctx.ui.notify("No subagent dashboard is available yet.", "info");
        return;
      }

      if (activeSubagentDashboard.isVisible()) hideAgentDashboard(ctx, activeSubagentDashboard);
      else showAgentDashboard(ctx, activeSubagentDashboard);
    },
  });

  pi.registerCommand("agents", {
    description: "List available pi agents. Usage: /agents [user|project|both]",
    handler: async (args, ctx) => {
      const requestedScope = args.trim() as AgentScope;
      const scope: AgentScope = ["user", "project", "both"].includes(requestedScope) ? requestedScope : "user";
      const { text } = formatAgentsForTool(scope, ctx.cwd);
      ctx.ui.notify(text, "info");
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (activeSubagentDashboard) hideAgentDashboard(ctx, activeSubagentDashboard);
    activeSubagentDashboard = undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    const activeTools = new Set(pi.getActiveTools());
    if (!activeTools.has("agent_list") && !activeTools.has("subagent")) return;

    const agents = discoverAgents(ctx.cwd, "user").agents;
    if (agents.length === 0) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\nSubagent guidance:\n- Use agent_list when the user asks what agents are available.\n- Use subagent when the user asks you to use, spawn, consult, or delegate to one of these agents.\n- Treat a request that starts with an available agent name, such as \"investigate ...\", as a request to delegate to that agent.\n- Available user agents:\n${formatAgentList(agents, 10)}`,
    };
  });
}
