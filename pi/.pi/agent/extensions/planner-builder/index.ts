import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum, Type } from "@mariozechner/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  formatSize,
  truncateHead,
  truncateTail,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
  type AgentConfig,
  type AgentDiscoveryResult,
  type AgentScope,
  discoverAgents,
  formatAgentList,
} from "../subagent/agents";
import {
  createUserQuestionBridge,
  parseUserQuestion,
  surfaceUserQuestion,
  USER_QUESTION_TOOL_NAME,
  type UserQuestionBridge,
  type UserQuestionHandler,
  type UserQuestionResponse,
  writeUserQuestionResponse,
} from "../subagent/user-question";
import { notify as sendSystemNotification } from "../system-notify";
import {
  hidePlanBuildDashboard,
  isPlanBuildDetails,
  type PlanBuildAgentDetails,
  PlanBuildDashboard,
  type PlanBuildDashboardData,
  renderPlanBuildDetails,
  showPlanBuildDashboard,
} from "./dashboard";
import { parsePlanTaskResultMarker } from "./result-marker";

const DEFAULT_PLANNER_AGENT = "planner";
const DEFAULT_BUILDER_AGENT = "builder";
const DEFAULT_VERIFIER_AGENT = "verifier";
const EFFORT_STATE_EVENT = "pi:effort-state";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const DEFAULT_PLAN_DIR = ".pi/plans";
const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const STDERR_TAIL_LIMIT = 20_000;
const COMMAND_LOG_MIN_INTERVAL_MS = 1_500;
const COMMAND_LOG_MAX_ENTRIES = 80;
const DEFAULT_BUILDER_MONITOR_INTERVAL_SECONDS = 30;
const DEFAULT_BUILDER_STUCK_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_BUILDER_MAX_RESTARTS = 1;
const MIN_BUILDER_MONITOR_INTERVAL_SECONDS = 5;
const MIN_BUILDER_STUCK_TIMEOUT_SECONDS = 30;
const MAX_BUILDER_MONITOR_INTERVAL_SECONDS = 60 * 60;
const MAX_BUILDER_STUCK_TIMEOUT_SECONDS = 24 * 60 * 60;
const MAX_BUILDER_RESTARTS = 5;
const DEFAULT_TASK_WORKSPACE_ROOT = path.join(os.homedir(), ".pi", "plan-workspaces");

type TextContent = { type: "text"; text: string };
type TaskStatus = "pending" | "in-progress" | "done" | "failed" | "blocked";
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type SelectedEffort = ThinkingLevel | "max";

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface BuilderMonitorConfig {
  enabled: boolean;
  intervalSeconds: number;
  stuckTimeoutSeconds: number;
  maxRestarts: number;
}

interface AgentRunAttemptSummary {
  attempt: number;
  exitCode: number;
  stopReason?: string;
  errorMessage?: string;
  lastProgress?: string;
}

interface AgentRunResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  cwd: string;
  exitCode: number;
  finalOutput: string;
  liveOutput?: string;
  stderr: string;
  usage: UsageStats;
  model?: string;
  effort?: SelectedEffort;
  stopReason?: string;
  errorMessage?: string;
  progressMessage?: string;
  restartCount?: number;
  attempts?: AgentRunAttemptSummary[];
}

interface AgentRunOptions {
  model?: string;
  effort?: SelectedEffort;
  userQuestionHandler?: UserQuestionHandler;
}

interface BuilderRunOptions {
  model?: string;
  effort?: SelectedEffort;
  monitor?: BuilderMonitorConfig;
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
  errorMessage?: string;
}

interface PlanTask {
  id: string;
  title: string;
  status: string;
  dependsOn: string[];
  block: string;
  start: number;
  end: number;
}

interface PlanCreateDetails extends PlanBuildDashboardData {
  plannerAgent: string;
  builderAgent: string;
  taskCount: number;
  warnings: string[];
  questions: Array<{
    question: string;
    status: UserQuestionResponse["status"] | "pending";
    answer?: string;
  }>;
}

interface PlanBuildResult {
  task: PlanTask;
  run: AgentRunResult;
  status: TaskStatus;
  marker?: string;
  workspaceName?: string;
  workspacePath?: string;
  commitId?: string;
  integrationMessage?: string;
}

interface TaskWorkspace {
  name: string;
  rootPath: string;
  cwd: string;
  baseRevision: string;
}


interface TaskRunContext {
  task: PlanTask;
  workspace: TaskWorkspace;
  result: PlanBuildResult;
}

interface JjCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface TaskCommitInfo {
  commitId: string;
  changeId: string;
}

interface PlanBuildDetails extends PlanBuildDashboardData {
  builderAgent: string;
  verifierAgent: string;
  maxConcurrency: number;
  monitor: BuilderMonitorConfig;
  results: Array<{
    id: string;
    title: string;
    status: TaskStatus;
    exitCode: number;
    output: string;
  }>;
  skipped: Array<{
    id: string;
    title: string;
    reason: string;
  }>;
  verifier?: {
    status: "done" | "failed";
    exitCode: number;
    output: string;
    reportPath: string;
  };
}

type ToolUpdate<TDetails> = { content: TextContent[]; details: TDetails };
type OnUpdateCallback<TDetails> = (partial: ToolUpdate<TDetails>) => void;

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description:
    'Which agent directories to use. Default: "user" loads ~/.pi/agent/agents. Use "project" or "both" only for trusted repos.',
  default: "user",
});

const PlanCreateParams = Type.Object({
  request: Type.String({ description: "Implementation request for the planner agent." }),
  path: Type.Optional(
    Type.String({
      description:
        'Plan file path to write. Relative paths resolve from pi cwd. Default: ".pi/plans/<timestamp>-<slug>.md".',
    }),
  ),
  plannerAgent: Type.Optional(Type.String({ description: 'Planner agent name. Default: "planner".' })),
  builderAgent: Type.Optional(
    Type.String({
      description:
        'Builder agent name recorded in the plan and used in generated task instructions. Default: "builder".',
    }),
  ),
  agentScope: Type.Optional(AgentScopeSchema),
  overwrite: Type.Optional(Type.Boolean({ description: "Overwrite an existing plan file. Default: false.", default: false })),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
  ),
});

const PlanBuildParams = Type.Object({
  path: Type.String({ description: "Plan file path to read. Relative paths resolve from pi cwd." }),
  taskIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional task ids to run, e.g. [\"T01\", \"T02\"]. If omitted, all pending/failed/blocked tasks are considered.",
    }),
  ),
  builderAgent: Type.Optional(Type.String({ description: 'Builder agent name. Default: "builder".' })),
  verifierAgent: Type.Optional(Type.String({ description: 'Verifier agent name to run when runVerifier is true. Default: "verifier".' })),
  runVerifier: Type.Optional(
    Type.Boolean({ description: "Run the verifier agent after the plan build completes. Default: false.", default: false }),
  ),
  agentScope: Type.Optional(AgentScopeSchema),
  maxConcurrency: Type.Optional(
    Type.Number({
      description: `Maximum number of builder agents to run at once. Default: ${DEFAULT_MAX_CONCURRENCY}, max: ${MAX_CONCURRENCY}. Parallel tasks run in separate Jujutsu workspaces and are integrated serially.`,
      default: DEFAULT_MAX_CONCURRENCY,
      minimum: 1,
      maximum: MAX_CONCURRENCY,
    }),
  ),
  builderMonitor: Type.Optional(
    Type.Boolean({
      description: "Deprecated compatibility option; structured builder subprocesses are managed by the main planner-builder pane.",
      default: true,
    }),
  ),
  builderMonitorIntervalSeconds: Type.Optional(
    Type.Number({
      description: `Deprecated compatibility option. Default: ${DEFAULT_BUILDER_MONITOR_INTERVAL_SECONDS} seconds.`,
      default: DEFAULT_BUILDER_MONITOR_INTERVAL_SECONDS,
      minimum: MIN_BUILDER_MONITOR_INTERVAL_SECONDS,
      maximum: MAX_BUILDER_MONITOR_INTERVAL_SECONDS,
    }),
  ),
  builderStuckTimeoutSeconds: Type.Optional(
    Type.Number({
      description: `Deprecated compatibility option. Default: ${DEFAULT_BUILDER_STUCK_TIMEOUT_SECONDS} seconds.`,
      default: DEFAULT_BUILDER_STUCK_TIMEOUT_SECONDS,
      minimum: MIN_BUILDER_STUCK_TIMEOUT_SECONDS,
      maximum: MAX_BUILDER_STUCK_TIMEOUT_SECONDS,
    }),
  ),
  builderMaxRestarts: Type.Optional(
    Type.Number({
      description: `Maximum restarts per stuck builder task. Default: ${DEFAULT_BUILDER_MAX_RESTARTS}. Use 0 to cancel stuck runs without restarting.`,
      default: DEFAULT_BUILDER_MAX_RESTARTS,
      minimum: 0,
      maximum: MAX_BUILDER_RESTARTS,
    }),
  ),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
  ),
});

const PlanListParams = Type.Object({
  limit: Type.Optional(Type.Number({ description: "Maximum number of plan files to list. Default: 10.", default: 10 })),
});

function defaultBuilderMonitorConfig(): BuilderMonitorConfig {
  return {
    enabled: true,
    intervalSeconds: DEFAULT_BUILDER_MONITOR_INTERVAL_SECONDS,
    stuckTimeoutSeconds: DEFAULT_BUILDER_STUCK_TIMEOUT_SECONDS,
    maxRestarts: DEFAULT_BUILDER_MAX_RESTARTS,
  };
}

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value ?? fallback)));
}

function normalizeBuilderMonitorConfig(params: {
  builderMonitor?: boolean;
  builderMonitorIntervalSeconds?: number;
  builderStuckTimeoutSeconds?: number;
  builderMaxRestarts?: number;
}): BuilderMonitorConfig {
  const intervalSeconds = clampInteger(
    params.builderMonitorIntervalSeconds,
    DEFAULT_BUILDER_MONITOR_INTERVAL_SECONDS,
    MIN_BUILDER_MONITOR_INTERVAL_SECONDS,
    MAX_BUILDER_MONITOR_INTERVAL_SECONDS,
  );
  const stuckTimeoutSeconds = Math.max(
    intervalSeconds,
    clampInteger(
      params.builderStuckTimeoutSeconds,
      DEFAULT_BUILDER_STUCK_TIMEOUT_SECONDS,
      MIN_BUILDER_STUCK_TIMEOUT_SECONDS,
      MAX_BUILDER_STUCK_TIMEOUT_SECONDS,
    ),
  );

  return {
    enabled: params.builderMonitor ?? true,
    intervalSeconds,
    stuckTimeoutSeconds,
    maxRestarts: clampInteger(params.builderMaxRestarts, DEFAULT_BUILDER_MAX_RESTARTS, 0, MAX_BUILDER_RESTARTS),
  };
}

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

function truncateTextTail(text: string, maxBytes = 12 * 1024, maxLines = 400): string {
  const truncation = truncateTail(text, { maxBytes, maxLines });
  if (!truncation.truncated) return truncation.content;

  return `[Earlier output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
    truncation.outputBytes,
  )} of ${formatSize(truncation.totalBytes)}).]\n\n${truncation.content}`;
}

