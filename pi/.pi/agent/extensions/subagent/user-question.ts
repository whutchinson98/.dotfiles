import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { type AgentDashboard, showAgentDashboard } from "../shared/agent-dashboard";
import { notify as sendSystemNotification } from "../system-notify";

export const USER_QUESTION_TOOL_NAME = "ask_user";

export interface UserQuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestionRequest {
  toolCallId: string;
  agentName?: string;
  question: string;
  options: UserQuestionOption[];
}

export interface UserQuestionResponse {
  status: "answered" | "cancelled" | "unavailable" | "error";
  answer?: string;
  message?: string;
}

export interface UserQuestionBridge {
  dir: string;
  extensionPath: string;
}

export type UserQuestionHandler = (
  request: UserQuestionRequest,
  signal: AbortSignal | undefined,
) => Promise<UserQuestionResponse>;

function questionBridgeExtensionSource(): string {
  return `import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@mariozechner/pi-ai";

const QuestionOption = Type.Object({
  label: Type.String({ description: "Short display label for this answer" }),
  description: Type.Optional(Type.String({ description: "Optional explanation of the tradeoff" })),
});

const QuestionParams = Type.Object({
  question: Type.String({ description: "One concise question whose answer materially affects the plan" }),
  options: Type.Optional(Type.Array(QuestionOption, {
    description: "Suggested answers when the decision has a small set of likely choices",
    maxItems: 8,
  })),
});

function responsePath(dir, toolCallId) {
  const safeId = toolCallId.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return path.join(dir, safeId + ".response.json");
}

async function waitForResponse(filePath, signal) {
  while (!signal?.aborted) {
    try {
      const content = await fs.promises.readFile(filePath, "utf8");
      await fs.promises.rm(filePath, { force: true });
      return JSON.parse(content);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  return { status: "cancelled", message: "The planning run was aborted while waiting for an answer." };
}

export default function (pi) {
  pi.registerTool({
    name: "${USER_QUESTION_TOOL_NAME}",
    label: "Ask User",
    description: "Ask the user one material planning question and wait for their answer. Use only when the answer would significantly change scope, architecture, or implementation details.",
    promptSnippet: "Ask the user a material planning question and wait for the answer.",
    promptGuidelines: [
      "Use ${USER_QUESTION_TOOL_NAME} only for decisions that materially affect the plan; investigate the repository first and avoid asking questions the codebase can answer.",
      "When ${USER_QUESTION_TOOL_NAME} reports that interaction is unavailable or cancelled, proceed with the safest reasonable assumption and state it in the plan.",
    ],
    parameters: QuestionParams,
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const bridgeDir = process.env.PI_USER_QUESTION_BRIDGE_DIR;
      if (!bridgeDir) {
        return {
          content: [{ type: "text", text: "User interaction is unavailable. Continue with the safest reasonable assumption and document it in the plan." }],
          details: { question: params.question, status: "unavailable" },
        };
      }

      const response = await waitForResponse(responsePath(bridgeDir, toolCallId), signal);
      if (response.status === "answered" && typeof response.answer === "string") {
        return {
          content: [{ type: "text", text: "User answered: " + response.answer }],
          details: { question: params.question, status: response.status, answer: response.answer },
        };
      }

      const fallback = response.message || "The user declined to answer. Continue with the safest reasonable assumption and document it in the plan.";
      return {
        content: [{ type: "text", text: fallback }],
        details: { question: params.question, status: response.status || "cancelled" },
      };
    },
  });
}
`;
}