function truncateInline(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function truncateInlineTail(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `...${normalized.slice(Math.max(0, normalized.length - maxLength + 3))}`;
}

function formatJsonValue(value: unknown, maxLength = 80): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return truncateInline(value, maxLength);

  try {
    return truncateInline(JSON.stringify(value), maxLength);
  } catch {
    return truncateInline(String(value), maxLength);
  }
}

function formatToolArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";

  const record = args as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["path", "pattern", "query", "command", "glob", "limit"]) {
    const value = formatJsonValue(record[key], 48);
    if (value) parts.push(`${key}=${value}`);
  }

  if (parts.length === 0) {
    const fallback = formatJsonValue(args, 96);
    if (fallback) parts.push(fallback);
  }

  return parts.length ? ` (${parts.join(", ")})` : "";
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

function agentOutput(result: AgentRunResult): string {
  if (result.liveOutput?.trim()) return result.liveOutput.trim();
  if (result.finalOutput.trim()) return result.finalOutput.trim();
  if (isAgentErrored(result)) return summarizeFailure(result);
  return "";
}

function resolvePath(cwd: string, rawPath: string): string {
  const normalized = rawPath.trim().replace(/^@/, "");
  return path.isAbsolute(normalized) ? normalized : path.resolve(cwd, normalized);
}

function expandHomePath(rawPath: string): string {
  if (rawPath === "~") return os.homedir();
  if (rawPath.startsWith(`~${path.sep}`) || rawPath.startsWith("~/")) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

function displayPath(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative || ".";
  return absolutePath;
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/`[^`]*`/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");

  return slug || "plan";
}

function branchToWorkspaceSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/`[^`]*`/g, " ")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\.{2,}/g, ".")
    .slice(0, 48)
    .replace(/[-.]+$/g, "");

  return slug || "workspace";
}

function timestampForFile(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
}

function defaultPlanPath(cwd: string, request: string): string {
  return path.resolve(cwd, DEFAULT_PLAN_DIR, `${timestampForFile()}-${slugify(request)}.md`);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function planFileHeader(request: string, plannerAgent: string, builderAgent: string): string {
  return [
    "---",
    "planFileVersion: 1",
    `createdAt: ${yamlString(new Date().toISOString())}`,
    `request: ${yamlString(request)}`,
    `plannerAgent: ${yamlString(plannerAgent)}`,
    `builderAgent: ${yamlString(builderAgent)}`,
    'status: "pending"',
    "---",
    "",
    `> Generated by \`plan_file_create\` using the \`${plannerAgent}\` agent.`,
    `> Run ready tasks with \`/plan-build <this-file>\` or ask pi to use \`plan_file_build\`.`,
    "",
  ].join("\n");
}

function createPlannerTask(request: string, builderAgent: string): string {
  return [
    "Create a multi-agent implementation plan for this request:",
    "",
    request,
    "",
    "The output will be saved as a plan file and consumed by an extension that dispatches task blocks to builder agents.",
    `Assume each task will be implemented by a separate \`${builderAgent}\` agent and should become its own atomic Jujutsu (\`jj\`) commit.`,
    "",
    "Requirements:",
    "- Analyze the actual repository before planning.",
    `- Use the \`${USER_QUESTION_TOOL_NAME}\` tool when a user decision would materially change scope, architecture, or implementation details. Investigate first and do not ask questions the repository can answer.`,
    "- Ask one concise question at a time and include a small set of likely options when useful.",
    "- If user interaction is unavailable or cancelled, proceed with the safest reasonable assumption and state it in the plan.",
    "- Do not modify files.",
    "- Output markdown only; do not wrap the plan in a code fence.",
    "- Split work into small, builder-sized tasks that can be run independently when possible.",
    "- Treat each task as one atomic commit boundary; do not mix unrelated work into a task.",
    "- Add dependencies when tasks must run after another task.",
    "- Avoid assigning the same file to multiple tasks unless a dependency orders the edits.",
    "- Include exact file paths, verification commands, and edge cases.",
    "",
    "Use this exact machine-readable task format for every builder task:",
    "",
    "## Builder Tasks",
    "",
    "### Task T01: Short imperative title",
    "Status: pending",
    "Depends on: none",
    "Files:",
    "- path/to/file.ts",
    "Instructions:",
    "- Specific implementation instruction.",
    "Verification:",
    "- Exact command or manual check.",
    "",
    "### Task T02: Short imperative title",
    "Status: pending",
    "Depends on: T01",
    "Files:",
    "- path/to/other-file.ts",
    "Instructions:",
    "- Specific implementation instruction.",
    "Verification:",
    "- Exact command or manual check.",
    "",
    "Keep task ids sequential as T01, T02, T03, etc.",
    "Use Depends on: none for independent tasks, or a comma-separated list like Depends on: T01, T02.",
  ].join("\n");
}

function parseTaskIds(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

function normalizeTaskId(taskId: string): string {
  return taskId.trim().toUpperCase();
}

function parseDependsOn(block: string): string[] {
  const match = block.match(/^Depends on:\s*(.+)$/im);
  if (!match) return [];

  const value = match[1].trim();
  if (!value || /^none$/i.test(value)) return [];

  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(normalizeTaskId);
}

function parsePlanTasks(content: string): PlanTask[] {
  const headingPattern = /^###\s+Task\s+([A-Za-z0-9][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$/gm;
  const sectionPattern = /^##\s+[^#].*$/gm;
  const matches = Array.from(content.matchAll(headingPattern));
  const sectionStarts = Array.from(content.matchAll(sectionPattern)).map((match) => match.index ?? 0);

  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const nextTaskStart = matches[index + 1]?.index ?? content.length;
    const nextSectionStart = sectionStarts.find((sectionStart) => sectionStart > start) ?? content.length;
    const end = Math.min(nextTaskStart, nextSectionStart);
    const block = content.slice(start, end).trimEnd();
    const statusMatch = block.match(/^Status:\s*([A-Za-z][A-Za-z0-9_-]*)\s*$/im);

    return {
      id: normalizeTaskId(match[1]),
      title: match[2].trim(),
      status: statusMatch?.[1]?.trim().toLowerCase() ?? "pending",
      dependsOn: parseDependsOn(block),
      block,
      start,
      end,
    };
  });
}

function replaceTaskStatus(block: string, status: TaskStatus): string {
  if (/^Status:\s*.*$/im.test(block)) {
    return block.replace(/^Status:\s*.*$/im, `Status: ${status}`);
  }

  const firstLineEnd = block.indexOf("\n");
  if (firstLineEnd === -1) return `${block}\nStatus: ${status}`;

  return `${block.slice(0, firstLineEnd + 1)}Status: ${status}\n${block.slice(firstLineEnd + 1)}`;
}

function escapeCodeFence(text: string): string {
  return text.replace(/```/g, "``\\`");
}

function builderResultLog(result: PlanBuildResult): string {
  const output = result.run.finalOutput || (isAgentErrored(result.run) ? summarizeFailure(result.run) : "(no output)");
  const model = result.run.model ? [`- Model: ${result.run.model}`] : [];
  const effort = result.run.effort ? [`- Effort: ${result.run.effort}`] : [];
  const restarts = result.run.restartCount ? [`- Builder restarts: ${result.run.restartCount}`] : [];
  const attempts = result.run.attempts?.length && result.run.restartCount
    ? [`- Attempts: ${result.run.attempts.map((attempt) => `#${attempt.attempt} ${attempt.stopReason ?? "exit"} (${attempt.exitCode})`).join(", ")}`]
    : [];
  const workspace = result.workspacePath ? [`- Workspace: ${result.workspacePath}`] : [];
  const commit = result.commitId ? [`- Commit: ${result.commitId}`] : [];
  const integration = result.integrationMessage ? [`- Integration: ${result.integrationMessage}`] : [];
  const marker = result.marker ? [`- Result marker: ${result.marker}`] : [];

  return [
    `#### Builder result ${new Date().toISOString()}`,
    `- Agent: ${result.run.agent}`,
    ...model,
    ...effort,
    ...restarts,
    ...attempts,
    ...workspace,
    ...commit,
    ...integration,
    `- Status: ${result.status}`,
    `- Exit code: ${result.run.exitCode}`,
    ...marker,
    "",
    "```text",
    escapeCodeFence(truncateText(output, 12 * 1024, 400)),
    "```",
  ].join("\n");
}

async function updatePlanTaskStatus(
  absolutePath: string,
  taskId: string,
  status: TaskStatus,
  appendLog?: string,
): Promise<void> {
  await withFileMutationQueue(absolutePath, async () => {
    const content = await fs.promises.readFile(absolutePath, "utf8");
    const tasks = parsePlanTasks(content);
    const task = tasks.find((candidate) => candidate.id === normalizeTaskId(taskId));
    if (!task) throw new Error(`Task ${taskId} was not found in ${absolutePath}.`);

    let block = replaceTaskStatus(task.block, status);
    if (appendLog) block = `${block.trimEnd()}\n\n${appendLog}`;

    const suffix = content.slice(task.end);
    const separator = suffix.length > 0 ? (block.endsWith("\n") ? "\n" : "\n\n") : "\n";
    const nextContent = `${content.slice(0, task.start)}${block}${separator}${suffix}`;
    await fs.promises.writeFile(absolutePath, nextContent, "utf8");
  });
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

async function writeTempFile(prefix: string, fileName: string, content: string): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(dir, fileName);

  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.promises.chmod(filePath, 0o600);
  });

  return { dir, filePath };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const safeName = agentName.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return writeTempFile("pi-planner-builder-", `prompt-${safeName}.md`, prompt);
}

function maxEffortExtensionSource(): string {
  return `function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function isMaxCandidate(value) {
  return value === "xhigh" || value === "high";
}

function applyMaxEffortOverride(payload) {
  if (!isRecord(payload)) return false;

  let changed = false;

  if (isMaxCandidate(payload.reasoning_effort)) {
    payload.reasoning_effort = "max";
    changed = true;
  }

  const reasoning = payload.reasoning;
  if (isRecord(reasoning) && isMaxCandidate(reasoning.effort)) {
    reasoning.effort = "max";
    changed = true;
  }

  const outputConfig = payload.output_config;
  if (isRecord(outputConfig) && isMaxCandidate(outputConfig.effort)) {
    outputConfig.effort = "max";
    changed = true;
  }

  const additionalFields = payload.additionalModelRequestFields;
  if (isRecord(additionalFields)) {
    const additionalOutputConfig = additionalFields.output_config;
    if (isRecord(additionalOutputConfig) && isMaxCandidate(additionalOutputConfig.effort)) {
      additionalOutputConfig.effort = "max";
      changed = true;
    }
  }

  return changed;
}

export default function (pi) {
  pi.on("before_provider_request", (event) => {
    if (applyMaxEffortOverride(event.payload)) return event.payload;
  });
}
`;
}

async function writeMaxEffortExtensionToTempFile(): Promise<{ dir: string; filePath: string }> {
  return writeTempFile("pi-planner-builder-effort-", "max-effort.ts", maxEffortExtensionSource());
}

function signalSpawnedProcess(proc: ReturnType<typeof spawn>, signal: "SIGTERM" | "SIGKILL"): void {
  if (proc.exitCode !== null) return;

  if (process.platform !== "win32" && proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Fall back to signaling the direct child process.
    }
  }

  proc.kill(signal);
}