function responsePath(dir: string, toolCallId: string): string {
  const safeId = toolCallId.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return path.join(dir, `${safeId}.response.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseUserQuestion(toolCallId: string, args: unknown, agentName?: string): UserQuestionRequest {
  const record = isRecord(args) ? args : {};
  const question = typeof record.question === "string" && record.question.trim()
    ? record.question.trim()
    : "The planner requested additional input.";
  const rawOptions = Array.isArray(record.options) ? record.options : [];
  const options = rawOptions.flatMap((option): UserQuestionOption[] => {
    if (typeof option === "string" && option.trim()) return [{ label: option.trim() }];
    if (!isRecord(option) || typeof option.label !== "string" || !option.label.trim()) return [];

    const description = typeof option.description === "string" && option.description.trim()
      ? option.description.trim()
      : undefined;
    return [{ label: option.label.trim(), description }];
  });

  return { toolCallId, agentName, question, options };
}

export async function createUserQuestionBridge(): Promise<UserQuestionBridge> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-user-question-"));
  const extensionPath = path.join(dir, "user-question-bridge.ts");

  await withFileMutationQueue(extensionPath, async () => {
    await fs.promises.writeFile(extensionPath, questionBridgeExtensionSource(), { encoding: "utf8", mode: 0o600 });
  });

  return { dir, extensionPath };
}

export async function writeUserQuestionResponse(
  bridgeDir: string,
  toolCallId: string,
  response: UserQuestionResponse,
): Promise<void> {
  const finalPath = responsePath(bridgeDir, toolCallId);
  const temporaryPath = `${finalPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;

  await fs.promises.writeFile(temporaryPath, JSON.stringify(response), { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(temporaryPath, finalPath);
}

export async function removeUserQuestionBridge(bridge: UserQuestionBridge | undefined): Promise<void> {
  if (!bridge) return;
  await fs.promises.rm(bridge.dir, { recursive: true, force: true });
}

export async function surfaceUserQuestion(
  ctx: ExtensionContext,
  request: UserQuestionRequest,
  signal: AbortSignal | undefined,
  dashboard?: AgentDashboard,
): Promise<UserQuestionResponse> {
  if (!ctx.hasUI) {
    return {
      status: "unavailable",
      message: "User interaction is unavailable in this mode. Continue with the safest reasonable assumption and document it in the plan.",
    };
  }

  const agentName = request.agentName?.trim() || "Agent";
  sendSystemNotification(request.question, `Pi ${agentName} question`);

  if (ctx.mode === "tui" && dashboard) {
    showAgentDashboard(ctx, dashboard);
    const answer = await dashboard.askQuestion(
      {
        agent: agentName,
        question: request.question,
        options: request.options,
      },
      signal,
    );

    if (!answer?.trim()) {
      return {
        status: "cancelled",
        message: "The user declined to answer. Continue with the safest reasonable assumption and document it in the plan.",
      };
    }

    return { status: "answered", answer: answer.trim() };
  }

  const title = `${agentName} question: ${request.question}`;
  if (request.options.length === 0) {
    const answer = await ctx.ui.input(title, "Type your answer", { signal });
    if (!answer?.trim()) {
      return {
        status: "cancelled",
        message: "The user declined to answer. Continue with the safest reasonable assumption and document it in the plan.",
      };
    }

    return { status: "answered", answer: answer.trim() };
  }

  const displayOptions = request.options.map((option, index) => {
    const description = option.description ? ` — ${option.description}` : "";
    return `${index + 1}. ${option.label}${description}`;
  });
  const customAnswerOption = "Write a different answer...";
  const selected = await ctx.ui.select(title, [...displayOptions, customAnswerOption], { signal });

  if (!selected) {
    return {
      status: "cancelled",
      message: "The user declined to answer. Continue with the safest reasonable assumption and document it in the plan.",
    };
  }

  if (selected === customAnswerOption) {
    const answer = await ctx.ui.input(title, "Type your answer", { signal });
    if (!answer?.trim()) {
      return {
        status: "cancelled",
        message: "The user declined to answer. Continue with the safest reasonable assumption and document it in the plan.",
      };
    }

    return { status: "answered", answer: answer.trim() };
  }

  const selectedIndex = displayOptions.indexOf(selected);
  const answer = request.options[selectedIndex]?.label;
  if (!answer) {
    return { status: "error", message: "The selected agent answer could not be resolved; use the safest reasonable assumption." };
  }

  return { status: "answered", answer };
}