async function runAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  options: AgentRunOptions,
  signal: AbortSignal | undefined,
  onOutput?: (result: AgentRunResult) => void,
): Promise<AgentRunResult> {
  const agent = agents.find((candidate) => candidate.name === agentName);
  const model = options.model?.trim() || agent?.model;
  const thinkingLevel = options.effort === "max" ? "xhigh" : options.effort;
  const result: AgentRunResult = {
    agent: agentName,
    agentSource: agent?.source ?? "unknown",
    task,
    cwd: defaultCwd,
    exitCode: 0,
    finalOutput: "",
    stderr: "",
    usage: emptyUsage(),
    model,
    effort: options.effort,
    restartCount: 0,
  };

  if (!agent) {
    const available = agents.map((candidate) => candidate.name).join(", ") || "none";
    return {
      ...result,
      exitCode: 1,
      stderr: `Unknown agent "${agentName}". Available agents: ${available}.`,
    };
  }

  const args = ["--mode", "json", "-p", "--no-session"];
  if (!agent.includeExtensions) args.push("--no-extensions");
  if (model) args.push("--model", model);
  if (thinkingLevel) args.push("--thinking", thinkingLevel);
  if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

  let promptDir: string | undefined;
  let maxEffortExtensionDir: string | undefined;
  let userQuestionBridge: UserQuestionBridge | undefined;
  const messages: Message[] = [];

  try {
    if (options.userQuestionHandler && agent.tools?.includes(USER_QUESTION_TOOL_NAME)) {
      userQuestionBridge = await createUserQuestionBridge();
      args.push("--extension", userQuestionBridge.extensionPath);
    }

    if (options.effort === "max") {
      const extension = await writeMaxEffortExtensionToTempFile();
      maxEffortExtensionDir = extension.dir;
      args.push("--extension", extension.filePath);
    }

    if (agent.systemPrompt.trim()) {
      const prompt = await writePromptToTempFile(agent.name, agent.systemPrompt);
      promptDir = prompt.dir;
      args.push("--append-system-prompt", prompt.filePath);
    }

    args.push(`Task: ${task}`);

    let stdoutBuffer = "";
    let aborted = false;
    let abortCleanup: (() => void) | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let lastOutputUpdateAt = 0;
    let assistantDraft = "";
    let pendingQuestionWork = Promise.resolve();
    const questionAbortController = new AbortController();
    const forwardQuestionAbort = () => questionAbortController.abort();
    if (signal?.aborted) questionAbortController.abort();
    else signal?.addEventListener("abort", forwardQuestionAbort, { once: true });

    const emitOutput = (force = false) => {
      if (!onOutput) return;

      const now = Date.now();
      if (!force && now - lastOutputUpdateAt < 500) return;
      lastOutputUpdateAt = now;
      onOutput(result);
    };

    result.exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          PI_SUBAGENT: "1",
          PI_SUBAGENT_NAME: agent.name,
          ...(userQuestionBridge ? { PI_USER_QUESTION_BRIDGE_DIR: userQuestionBridge.dir } : {}),
        },
      });

      const enqueueUserQuestion = (event: AgentProcessEvent) => {
        if (
          !userQuestionBridge ||
          !options.userQuestionHandler ||
          event.toolName !== USER_QUESTION_TOOL_NAME ||
          !event.toolCallId
        ) {
          return false;
        }

        const bridge = userQuestionBridge;
        const request = parseUserQuestion(event.toolCallId, event.args, agent.name);
        pendingQuestionWork = pendingQuestionWork
          .then(async () => {
            let response: UserQuestionResponse;
            try {
              response = await options.userQuestionHandler?.(request, questionAbortController.signal) ?? {
                status: "unavailable",
                message: "User interaction is unavailable; continue with the safest reasonable assumption.",
              };
            } catch (error) {
              response = { status: "error", message: `Could not ask the user: ${commandErrorMessage(error)}` };
            }

            await writeUserQuestionResponse(bridge.dir, request.toolCallId, response);
          })
          .catch((error) => {
            result.stderr = appendStderrTail(result.stderr, `Question bridge failed: ${commandErrorMessage(error)}\n`);
            signalSpawnedProcess(proc, "SIGTERM");
          });
        return true;
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
          result.progressMessage = `${agentName} started.`;
          emitOutput(true);
          return;
        }

        if (event.type === "turn_start") {
          result.progressMessage = `${agentName} is thinking...`;
          emitOutput(true);
          return;
        }

        if (event.type === "message_start" && event.message?.role === "assistant") {
          assistantDraft = "";
          return;
        }

        if (event.type === "message_update") {
          const assistantEvent = event.assistantMessageEvent;
          const delta = typeof assistantEvent?.delta === "string" ? assistantEvent.delta : "";
          const fullText = event.message ? messageText(event.message) : "";
          if (fullText) assistantDraft = fullText;
          else if (delta) assistantDraft += delta;

          const text = assistantDraft || delta;
          result.liveOutput = text;
          result.progressMessage = text
            ? `${agentName} is writing: ${truncateInlineTail(text, 80)}`
            : `${agentName} is writing...`;
          emitOutput();
          return;
        }

        if (event.type === "tool_execution_start") {
          if (enqueueUserQuestion(event)) {
            const request = parseUserQuestion(event.toolCallId ?? "question", event.args, agent.name);
            result.progressMessage = `${agentName} is waiting for user input: ${truncateInline(request.question, 90)}`;
          } else {
            result.progressMessage = `${agentName} is running ${event.toolName ?? "tool"}${formatToolArgs(event.args)}...`;
          }
          emitOutput(true);
          return;
        }

        if (event.type === "tool_execution_update") {
          result.progressMessage = `${agentName} is still running ${event.toolName ?? "tool"}${formatToolArgs(event.args)}...`;
          emitOutput();
          return;
        }

        if (event.type === "tool_execution_end") {
          result.progressMessage = `${agentName} ${event.isError ? "failed" : "finished"} ${event.toolName ?? "tool"}.`;
          emitOutput(true);
          return;
        }

        if (event.type === "auto_retry_start") {
          result.progressMessage = `${agentName} retrying after error: ${truncateInline(event.errorMessage ?? "unknown error", 80)}`;
          emitOutput(true);
          return;
        }

        if (event.type === "compaction_start") {
          result.progressMessage = `${agentName} is compacting context...`;
          emitOutput(true);
          return;
        }

        if (event.type === "message_end" && event.message) {
          const message = event.message;
          messages.push(message);
          updateUsageFromMessage(result, message);
          result.finalOutput = finalAssistantOutput(messages);
          result.liveOutput = result.finalOutput;
          result.progressMessage = result.finalOutput ? `${agentName} output received.` : `${agentName} completed a message.`;
          emitOutput(true);
          return;
        }

        if (event.type === "agent_end" && messages.length === 0 && Array.isArray(event.messages)) {
          for (const message of event.messages) {
            messages.push(message);
            updateUsageFromMessage(result, message);
          }
          result.finalOutput = finalAssistantOutput(messages);
          result.liveOutput = result.finalOutput;
          result.progressMessage = result.finalOutput ? `${agentName} output received.` : `${agentName} finished.`;
          emitOutput(true);
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
        const lastLine = chunk
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .pop();
        if (lastLine) {
          result.progressMessage = `${agentName} stderr: ${truncateInline(lastLine, 90)}`;
          emitOutput();
        }
      });

      proc.on("error", (error) => {
        result.stderr = appendStderrTail(result.stderr, `${error.message}\n`);
        result.progressMessage = `${agentName} process error: ${truncateInline(error.message, 90)}`;
        emitOutput(true);
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

      const abortProcess = () => {
        if (aborted) return;
        aborted = true;
        result.progressMessage = `${agentName} was aborted; cancelling agent.`;
        emitOutput(true);
        signalSpawnedProcess(proc, "SIGTERM");
        killTimer = setTimeout(() => {
          signalSpawnedProcess(proc, "SIGKILL");
        }, 5_000);
        killTimer.unref?.();
      };

      if (signal?.aborted) {
        abortProcess();
      } else if (signal) {
        const abortHandler = () => abortProcess();
        signal.addEventListener("abort", abortHandler, { once: true });
        abortCleanup = () => signal.removeEventListener("abort", abortHandler);
      }
    });

    await pendingQuestionWork;

    if (aborted) {
      result.stopReason = "aborted";
      result.errorMessage = "Agent run was aborted.";
    }

    return result;
  } finally {
    for (const tempDir of [promptDir, maxEffortExtensionDir, userQuestionBridge?.dir]) {
      if (!tempDir) continue;

      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures.
      }
    }
  }
}

async function runBuilderInWorkspace(
  workspace: TaskWorkspace,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  options: BuilderRunOptions,
  signal: AbortSignal | undefined,
  onOutput?: (result: AgentRunResult) => void,
): Promise<AgentRunResult> {
  const monitor = options.monitor ?? defaultBuilderMonitorConfig();
  const maxAttempts = monitor.enabled ? monitor.maxRestarts + 1 : 1;
  const attempts: AgentRunAttemptSummary[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    let lastActivityAt = Date.now();
    let lastProgress = `${agentName} attempt ${attempt}/${maxAttempts} starting...`;
    let watchdog: ReturnType<typeof setInterval> | undefined;

    const abortFromParent = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abortFromParent, { once: true });

    if (monitor.enabled) {
      watchdog = setInterval(() => {
        if (controller.signal.aborted) return;
        const idleMs = Date.now() - lastActivityAt;
        if (idleMs >= monitor.stuckTimeoutSeconds * 1_000) {
          timedOut = true;
          controller.abort();
        }
      }, monitor.intervalSeconds * 1_000);
      watchdog.unref?.();
    }

    try {
      const run = await runAgent(
        workspace.cwd,
        agents,
        agentName,
        task,
        options,
        controller.signal,
        (result) => {
          lastActivityAt = Date.now();
          lastProgress = result.progressMessage ?? lastProgress;
          onOutput?.({
            ...result,
            restartCount: attempt - 1,
            attempts: [...attempts],
            progressMessage: attempt > 1 ? `${lastProgress} (attempt ${attempt}/${maxAttempts})` : lastProgress,
          });
        },
      );

      const summary: AgentRunAttemptSummary = {
        attempt,
        exitCode: timedOut ? 124 : run.exitCode,
        stopReason: timedOut ? "stuck" : run.stopReason ?? (run.exitCode === 0 ? "completed" : "failed"),
        errorMessage: timedOut ? `No subprocess output or lifecycle progress for ${monitor.stuckTimeoutSeconds} seconds.` : run.errorMessage,
        lastProgress,
      };
      attempts.push(summary);

      if (timedOut && attempt < maxAttempts && !signal?.aborted) continue;

      return {
        ...run,
        exitCode: timedOut ? 124 : run.exitCode,
        stopReason: summary.stopReason,
        errorMessage: summary.errorMessage ?? run.errorMessage,
        progressMessage: summary.errorMessage ?? run.progressMessage,
        restartCount: attempt - 1,
        attempts,
      };
    } finally {
      if (watchdog) clearInterval(watchdog);
      signal?.removeEventListener("abort", abortFromParent);
    }
  }

  throw new Error("Builder restart loop exited without a result.");
}

function findAgentOrThrow(agents: AgentConfig[], agentName: string): AgentConfig {
  const agent = agents.find((candidate) => candidate.name === agentName);
  if (agent) return agent;
  throw new Error(`Unknown agent "${agentName}". Available agents:\n${formatAgentList(agents)}`);
}

async function confirmProjectAgents(
  ctx: ExtensionContext,
  discovery: AgentDiscoveryResult,
  agents: AgentConfig[],
  agentScope: AgentScope,
  agentNames: string[],
  enabled: boolean,
): Promise<void> {
  if (!enabled || !ctx.hasUI || (agentScope !== "project" && agentScope !== "both")) return;

  const projectAgents = agentNames
    .map((name) => agents.find((agent) => agent.name === name))
    .filter((agent): agent is AgentConfig => agent?.source === "project");

  if (projectAgents.length === 0) return;

  const ok = await ctx.ui.confirm(
    "Run project-local agents?",
    [
      `Agents: ${projectAgents.map((agent) => agent.name).join(", ")}`,
      `Source: ${discovery.projectAgentsDir ?? "unknown"}`,
      "",
      "Project agents are repo-controlled prompts. Only continue for trusted repositories.",
    ].join("\n"),
  );

  if (!ok) throw new Error("Canceled: project-local agents were not approved.");
}

async function createPlanFile(
  ctx: ExtensionContext,
  params: {
    request: string;
    path?: string;
    plannerAgent?: string;
    builderAgent?: string;
    agentScope?: AgentScope;
    overwrite?: boolean;
    confirmProjectAgents?: boolean;
    model: string;
    effort: SelectedEffort;
  },
  signal?: AbortSignal,
  onUpdate?: OnUpdateCallback<PlanCreateDetails>,
  dashboard?: PlanBuildDashboard,
): Promise<{ text: string; details: PlanCreateDetails }> {
  const request = params.request.trim();
  if (!request) throw new Error("A non-empty request is required.");

  const plannerAgent = params.plannerAgent?.trim() || DEFAULT_PLANNER_AGENT;
  const builderAgent = params.builderAgent?.trim() || DEFAULT_BUILDER_AGENT;
  const model = params.model;
  const effort = params.effort;
  const agentScope = params.agentScope ?? "user";
  const discovery = discoverAgents(ctx.cwd, agentScope);
  const agents = discovery.agents;
  const absolutePath = params.path ? resolvePath(ctx.cwd, params.path) : defaultPlanPath(ctx.cwd, request);
  const relativePath = displayPath(ctx.cwd, absolutePath);
  const details: PlanCreateDetails = {
    path: relativePath,
    plannerAgent,
    builderAgent,
    taskCount: 0,
    warnings: [],
    questions: [],
    agents: [
      {
        id: "PLANNER",
        title: "Create implementation plan",
        agent: plannerAgent,
        model,
        status: "starting",
        output: "",
        progress: `Preparing ${plannerAgent}...`,
      },
    ],
  };
  const updatePlannerView = (update: Partial<PlanBuildAgentDetails>) => {
    const current = details.agents[0];
    if (current) details.agents[0] = { ...current, ...update };
  };

  findAgentOrThrow(agents, plannerAgent);
  findAgentOrThrow(agents, builderAgent);
  await confirmProjectAgents(ctx, discovery, agents, agentScope, [plannerAgent, builderAgent], params.confirmProjectAgents ?? true);

  if (fs.existsSync(absolutePath) && !params.overwrite) {
    throw new Error(`Plan file already exists: ${relativePath}. Pass overwrite: true or choose another path.`);
  }

  updatePlannerView({ status: "running", progress: `Starting ${plannerAgent} on ${model} (${effort} effort)...` });
  onUpdate?.({
    content: [{ type: "text", text: `Running ${plannerAgent} on ${model} (${effort} effort) to create ${relativePath}...` }],
    details,
  });

  const plannerResult = await runAgent(
    ctx.cwd,
    agents,
    plannerAgent,
    createPlannerTask(request, builderAgent),
    {
      model,
      effort,
      userQuestionHandler: async (question, questionSignal) => {
        const questionDetails: PlanCreateDetails["questions"][number] = {
          question: question.question,
          status: "pending",
        };
        details.questions.push(questionDetails);
        updatePlannerView({
          status: "running",
          progress: `Waiting for user input: ${truncateInline(question.question, 120)}`,
        });
        onUpdate?.({
          content: [{ type: "text", text: `Planner is waiting for user input: ${truncateInline(question.question, 120)}` }],
          details,
        });

        let response: UserQuestionResponse;
        try {
          response = await surfaceUserQuestion(ctx, question, questionSignal, dashboard);
        } catch (error) {
          response = { status: "error", message: `Could not ask the user: ${commandErrorMessage(error)}` };
        }

        questionDetails.status = response.status;
        questionDetails.answer = response.answer;
        updatePlannerView({ status: "running", progress: "Planner resumed after user input." });
        onUpdate?.({
          content: [
            {
              type: "text",
              text: response.status === "answered"
                ? "Planner received the user's answer and resumed planning."
                : `Planner question ${response.status}; continuing with a documented assumption.`,
            },
          ],
          details,
        });
        return response;
      },
    },
    signal,
    (result) => {
      const status = result.finalOutput
        ? `Planner output received for ${relativePath}.`
        : result.progressMessage
          ? `${result.progressMessage} Creating ${relativePath}.`
          : `Running ${plannerAgent} on ${model} (${effort} effort) to create ${relativePath}...`;

      updatePlannerView({
        status: "running",
        output: agentOutput(result),
        progress: result.progressMessage ?? status,
      });
      onUpdate?.({
        content: [{ type: "text", text: status }],
        details,
      });
    },
  );

  if (isAgentErrored(plannerResult)) {
    const message = `Planner agent failed.\n\n${truncateText(summarizeFailure(plannerResult))}`;
    updatePlannerView({
      status: "failed",
      output: agentOutput(plannerResult),
      progress: "Planner failed; inspect its output for details.",
      exitCode: plannerResult.exitCode,
    });
    onUpdate?.({ content: [{ type: "text", text: message }], details });
    throw new Error(message);
  }

  const planBody = plannerResult.finalOutput.trim();
  if (!planBody) throw new Error("Planner agent completed without producing a plan.");

  const content = `${planFileHeader(request, plannerAgent, builderAgent)}${planBody}\n`;
  const tasks = parsePlanTasks(content);
  details.taskCount = tasks.length;
  updatePlannerView({
    status: "done",
    output: agentOutput(plannerResult),
    progress: `Plan complete with ${tasks.length} builder task${tasks.length === 1 ? "" : "s"}.`,
    exitCode: plannerResult.exitCode,
  });

  if (tasks.length === 0) {
    details.warnings.push(
      'No parseable builder tasks found. Expected headings like "### Task T01: Title" followed by "Status: pending".',
    );
  }

  await withFileMutationQueue(absolutePath, async () => {
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.promises.writeFile(absolutePath, content, "utf8");
  });

  const warningText = details.warnings.length ? `\n\nWarnings:\n- ${details.warnings.join("\n- ")}` : "";
  const taskText = `${tasks.length} builder task${tasks.length === 1 ? "" : "s"}`;
  const text = `Created plan file ${relativePath} with ${taskText}.${warningText}`;

  notifyPlannerBuilder(`Plan created: ${relativePath} (${taskText}).`);
  return { text, details };
}

function createBuilderTask(planPath: string, task: PlanTask, fullPlan: string): string {
  return [
    "You are implementing one task from a planner-created multi-agent plan file.",
    "",
    `Plan file in main workspace: ${planPath}`,
    `Assigned task: ${task.id} - ${task.title}`,
    "",
    "Rules:",
    "- Implement only the assigned task unless a direct dependency is required to make it work.",
    "- You are already running inside a dedicated Jujutsu workspace for this task.",
    "- Do not create, forget, switch, rebase, merge, or otherwise manage Jujutsu workspaces; the planner-builder extension handles workspace integration.",
    "- Do not edit the plan file; it may not exist in this task workspace and the planner-builder extension updates task statuses from the main workspace.",
    "- Avoid unrelated refactors and unrelated files.",
    "- Use Jujutsu (`jj`) for version-control operations; do not use Git.",
    "- Before editing, inspect `jj status --no-pager` so you know the task workspace state.",
    `- After implementation and verification pass, create exactly one atomic Jujutsu commit for this task's changes before your final response (for example: \`jj commit -m ${JSON.stringify(`${task.id}: ${task.title}`)}\`).`,
    "- Leave the task workspace with a clean/empty working-copy commit after that task commit; do not make extra edits after committing.",
    "- The main planner-builder loop will rebase/integrate your task commit on top of the main workspace after you finish.",
    "- Only report `PLAN_TASK_RESULT: done` after the Jujutsu commit succeeds. If you cannot safely create exactly one atomic commit, report `PLAN_TASK_RESULT: blocked` or `PLAN_TASK_RESULT: failed` and explain why.",
    "- Read relevant files before editing and follow existing patterns.",
    "- Run focused verification. If no useful automated check exists, explain the manual verification performed.",
    "- If blocked, do not force changes. Explain the blocker.",
    "- End your final response with exactly one marker line: PLAN_TASK_RESULT: done, PLAN_TASK_RESULT: failed, or PLAN_TASK_RESULT: blocked.",
    "",
    "Assigned task block:",
    "",
    task.block,
    "",
    "Full plan context:",
    "",
    truncateText(fullPlan, 30 * 1024, 1_000),
  ].join("\n");
}

function createVerifierTask(planPath: string, results: PlanBuildResult[]): string {
  const summary = results.length
    ? results.map((result) => `- ${result.task.id} ${result.status}: ${result.task.title}`).join("\n")
    : "- No builder tasks were run.";

  return [
    "Verify the completed planner-builder plan build.",
    "",
    `Plan file: ${planPath}`,
    "",
    "The planner-builder extension has finished running builder task workspaces and integrating completed task commits onto the current main workspace.",
    "Review the repository's current changes against the `main` bookmark and write the required HTML findings report.",
    "",
    "Builder task results:",
    summary,
    "",
    "Follow your verifier agent instructions exactly:",
    "- Use Jujutsu (`jj`), not Git.",
    "- Write `.pi/outputs/findings.html` at the repository root.",
    "- Do not modify any other files.",
  ].join("\n");
}

function classifyBuilderResult(result: AgentRunResult): { status: TaskStatus; marker?: string } {
  if (isAgentErrored(result)) return { status: "failed" };

  const marker = parsePlanTaskResultMarker(result.finalOutput);
  if (marker === "blocked") return { status: "blocked", marker };
  if (marker === "failed") return { status: "failed", marker };
  if (marker === "done") return { status: "done", marker };

  return { status: "done" };
}

function taskDependenciesSatisfied(task: PlanTask, tasksById: Map<string, PlanTask>): boolean {
  return task.dependsOn.every((dependencyId) => {
    const dependency = tasksById.get(normalizeTaskId(dependencyId));
    return !dependency || dependency.status === "done";
  });
}

function taskBlockerReason(task: PlanTask, tasksById: Map<string, PlanTask>): string {
  const blockers = task.dependsOn.filter((dependencyId) => {
    const dependency = tasksById.get(normalizeTaskId(dependencyId));
    return dependency && dependency.status !== "done";
  });

  if (blockers.length === 0) return "No runnable dependency path found.";
  return `Waiting for dependencies: ${blockers.join(", ")}`;
}

function isDefaultRunnableStatus(status: string): boolean {
  return status === "pending" || status === "failed" || status === "blocked";
}

function buildDetails(
  planPath: string,
  builderAgent: string,
  maxConcurrency: number,
  results: PlanBuildResult[],
  skipped: PlanBuildDetails["skipped"],
  agents: PlanBuildAgentDetails[],
  verifierAgent = DEFAULT_VERIFIER_AGENT,
  verifierRun?: AgentRunResult,
  monitor: BuilderMonitorConfig = defaultBuilderMonitorConfig(),
): PlanBuildDetails {
  return {
    path: planPath,
    builderAgent,
    verifierAgent,
    maxConcurrency,
    monitor,
    agents: agents.map((agent) => ({ ...agent, output: truncateTextTail(agent.output) })),
    results: results.map((result) => ({
      id: result.task.id,
      title: result.task.title,
      status: result.status,
      exitCode: result.run.exitCode,
      output: truncateText(
        [result.run.finalOutput || result.run.stderr, result.integrationMessage].filter(Boolean).join("\n\n"),
        12 * 1024,
        400,
      ),
    })),
    skipped,
    verifier: verifierRun
      ? {
          status: isAgentErrored(verifierRun) ? "failed" : "done",
          exitCode: verifierRun.exitCode,
          output: truncateText(verifierRun.finalOutput || verifierRun.stderr, 12 * 1024, 400),
          reportPath: ".pi/outputs/findings.html",
        }
      : undefined,
  };
}

function createFailedAgentResult(
  agentName: string,
  task: string,
  cwd: string,
  message: string,
  model: string,
  effort: SelectedEffort,
): AgentRunResult {
  return {
    agent: agentName,
    agentSource: "unknown",
    task,
    cwd,
    exitCode: 1,
    finalOutput: "",
    stderr: message,
    usage: emptyUsage(),
    model,
    effort,
  };
}

function normalizeTaskFilePath(rawPath: string): string | undefined {
  const fromBackticks = rawPath.match(/`([^`]+)`/)?.[1];
  const value = (fromBackticks ?? rawPath)
    .replace(/^[-*]\s+/, "")
    .replace(/^@/, "")
    .replace(/^\.\//, "")
    .trim();

  if (!value || /^none$/i.test(value)) return undefined;

  const withoutDescription = value.split(/\s+(?:-|—|–|:)\s+/)[0]?.trim() || value;
  return withoutDescription
    .replace(/\s+\([^)]*\)$/, "")
    .replace(/^["']|["']$/g, "")
    .replace(/\/$/, "") || undefined;
}

function parseTaskFiles(block: string): string[] | undefined {
  const lines = block.split(/\r?\n/);
  const files = new Set<string>();
  let inFiles = false;

  for (const line of lines) {
    if (/^Files:\s*$/i.test(line.trim())) {
      inFiles = true;
      continue;
    }

    const inlineFiles = line.match(/^Files:\s*(.+)$/i);
    if (inlineFiles) {
      for (const item of inlineFiles[1].split(/[,;]/)) {
        const filePath = normalizeTaskFilePath(item);
        if (filePath) files.add(filePath);
      }
      inFiles = true;
      continue;
    }

    if (!inFiles) continue;
    if (/^[A-Za-z][A-Za-z0-9 _-]*:\s*$/.test(line.trim())) break;
    if (/^#{1,6}\s+/.test(line.trim())) break;

    const filePath = normalizeTaskFilePath(line);
    if (filePath) files.add(filePath);
  }

  return files.size > 0 ? Array.from(files).sort() : undefined;
}

function taskFilesOverlap(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left || !right) return true;

  for (const leftPath of left) {
    for (const rightPath of right) {
      if (leftPath === rightPath) return true;
      if (leftPath.startsWith(`${rightPath}/`) || rightPath.startsWith(`${leftPath}/`)) return true;
    }
  }

  return false;
}

function selectParallelTaskBatch(tasks: PlanTask[], maxConcurrency: number): Array<{ task: PlanTask; files: string[] | undefined }> {
  const selected: Array<{ task: PlanTask; files: string[] | undefined }> = [];
  const orderedTasks = [...tasks].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  for (const task of orderedTasks) {
    if (selected.length >= maxConcurrency) break;

    const files = parseTaskFiles(task.block);
    if (selected.some((item) => taskFilesOverlap(item.files, files))) continue;

    selected.push({ task, files });
  }

  return selected;
}

function commandForDisplay(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

async function runCommand(command: string, args: string[], cwd: string): Promise<JjCommandResult> {
  return await new Promise<JjCommandResult>((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk: string) => {
      stderr = appendStderrTail(stderr, chunk);
    });
    proc.on("error", (error) => {
      stderr = appendStderrTail(stderr, `${error.message}\n`);
      resolve({ exitCode: 1, stdout, stderr });
    });
    proc.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

async function runJj(cwd: string, args: string[], allowFailure = false): Promise<JjCommandResult> {
  const result = await runCommand("jj", ["--no-pager", ...args], cwd);
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(
      `${commandForDisplay("jj", args)} failed with exit code ${result.exitCode}.\n\n${truncateText(result.stderr || result.stdout)}`,
    );
  }

  return result;
}

async function getJjOutputLine(cwd: string, args: string[]): Promise<string> {
  const result = await runJj(cwd, args);
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length !== 1) {
    throw new Error(`Expected one line from ${commandForDisplay("jj", args)}, got ${lines.length}:\n${truncateText(result.stdout)}`);
  }

  return lines[0];
}

async function getCommitId(cwd: string, revset: string): Promise<string> {
  return getJjOutputLine(cwd, ["log", "--no-graph", "-r", revset, "-T", 'commit_id ++ "\\n"']);
}

async function getJjWorkspaceRoot(cwd: string): Promise<string> {
  return getJjOutputLine(cwd, ["workspace", "root"]);
}

async function getMainJjWorkspaceRoot(workspaceRoot: string): Promise<string> {
  const repoPointerPath = path.join(workspaceRoot, ".jj", "repo");
  const stat = await fs.promises.stat(repoPointerPath);
  if (stat.isDirectory()) return workspaceRoot;
  if (!stat.isFile()) throw new Error(`Unexpected Jujutsu repository pointer: ${repoPointerPath}`);

  const pointer = (await fs.promises.readFile(repoPointerPath, "utf8")).trim();
  if (!pointer) throw new Error(`Empty Jujutsu repository pointer: ${repoPointerPath}`);

  const repositoryStore = path.resolve(path.dirname(repoPointerPath), pointer);
  return await fs.promises.realpath(path.dirname(path.dirname(repositoryStore)));
}

async function listTaskCommits(workspaceCwd: string, baseRevision: string): Promise<TaskCommitInfo[]> {
  const result = await runJj(workspaceCwd, ["log", "--no-graph", "-r", `${baseRevision}..@-`, "-T", 'commit_id ++ " " ++ change_id ++ "\\n"']);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [commitId, changeId] = line.split(/\s+/);
      if (!commitId || !changeId) throw new Error(`Unexpected jj log output: ${line}`);
      return { commitId, changeId };
    });
}

async function revisionHasDiff(cwd: string, revset: string): Promise<boolean> {
  const result = await runJj(cwd, ["diff", "-r", revset, "--summary"]);
  return Boolean(result.stdout.trim());
}

async function listRevisionConflicts(cwd: string, revset: string): Promise<string> {
  const result = await runJj(cwd, ["resolve", "--list", "-r", revset], true);
  const output = (result.stdout || result.stderr).trim();
  if (result.exitCode !== 0 && /no conflicts found/i.test(output)) return "";
  if (result.exitCode !== 0) return output;
  return result.stdout.trim();
}

async function taskWorkspaceRoot(repositoryRoot: string, workspaceName: string): Promise<string> {
  const root = process.env.PI_PLAN_WORKSPACE_ROOT?.trim() || DEFAULT_TASK_WORKSPACE_ROOT;
  const expandedRoot = expandHomePath(root);
  const workspaceDirectory = path.join(path.resolve(expandedRoot), path.basename(repositoryRoot));
  await fs.promises.mkdir(workspaceDirectory, { recursive: true });
  return path.join(workspaceDirectory, workspaceName);
}

async function createTaskWorkspace(
  mainCwd: string,
  sourceWorkspaceRoot: string,
  repositoryRoot: string,
  task: PlanTask,
  baseRevision: string,
): Promise<TaskWorkspace> {
  const workspaceName = branchToWorkspaceSlug(`${path.basename(sourceWorkspaceRoot)}-${task.id}`);
  const rootPath = await taskWorkspaceRoot(repositoryRoot, workspaceName);
  if (fs.existsSync(rootPath)) throw new Error(`Task workspace path already exists: ${rootPath}`);

  await runJj(mainCwd, ["workspace", "add", "--name", workspaceName, rootPath, "-r", baseRevision]);

  const relativeCwd = path.relative(sourceWorkspaceRoot, mainCwd);
  const workspaceCwd = relativeCwd && !relativeCwd.startsWith("..") && !path.isAbsolute(relativeCwd)
    ? path.join(rootPath, relativeCwd)
    : rootPath;

  await fs.promises.mkdir(workspaceCwd, { recursive: true });
  return {
    name: workspaceName,
    rootPath,
    cwd: workspaceCwd,
    baseRevision,
  };
}

async function cleanupTaskWorkspace(mainCwd: string, workspace: TaskWorkspace): Promise<void> {
  await runJj(mainCwd, ["workspace", "forget", workspace.name]);
  await fs.promises.rm(workspace.rootPath, { recursive: true, force: true });
}

async function validateTaskWorkspaceCommit(workspace: TaskWorkspace): Promise<TaskCommitInfo> {
  const hasUncommittedDiff = await revisionHasDiff(workspace.cwd, "@");
  if (hasUncommittedDiff) {
    throw new Error("Task workspace still has uncommitted changes in its working-copy commit. The builder must create exactly one commit and leave @ empty.");
  }

  const commits = await listTaskCommits(workspace.cwd, workspace.baseRevision);
  if (commits.length !== 1) {
    throw new Error(`Expected exactly one task commit after ${workspace.baseRevision}, found ${commits.length}.`);
  }

  const commit = commits[0];
  if (!commit) throw new Error(`Expected exactly one task commit after ${workspace.baseRevision}, found 0.`);

  if (!(await revisionHasDiff(workspace.cwd, commit.commitId))) {
    throw new Error(`Task commit ${commit.commitId} is empty.`);
  }

  return commit;
}

async function integrateTaskWorkspace(
  mainCwd: string,
  workspace: TaskWorkspace,
  result: PlanBuildResult,
  integratedHead: string,
): Promise<{ result: PlanBuildResult; integratedHead: string }> {
  if (result.status !== "done") {
    result.integrationMessage = result.workspacePath ? `Workspace kept for inspection at ${result.workspacePath}.` : undefined;
    return { result, integratedHead };
  }

  let commit: TaskCommitInfo;
  try {
    commit = await validateTaskWorkspaceCommit(workspace);
  } catch (error) {
    result.status = "failed";
    result.integrationMessage = `${commandErrorMessage(error)} Workspace kept for inspection at ${workspace.rootPath}.`;
    return { result, integratedHead };
  }

  result.commitId = commit.commitId;

  const rebase = await runJj(mainCwd, ["rebase", "-r", commit.commitId, "--onto", integratedHead], true);
  if (rebase.exitCode !== 0) {
    result.status = "blocked";
    result.integrationMessage = `Could not rebase task commit onto ${integratedHead}: ${truncateInline(rebase.stderr || rebase.stdout, 180)}. Workspace kept at ${workspace.rootPath}.`;
    return { result, integratedHead };
  }

  let rebasedCommitId: string;
  try {
    rebasedCommitId = await getCommitId(mainCwd, commit.changeId);
  } catch (error) {
    result.status = "blocked";
    result.integrationMessage = `Could not find the rebased task commit for change ${commit.changeId}: ${commandErrorMessage(error)}. Workspace kept at ${workspace.rootPath}.`;
    return { result, integratedHead };
  }

  const conflicts = await listRevisionConflicts(mainCwd, commit.changeId);
  if (conflicts) {
    result.status = "blocked";
    result.commitId = rebasedCommitId;
    result.integrationMessage = `Rebased task commit has conflicts: ${truncateInline(conflicts, 180)}. Workspace kept at ${workspace.rootPath}.`;
    return { result, integratedHead };
  }

  result.commitId = rebasedCommitId;
  result.integrationMessage = `Integrated ${rebasedCommitId} on top of ${integratedHead}.`;

  try {
    await cleanupTaskWorkspace(mainCwd, workspace);
  } catch (error) {
    result.integrationMessage = `${result.integrationMessage} Workspace cleanup failed: ${commandErrorMessage(error)}`;
  }

  return { result, integratedHead: rebasedCommitId };
}

async function restorePlanFileAfterWorkspaceMove(absolutePath: string, content: string): Promise<void> {
  await withFileMutationQueue(absolutePath, async () => {
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.promises.writeFile(absolutePath, content, "utf8");
  });
}

async function buildPlanFile(
  ctx: ExtensionContext,
  params: {
    path: string;
    taskIds?: string[];
    builderAgent?: string;
    verifierAgent?: string;
    runVerifier?: boolean;
    agentScope?: AgentScope;
    maxConcurrency?: number;
    builderMonitor?: boolean;
    builderMonitorIntervalSeconds?: number;
    builderStuckTimeoutSeconds?: number;
    builderMaxRestarts?: number;
    confirmProjectAgents?: boolean;
    model: string;
    effort: SelectedEffort;
  },
  signal?: AbortSignal,
  onUpdate?: OnUpdateCallback<PlanBuildDetails>,
): Promise<{ text: string; details: PlanBuildDetails }> {
  const absolutePath = resolvePath(ctx.cwd, params.path);
  const relativePath = displayPath(ctx.cwd, absolutePath);
  const builderAgent = params.builderAgent?.trim() || DEFAULT_BUILDER_AGENT;
  const verifierAgent = params.verifierAgent?.trim() || DEFAULT_VERIFIER_AGENT;
  const runVerifier = params.runVerifier ?? false;
  const model = params.model;
  const effort = params.effort;
  const agentScope = params.agentScope ?? "user";
  const maxConcurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(params.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY)));
  const monitor = normalizeBuilderMonitorConfig(params);
  const discovery = discoverAgents(ctx.cwd, agentScope);
  const agents = discovery.agents;
  const targetIds = new Set((params.taskIds ?? []).map(normalizeTaskId));
  const attempted = new Set<string>();
  const results: PlanBuildResult[] = [];
  const skipped: PlanBuildDetails["skipped"] = [];
  const agentViews = new Map<string, PlanBuildAgentDetails>();
  let verifierRun: AgentRunResult | undefined;
  const updateAgentView = (id: string, update: Partial<PlanBuildAgentDetails>) => {
    const current = agentViews.get(id);
    if (current) agentViews.set(id, { ...current, ...update });
  };
  const detailsFor = (currentVerifierRun = verifierRun) =>
    buildDetails(
      relativePath,
      builderAgent,
      maxConcurrency,
      results,
      skipped,
      Array.from(agentViews.values()),
      verifierAgent,
      currentVerifierRun,
      monitor,
    );

  findAgentOrThrow(agents, builderAgent);
  if (runVerifier) findAgentOrThrow(agents, verifierAgent);
  await confirmProjectAgents(
    ctx,
    discovery,
    agents,
    agentScope,
    runVerifier ? [builderAgent, verifierAgent] : [builderAgent],
    params.confirmProjectAgents ?? true,
  );

  if (!fs.existsSync(absolutePath)) throw new Error(`Plan file not found: ${relativePath}`);

  const sourceWorkspaceRoot = await getJjWorkspaceRoot(ctx.cwd);
  const repositoryRoot = await getMainJjWorkspaceRoot(sourceWorkspaceRoot);
  const initialHead = await getCommitId(ctx.cwd, "@");
  let integratedHead = initialHead;

  while (true) {
    const content = await fs.promises.readFile(absolutePath, "utf8");
    const tasks = parsePlanTasks(content);
    if (tasks.length === 0) throw new Error(`No builder tasks found in ${relativePath}.`);

    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    const candidates = tasks.filter((task) => {
      if (attempted.has(task.id)) return false;
      if (targetIds.size > 0) return targetIds.has(task.id) && task.status !== "done";
      return isDefaultRunnableStatus(task.status);
    });

    const ready = candidates.filter((task) => taskDependenciesSatisfied(task, tasksById));
    const blocked = candidates.filter((task) => !taskDependenciesSatisfied(task, tasksById));

    if (ready.length === 0) {
      for (const task of blocked) {
        skipped.push({ id: task.id, title: task.title, reason: taskBlockerReason(task, tasksById) });
      }
      break;
    }

    const batch = selectParallelTaskBatch(ready, maxConcurrency);
    if (batch.length === 0) {
      for (const task of blocked) {
        skipped.push({ id: task.id, title: task.title, reason: taskBlockerReason(task, tasksById) });
      }
      break;
    }

    onUpdate?.({
      content: [
        {
          type: "text",
          text: `Running ${batch.length} of ${ready.length} ready task${ready.length === 1 ? "" : "s"} from ${relativePath} with ${builderAgent} on ${model} (${effort} effort) in parallel Jujutsu workspaces...`,
        },
      ],
      details: detailsFor(),
    });

    const launches: Array<{
      task: PlanTask;
      workspace: TaskWorkspace;
      prompt: string;
    }> = [];
    for (const item of batch) {
      attempted.add(item.task.id);
      const workspace = await createTaskWorkspace(
        ctx.cwd,
        sourceWorkspaceRoot,
        repositoryRoot,
        item.task,
        integratedHead,
      );
      await updatePlanTaskStatus(absolutePath, item.task.id, "in-progress");

      const latestContent = await fs.promises.readFile(absolutePath, "utf8");
      const latestTask = parsePlanTasks(latestContent).find((candidate) => candidate.id === item.task.id) ?? item.task;
      launches.push({
        task: latestTask,
        workspace,
        prompt: createBuilderTask(relativePath, latestTask, latestContent),
      });
      agentViews.set(latestTask.id, {
        id: latestTask.id,
        title: latestTask.title,
        agent: builderAgent,
        model,
        status: "starting",
        output: "",
        progress: `Workspace ${workspace.name} is ready; starting agent...`,
        workspaceName: workspace.name,
        workspacePath: workspace.rootPath,
      });
    }

    onUpdate?.({
      content: [{ type: "text", text: `Started ${launches.length} builder agent${launches.length === 1 ? "" : "s"}.` }],
      details: detailsFor(),
    });

    const runLaunch = async (launch: (typeof launches)[number]): Promise<TaskRunContext> => {
      try {
        const run = await runBuilderInWorkspace(
          launch.workspace,
          agents,
          builderAgent,
          launch.prompt,
          { model, effort, monitor },
          signal,
          (agentResult) => {
            const status = agentResult.progressMessage
              ? `${launch.task.id}: ${agentResult.progressMessage}`
              : `${launch.task.id}: ${builderAgent} is running on ${model} (${effort} effort) in ${launch.workspace.name}...`;

            updateAgentView(launch.task.id, {
              status: "running",
              output: agentOutput(agentResult),
              progress: agentResult.progressMessage ?? status,
              restartCount: agentResult.restartCount,
            });
            onUpdate?.({
              content: [{ type: "text", text: status }],
              details: detailsFor(),
            });
          },
        );
        const classification = classifyBuilderResult(run);
        updateAgentView(launch.task.id, {
          status: classification.status === "done" ? "integrating" : classification.status,
          output: agentOutput(run),
          progress: classification.status === "done" ? "Agent finished; validating and integrating its commit..." : run.progressMessage,
          exitCode: run.exitCode,
          restartCount: run.restartCount,
        });
        onUpdate?.({
          content: [{ type: "text", text: `${launch.task.id}: agent finished; processing result...` }],
          details: detailsFor(),
        });
        return {
          task: launch.task,
          workspace: launch.workspace,
          result: {
            task: launch.task,
            run,
            status: classification.status,
            marker: classification.marker,
            workspaceName: launch.workspace.name,
            workspacePath: launch.workspace.rootPath,
          },
        };
      } catch (error) {
        const run = createFailedAgentResult(builderAgent, launch.prompt, launch.workspace.cwd, commandErrorMessage(error), model, effort);
        updateAgentView(launch.task.id, {
          status: "failed",
          output: agentOutput(run),
          progress: run.stderr,
          exitCode: run.exitCode,
        });
        return {
          task: launch.task,
          workspace: launch.workspace,
          result: {
            task: launch.task,
            run,
            status: "failed",
            workspaceName: launch.workspace.name,
            workspacePath: launch.workspace.rootPath,
            integrationMessage: `Workspace kept for inspection at ${launch.workspace.rootPath}.`,
          },
        };
      }
    };

    const running = launches.map((launch) => runLaunch(launch));
    while (running.length > 0) {
      const completed = await Promise.race(running.map((promise, index) => promise.then((taskRun) => ({ index, taskRun }))));
      running.splice(completed.index, 1);

      const finalized = await integrateTaskWorkspace(ctx.cwd, completed.taskRun.workspace, completed.taskRun.result, integratedHead);
      integratedHead = finalized.integratedHead;
      results.push(finalized.result);
      updateAgentView(completed.taskRun.task.id, {
        status: finalized.result.status,
        output: agentOutput(finalized.result.run),
        progress: finalized.result.integrationMessage ?? `${completed.taskRun.task.id} ${finalized.result.status}.`,
        exitCode: finalized.result.run.exitCode,
        restartCount: finalized.result.run.restartCount,
      });

      await updatePlanTaskStatus(absolutePath, completed.taskRun.task.id, finalized.result.status, builderResultLog(finalized.result));
      notifyPlannerBuilder(`Plan task ${completed.taskRun.task.id} ${finalized.result.status}: ${completed.taskRun.task.title}`);

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `${completed.taskRun.task.id} ${finalized.result.status}; latest integrated head is ${integratedHead}.`,
          },
        ],
        details: detailsFor(),
      });
    }

    onUpdate?.({
      content: [
        {
          type: "text",
          text: `Completed ${results.length} task${results.length === 1 ? "" : "s"} from ${relativePath}; latest integrated head is ${integratedHead}.`,
        },
      ],
      details: detailsFor(),
    });

    if (signal?.aborted) break;
  }

  if (integratedHead !== initialHead) {
    const finalPlanContent = await fs.promises.readFile(absolutePath, "utf8");
    await runJj(ctx.cwd, ["new", integratedHead]);
    await restorePlanFileAfterWorkspaceMove(absolutePath, finalPlanContent);
  }

  if (runVerifier) {
    agentViews.set("VERIFIER", {
      id: "VERIFIER",
      title: "Review integrated changes and write findings report",
      agent: verifierAgent,
      model,
      status: "starting",
      output: "",
      progress: "Starting verifier agent...",
    });
    onUpdate?.({
      content: [{ type: "text", text: `Running ${verifierAgent} on ${model} (${effort} effort) to verify completed plan build...` }],
      details: detailsFor(),
    });

    verifierRun = await runAgent(
      ctx.cwd,
      agents,
      verifierAgent,
      createVerifierTask(relativePath, results),
      { model, effort },
      signal,
      (agentResult) => {
        const status = agentResult.progressMessage
          ? `Verifier: ${agentResult.progressMessage}`
          : `${verifierAgent} is writing .pi/outputs/findings.html...`;

        updateAgentView("VERIFIER", {
          status: "running",
          output: agentOutput(agentResult),
          progress: agentResult.progressMessage ?? status,
        });
        onUpdate?.({
          content: [{ type: "text", text: status }],
          details: detailsFor(agentResult),
        });
      },
    );
    updateAgentView("VERIFIER", {
      status: isAgentErrored(verifierRun) ? "failed" : "done",
      output: agentOutput(verifierRun),
      progress: isAgentErrored(verifierRun)
        ? "Verifier failed; inspect its output for details."
        : "Verifier finished; report written to .pi/outputs/findings.html.",
      exitCode: verifierRun.exitCode,
    });
    onUpdate?.({
      content: [{ type: "text", text: `Verifier ${isAgentErrored(verifierRun) ? "failed" : "finished"}.` }],
      details: detailsFor(),
    });

    notifyPlannerBuilder(
      isAgentErrored(verifierRun)
        ? `Plan verifier failed for ${relativePath}.`
        : `Plan verifier finished for ${relativePath}: .pi/outputs/findings.html`,
    );
  }

  if (targetIds.size > 0) {
    const content = await fs.promises.readFile(absolutePath, "utf8");
    const knownIds = new Set(parsePlanTasks(content).map((task) => task.id));
    for (const targetId of targetIds) {
      if (!knownIds.has(targetId)) skipped.push({ id: targetId, title: "Unknown task", reason: "Task id not found in plan file." });
    }
  }

  const doneCount = results.filter((result) => result.status === "done").length;
  const failedCount = results.filter((result) => result.status === "failed").length;
  const blockedCount = results.filter((result) => result.status === "blocked").length;
  const summaryLines = results.map((result) => `- ${result.task.id} ${result.status}: ${result.task.title}`);
  const skippedLines = skipped.map((item) => `- ${item.id}: ${item.reason}`);
  let verifierText = runVerifier ? "Verifier did not run." : "Verifier skipped (not requested).";
  if (verifierRun && isAgentErrored(verifierRun)) {
    verifierText = "Verifier failed. Expected report path: .pi/outputs/findings.html";
  } else if (verifierRun) {
    verifierText = "Verifier finished. Report: .pi/outputs/findings.html";
  }
  const text = [
    `Plan build finished for ${relativePath}.`,
    `Results: ${doneCount} done, ${failedCount} failed, ${blockedCount} blocked, ${skipped.length} skipped.`,
    verifierText,
    summaryLines.length ? `\nTasks:\n${summaryLines.join("\n")}` : "",
    skippedLines.length ? `\nSkipped:\n${skippedLines.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const verifierStatus = !runVerifier ? "skipped" : verifierRun && !isAgentErrored(verifierRun) ? "done" : "failed";
  notifyPlannerBuilder(
    `Plan build finished for ${relativePath}: ${doneCount} done, ${failedCount} failed, ${blockedCount} blocked, ${skipped.length} skipped; verifier ${verifierStatus}.`,
  );
  return { text, details: detailsFor() };
}

async function listPlanFiles(cwd: string, limit: number): Promise<Array<{ path: string; mtimeMs: number; taskCount: number }>> {
  const planDir = path.resolve(cwd, DEFAULT_PLAN_DIR);
  let entries: fs.Dirent[];

  try {
    entries = await fs.promises.readdir(planDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const plans = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map(async (entry) => {
        const absolutePath = path.join(planDir, entry.name);
        const [stat, content] = await Promise.all([
          fs.promises.stat(absolutePath),
          fs.promises.readFile(absolutePath, "utf8").catch(() => ""),
        ]);
        return {
          path: displayPath(cwd, absolutePath),
          mtimeMs: stat.mtimeMs,
          taskCount: parsePlanTasks(content).length,
        };
      }),
  );

  return plans.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, Math.max(1, limit));
}

async function latestPlanFile(cwd: string): Promise<string | undefined> {
  const plans = await listPlanFiles(cwd, 1);
  return plans[0]?.path;
}

function commandErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notifyPlannerBuilder(message: string): void {
  sendSystemNotification(truncateInline(message, 240), "Pi planner-builder");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function normalizeThinkingLevel(value: string): ThinkingLevel {
  return isThinkingLevel(value) ? value : "off";
}

function getSelectedModel(ctx: ExtensionContext): string {
  if (!ctx.model) throw new Error("No model is selected in the main pi process.");
  return `${ctx.model.provider}/${ctx.model.id}`;
}

async function notifyCommandError(ctx: ExtensionContext, error: unknown): Promise<void> {
  const message = commandErrorMessage(error);
  ctx.ui.notify(message, "error");
  notifyPlannerBuilder(`Planner-builder failed: ${message}`);
}

function compactStatusText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 96) return normalized;
  return `${normalized.slice(0, 93)}...`;
}

function statusTextFromUpdate<TDetails>(partial: ToolUpdate<TDetails>): string | undefined {
  const text = partial.content
    .map((item) => item.text)
    .join(" ")
    .trim();

  return text ? compactStatusText(text) : undefined;
}

interface CommandProgressUpdateOptions {
  log?: boolean;
  forceLog?: boolean;
}

interface CommandProgressOptions {
  onLog?: (text: string) => void;
  logIntervalMs?: number;
  maxLogEntries?: number;
}

interface CommandProgress {
  update(text: string, options?: CommandProgressUpdateOptions): void;
  log(text: string): void;
  stop(): void;
}

function timestampForLog(date = new Date()): string {
  return date.toISOString().slice(11, 19);
}

function sendCommandProgressMessage(pi: ExtensionAPI, ctx: ExtensionContext, command: string, text: string): void {
  if (!ctx.isIdle()) {
    ctx.ui.notify(`${command}: ${text}`, "info");
    return;
  }

  pi.sendMessage({
    customType: "planner-builder",
    content: `\`${timestampForLog()}\` ${command}: ${text}`,
    display: true,
    details: { command, progress: true, status: text },
  });
}

function startCommandProgress(ctx: ExtensionContext, key: string, initialText: string, options: CommandProgressOptions = {}): CommandProgress {
  const startedAt = Date.now();
  const logIntervalMs = options.logIntervalMs ?? COMMAND_LOG_MIN_INTERVAL_MS;
  const maxLogEntries = options.maxLogEntries ?? COMMAND_LOG_MAX_ENTRIES;
  let currentText = compactStatusText(initialText);
  let lastLoggedText = "";
  let lastLoggedAt = 0;
  let logCount = 0;
  let logLimitMessageShown = false;

  const render = () => {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
    ctx.ui.setStatus(key, `${currentText} (${elapsedSeconds}s)`);
  };

  const emitLog = (text: string, force = false) => {
    if (!options.onLog) return;

    const compactText = compactStatusText(text);
    if (!compactText || compactText === lastLoggedText) return;

    const now = Date.now();
    if (!force && now - lastLoggedAt < logIntervalMs) return;

    if (logCount >= maxLogEntries) {
      if (!logLimitMessageShown) {
        logLimitMessageShown = true;
        options.onLog("Progress log limit reached; continuing live updates in the status bar.");
      }
      return;
    }

    lastLoggedText = compactText;
    if (!force) lastLoggedAt = now;
    logCount++;
    options.onLog(compactText);
  };

  render();
  const timer = setInterval(render, 1_000);
  timer.unref?.();

  return {
    update(text: string, updateOptions: CommandProgressUpdateOptions = {}) {
      currentText = compactStatusText(text);
      render();
      if (updateOptions.log) emitLog(currentText, updateOptions.forceLog ?? false);
    },
    log(text: string) {
      emitLog(text, true);
    },
    stop() {
      clearInterval(timer);
      ctx.ui.setStatus(key, undefined);
    },
  };
}

export default function (pi: ExtensionAPI) {
  let selectedEffort: SelectedEffort | undefined;
  let activeBuildDashboard: PlanBuildDashboard | undefined;

  const getSelectedEffort = (): SelectedEffort => selectedEffort ?? normalizeThinkingLevel(pi.getThinkingLevel());
  const startBuildDashboard = (ctx: ExtensionContext, planPath: string): PlanBuildDashboard => {
    activeBuildDashboard?.close();
    const dashboard = new PlanBuildDashboard(planPath);
    activeBuildDashboard = dashboard;
    showPlanBuildDashboard(ctx, dashboard);
    return dashboard;
  };

  pi.events.on(EFFORT_STATE_EVENT, (state: unknown) => {
    const effort = isRecord(state) ? state.effort : undefined;

    if (effort === "max") {
      selectedEffort = "max";
    } else if (isThinkingLevel(effort)) {
      selectedEffort = effort;
    } else {
      selectedEffort = undefined;
    }
  });

  pi.registerMessageRenderer("planner-builder", (message, { expanded }, theme) => {
    const details = message.details as unknown;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((item): item is TextContent => item?.type === "text" && typeof item.text === "string")
            .map((item) => item.text)
            .join("\n");

    if (isRecord(details) && details.progress) return new Text(theme.fg("dim", text), 1, 0);
    if (isPlanBuildDetails(details)) return renderPlanBuildDetails(details, expanded, theme);
    return new Text(text, 1, 0);
  });

  pi.registerShortcut("alt+x", {
    description: "Show or hide the planner-builder dashboard",
    handler: async (ctx) => {
      if (!activeBuildDashboard) {
        ctx.ui.notify("No planner-builder dashboard is available.", "info");
        return;
      }

      if (activeBuildDashboard.isVisible()) hidePlanBuildDashboard(ctx, activeBuildDashboard);
      else showPlanBuildDashboard(ctx, activeBuildDashboard);
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (activeBuildDashboard) hidePlanBuildDashboard(ctx, activeBuildDashboard);
    activeBuildDashboard = undefined;
  });

  pi.registerTool({
    name: "plan_file_create",
    label: "Create Plan File",
    description: "Run the planner agent with the model and effort selected in the main pi process, surface material planner questions through the parent UI, then save a structured plan file with builder task blocks.",
    promptSnippet: "Run the planner agent with the current model and effort, surface material questions, and write a multi-builder plan file under .pi/plans.",
    promptGuidelines: [
      "Use plan_file_create when the user asks to create a planner-generated plan file for builder agents.",
      "Use plan_file_build after plan_file_create when the user asks multiple builder agents to implement plan tasks.",
    ],
    parameters: PlanCreateParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const dashboard = startBuildDashboard(ctx, params.path?.trim() || "Creating plan...");
      try {
        const result = await createPlanFile(
          ctx,
          { ...params, model: getSelectedModel(ctx), effort: getSelectedEffort() },
          signal,
          (partial) => {
            dashboard.update(partial.details);
            onUpdate?.(partial);
          },
          dashboard,
        );
        dashboard.update(result.details);
        return { content: [{ type: "text", text: result.text }], details: result.details };
      } catch (error) {
        const message = commandErrorMessage(error);
        dashboard.fail(message);
        notifyPlannerBuilder(`Plan create failed: ${message}`);
        throw error;
      }
    },
    renderCall(args, theme) {
      const path = args.path?.trim() || "new plan";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("plan_file_create"))} ${theme.fg("accent", path)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as unknown;
      if (isPlanBuildDetails(details)) return renderPlanBuildDetails(details, expanded, theme);

      const text = result.content
        .filter((item): item is TextContent => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n");
      return new Text(text || "(no output)", 0, 0);
    },
  });

  pi.registerTool({
    name: "plan_file_build",
    label: "Build Plan File",
    description:
      "Run builder agents with the model and effort selected in the main pi process for ready tasks in a planner-created plan file. Independent tasks run in parallel Jujutsu workspaces created with `jj workspace add`, then are integrated serially onto the main workspace. Set runVerifier to true to run the verifier agent afterward and write .pi/outputs/findings.html.",
    promptSnippet: "Run builder agents with the current model and effort in separate Jujutsu workspaces; optionally run verifier afterward.",
    promptGuidelines: [
      "Use plan_file_build when the user asks builder agents to implement tasks from a plan file.",
      "Use plan_file_build only after a plan file exists, usually from plan_file_create.",
      "plan_file_build uses `jj workspace add` to create separate Jujutsu workspaces for independent tasks, manages each builder subprocess from the main pane, requires one atomic Jujutsu (jj) commit per task, and integrates completed commits serially.",
      "Set plan_file_build runVerifier to true only when the user explicitly asks for verifier-agent review; verification is skipped by default.",
      "To trigger verifier review after a completed build, call plan_file_build again for the same plan with runVerifier true; completed tasks are skipped.",
    ],
    parameters: PlanBuildParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const dashboard = startBuildDashboard(ctx, params.path);
      try {
        const result = await buildPlanFile(
          ctx,
          { ...params, model: getSelectedModel(ctx), effort: getSelectedEffort() },
          signal,
          (partial) => {
            dashboard.update(partial.details);
            onUpdate?.(partial);
          },
        );
        dashboard.update(result.details);
        return { content: [{ type: "text", text: result.text }], details: result.details };
      } catch (error) {
        const message = commandErrorMessage(error);
        dashboard.fail(message);
        notifyPlannerBuilder(`Plan build failed: ${message}`);
        throw error;
      }
    },
    renderCall(args, theme) {
      const path = args.path?.trim() || "...";
      const taskCount = args.taskIds?.length ? ` · ${args.taskIds.length} selected task${args.taskIds.length === 1 ? "" : "s"}` : "";
      const verification = args.runVerifier ? " · verifier" : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("plan_file_build"))} ${theme.fg("accent", path)}${theme.fg("muted", `${taskCount}${verification}`)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as unknown;
      if (isPlanBuildDetails(details)) return renderPlanBuildDetails(details, expanded, theme);

      const text = result.content
        .filter((item): item is TextContent => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n");
      return new Text(text || "(no output)", 0, 0);
    },
  });

  pi.registerTool({
    name: "plan_file_list",
    label: "List Plan Files",
    description: "List recent planner-builder plan files in .pi/plans.",
    parameters: PlanListParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const plans = await listPlanFiles(ctx.cwd, Math.floor(params.limit ?? 10));
      const text = plans.length
        ? plans.map((plan) => `${plan.path} (${plan.taskCount} task${plan.taskCount === 1 ? "" : "s"})`).join("\n")
        : `No plan files found in ${DEFAULT_PLAN_DIR}.`;
      return { content: [{ type: "text", text }], details: { plans } };
    },
  });

  pi.registerCommand("plan-create", {
    description: "Run the planner agent with the current model and effort, surface material questions, and create a plan file. Usage: /plan-create <request>",
    handler: async (args, ctx) => {
      const request = args.trim() || (ctx.hasUI ? await ctx.ui.editor("Plan request:", "") : undefined);
      if (!request?.trim()) {
        ctx.ui.notify("Usage: /plan-create <request>", "warning");
        return;
      }

      const run = async () => {
        let progress: ReturnType<typeof startCommandProgress> | undefined;
        let dashboard: PlanBuildDashboard | undefined;

        try {
          progress = startCommandProgress(ctx, "planner-builder", ctx.isIdle() ? "planning..." : "waiting for current turn...", {
            onLog: ctx.hasUI ? (text) => sendCommandProgressMessage(pi, ctx, "/plan-create", text) : undefined,
          });

          if (!ctx.isIdle()) {
            ctx.ui.notify("/plan-create queued; waiting for the current turn to finish.", "info");
            await ctx.waitForIdle();
            progress.log("Current turn finished; starting planner agent.");
          } else {
            ctx.ui.notify("/plan-create started in the background.", "info");
            progress.log("Started planner agent in the background.");
          }

          dashboard = startBuildDashboard(ctx, "Creating plan...");
          progress.update("planning...");
          const result = await createPlanFile(
            ctx,
            { request, model: getSelectedModel(ctx), effort: getSelectedEffort() },
            undefined,
            (partial) => {
              dashboard?.update(partial.details);
              const statusText = statusTextFromUpdate(partial);
              if (statusText) progress?.update(statusText, { log: true });
            },
            dashboard,
          );
          dashboard.update(result.details);
          pi.sendMessage({ customType: "planner-builder", content: result.text, display: true, details: result.details });
          ctx.ui.notify(result.text, "info");
        } catch (error) {
          const message = commandErrorMessage(error);
          dashboard?.fail(message);
          pi.sendMessage({
            customType: "planner-builder",
            content: `/plan-create failed.\n\n${message}`,
            display: true,
            details: { error: message },
          });
          await notifyCommandError(ctx, error);
        } finally {
          progress?.stop();
        }
      };

      if (ctx.hasUI) {
        void run();
        return;
      }

      await run();
    },
  });

  pi.registerCommand("plan-build", {
    description: "Run builder agents with the current model and effort in parallel Jujutsu workspaces and integrate commits. Add --verify to run verifier afterward. Usage: /plan-build [--verify] [plan-file] [T01,T02]",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const runVerifier = tokens.includes("--verify");
      const positionalTokens = tokens.filter((token) => token !== "--verify");
      let planPath = positionalTokens.shift();
      let taskIds = parseTaskIds(positionalTokens.join(","));

      if (planPath && /^T\d+/i.test(planPath)) {
        taskIds = [planPath, ...taskIds];
        planPath = undefined;
      }

      if (!planPath) planPath = await latestPlanFile(ctx.cwd);

      if (!planPath) {
        ctx.ui.notify(`Usage: /plan-build [--verify] <plan-file> [T01,T02]. No files found in ${DEFAULT_PLAN_DIR}.`, "warning");
        return;
      }

      const resolvedPlanPath = planPath;
      const run = async () => {
        let progress: ReturnType<typeof startCommandProgress> | undefined;
        let dashboard: PlanBuildDashboard | undefined;

        try {
          progress = startCommandProgress(ctx, "planner-builder", ctx.isIdle() ? "building..." : "waiting for current turn...");

          if (!ctx.isIdle()) {
            ctx.ui.notify("/plan-build queued; waiting for the current turn to finish.", "info");
            await ctx.waitForIdle();
            progress.log("Current turn finished; starting builder agents.");
          } else {
            ctx.ui.notify("/plan-build started in the background.", "info");
            progress.log("Started builder agents in the background.");
          }

          dashboard = startBuildDashboard(ctx, resolvedPlanPath);
          progress.update("building...");
          const result = await buildPlanFile(
            ctx,
            { path: resolvedPlanPath, taskIds, runVerifier, model: getSelectedModel(ctx), effort: getSelectedEffort() },
            undefined,
            (partial) => {
              dashboard?.update(partial.details);
              const statusText = statusTextFromUpdate(partial);
              if (statusText) progress?.update(statusText, { log: true });
            },
          );
          dashboard.update(result.details);
          pi.sendMessage({ customType: "planner-builder", content: result.text, display: true, details: result.details });
          ctx.ui.notify(`Plan build finished for ${resolvedPlanPath}.`, "info");
        } catch (error) {
          const message = commandErrorMessage(error);
          dashboard?.fail(message);
          pi.sendMessage({
            customType: "planner-builder",
            content: `/plan-build failed.\n\n${message}`,
            display: true,
            details: { error: message },
          });
          await notifyCommandError(ctx, error);
        } finally {
          progress?.stop();
        }
      };

      if (ctx.hasUI) {
        void run();
        return;
      }

      await run();
    },
  });

  pi.registerCommand("plan-list", {
    description: "List recent planner-builder plan files.",
    handler: async (_args, ctx) => {
      const plans = await listPlanFiles(ctx.cwd, 10);
      const text = plans.length
        ? plans.map((plan) => `${plan.path} (${plan.taskCount} task${plan.taskCount === 1 ? "" : "s"})`).join("\n")
        : `No plan files found in ${DEFAULT_PLAN_DIR}.`;
      ctx.ui.notify(text, "info");
    },
  });

  pi.on("before_agent_start", (event) => {
    const activeTools = new Set(pi.getActiveTools());
    if (!activeTools.has("plan_file_create") && !activeTools.has("plan_file_build")) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\nPlanner-builder workflow:\n- Use plan_file_create when the user wants a planner agent to create a plan file for builder agents.\n- plan_file_create can pause to surface material planner questions through the parent pi UI and resume with the user's answers.\n- Use plan_file_build when the user wants builder agents to implement tasks from that plan file.\n- plan_file_build uses jj workspace add to create a separate Jujutsu workspace for each independent task.\n- plan_file_build runs builders in parallel as locally managed structured subprocesses in the main planner-builder pane and cancels/restarts stuck attempts.\n- plan_file_build requires one atomic Jujutsu (jj) commit for each completed task and integrates completed commits serially onto the main workspace.\n- Verifier-agent review is optional and skipped by default; set plan_file_build runVerifier to true only when the user explicitly asks for it. Calling it again for a completed plan skips done tasks and runs the requested review.\n- Plan files live in ${DEFAULT_PLAN_DIR} by default and contain machine-readable "### Task TNN:" blocks.`,
    };
  });
}
