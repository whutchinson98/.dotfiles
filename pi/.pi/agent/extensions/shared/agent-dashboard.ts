import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import {
  type Component,
  Container,
  type Focusable,
  Input,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

const DEFAULT_MAXIMUM_VIEW_LINES = 30;

export type AgentDashboardStatus =
  | "starting"
  | "running"
  | "integrating"
  | "pending"
  | "in-progress"
  | "done"
  | "failed"
  | "blocked";

export interface AgentDashboardItem {
  id: string;
  title: string;
  agent: string;
  model?: string;
  status: AgentDashboardStatus;
  output: string;
  progress?: string;
  exitCode?: number;
  workspaceName?: string;
  workspacePath?: string;
  restartCount?: number;
}

export interface AgentDashboardData {
  path: string;
  agents: AgentDashboardItem[];
}

export interface AgentDashboardQuestion {
  agent?: string;
  question: string;
  options: Array<{
    label: string;
    description?: string;
  }>;
}

interface PendingAgentDashboardQuestion {
  request: AgentDashboardQuestion;
  selectedIndex: number;
  inputMode: boolean;
  input: Input;
  resolve: (answer: string | undefined) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

type DashboardView = "list" | "detail";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isAgentDashboardData(value: unknown): value is AgentDashboardData {
  return isRecord(value) && typeof value.path === "string" && Array.isArray(value.agents);
}

function isActiveStatus(status: AgentDashboardStatus): boolean {
  return status === "starting" || status === "running" || status === "integrating" || status === "in-progress";
}

function styledStatus(status: AgentDashboardStatus, theme: Theme): string {
  switch (status) {
    case "done":
      return theme.fg("success", status);
    case "failed":
      return theme.fg("error", status);
    case "blocked":
      return theme.fg("warning", status);
    case "starting":
    case "running":
    case "integrating":
    case "in-progress":
      return theme.fg("accent", status);
    default:
      return theme.fg("muted", status);
  }
}

function styledMarker(status: AgentDashboardStatus, theme: Theme): string {
  switch (status) {
    case "done":
      return theme.fg("success", "■");
    case "failed":
      return theme.fg("error", "■");
    case "blocked":
      return theme.fg("warning", "■");
    case "starting":
    case "running":
    case "integrating":
    case "in-progress":
      return theme.fg("accent", "■");
    default:
      return theme.fg("muted", "□");
  }
}

function styledModel(model: string | undefined, theme: Theme): string {
  return model ? ` ${theme.fg("muted", model)}` : "";
}

function compactText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function wrapOutput(text: string, width: number): string[] {
  if (!text.trim() || width <= 0) return [];

  return text
    .replace(/\r/g, "")
    .split("\n")
    .flatMap((line) => (line ? wrapTextWithAnsi(line, width) : [""]));
}

function wrapOutputTail(text: string, width: number, limit: number): { lines: string[]; omitted: number } {
  const lines = wrapOutput(text, width);
  const omitted = Math.max(0, lines.length - limit);
  return { lines: lines.slice(-limit), omitted };
}

function joinColumns(left: string, right: string, width: number, minimumLeftWidth = 20): string {
  if (!right || width <= minimumLeftWidth + 2) return truncateToWidth(left, width, "");

  const maximumRightWidth = Math.max(1, width - Math.min(minimumLeftWidth, width) - 2);
  const rightColumn = truncateToWidth(right, maximumRightWidth, "");
  const leftColumn = truncateToWidth(left, Math.max(1, width - visibleWidth(rightColumn) - 2), "");
  const spacing = " ".repeat(Math.max(2, width - visibleWidth(leftColumn) - visibleWidth(rightColumn)));
  return truncateToWidth(`${leftColumn}${spacing}${rightColumn}`, width, "");
}

function padToWidth(text: string, width: number): string {
  const fitted = truncateToWidth(text, width, "");
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function borderSegment(width: number, title: string, theme: Theme): string {
  const label = title ? ` ${truncateToWidth(title, Math.max(0, width - 3), "")} ` : "";
  const labelWidth = visibleWidth(label);
  return (
    theme.fg("borderMuted", "─") +
    (label ? theme.fg("text", label) : "") +
    theme.fg("borderMuted", "─".repeat(Math.max(0, width - 1 - labelWidth)))
  );
}

export function renderAgentDashboardDetails(details: AgentDashboardData, expanded: boolean, theme: Theme): Component {
  const container = new Container();
  const active = details.agents.filter((agent) => isActiveStatus(agent.status)).length;
  const done = details.agents.filter((agent) => agent.status === "done").length;
  const failed = details.agents.filter((agent) => agent.status === "failed" || agent.status === "blocked").length;
  const summary = [active ? `${active} active` : "", done ? `${done} done` : "", failed ? `${failed} attention` : ""]
    .filter(Boolean)
    .join(" · ");

  container.addChild(
    new Text(
      `${theme.fg("toolTitle", theme.bold("Subagents"))} ${theme.fg("accent", details.path)}${summary ? theme.fg("muted", ` · ${summary}`) : ""}`,
      0,
      0,
    ),
  );

  for (const agent of details.agents) {
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        `${theme.fg("muted", "── ")}${theme.fg("accent", agent.id)} ${theme.fg("toolTitle", agent.agent)}${styledModel(agent.model, theme)} ${styledStatus(agent.status, theme)}\n${theme.fg("dim", agent.title)}`,
        0,
        0,
      ),
    );

    if (agent.progress) container.addChild(new Text(theme.fg("muted", compactText(agent.progress, 180)), 0, 0));

    const lineLimit = expanded ? 80 : 6;
    const output = wrapOutputTail(agent.output, 120, lineLimit);
    if (output.omitted > 0) container.addChild(new Text(theme.fg("dim", `... ${output.omitted} earlier output lines`), 0, 0));
    if (output.lines.length > 0) container.addChild(new Text(theme.fg("toolOutput", output.lines.join("\n")), 0, 0));
  }

  if (!details.agents.length) container.addChild(new Text(theme.fg("muted", "Preparing agents..."), 0, 0));
  return container;
}

export class AgentDashboard {
  private details?: AgentDashboardData;
  private selectedIndex = 0;
  private view: DashboardView = "list";
  private detailScrollOffset = 0;
  private detailMaximumScrollOffset = 0;
  private detailPageSize = 1;
  private detailFollowsTail = true;
  private requestRender?: () => void;
  private finishView?: () => void;
  private error?: string;
  private focused = false;
  private pendingQuestion?: PendingAgentDashboardQuestion;

  constructor(_initialPath: string) {}

  update(details: AgentDashboardData): void {
    const selectedId = this.selectedAgent()?.id;
    this.details = details;
    this.error = undefined;

    if (selectedId) {
      const nextIndex = details.agents.findIndex((agent) => agent.id === selectedId);
      if (nextIndex >= 0) this.selectedIndex = nextIndex;
      else this.view = "list";
    }
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, details.agents.length - 1)));
    this.requestRender?.();
  }

  fail(error: string): void {
    this.error = error;
    this.requestRender?.();
  }

  isVisible(): boolean {
    return this.finishView !== undefined;
  }

  askQuestion(request: AgentDashboardQuestion, signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    if (this.pendingQuestion) return Promise.reject(new Error("The agent dashboard is already showing a question."));

    return new Promise((resolve) => {
      const input = new Input();
      const pendingQuestion: PendingAgentDashboardQuestion = {
        request,
        selectedIndex: 0,
        inputMode: request.options.length === 0,
        input,
        resolve,
        signal,
      };

      input.onSubmit = (answer) => {
        const trimmedAnswer = answer.trim();
        if (trimmedAnswer) this.finishQuestion(pendingQuestion, trimmedAnswer);
      };
      input.onEscape = () => {
        if (request.options.length > 0) {
          pendingQuestion.inputMode = false;
          input.setValue("");
          this.updateQuestionInputFocus();
          this.requestRender?.();
        } else {
          this.finishQuestion(pendingQuestion, undefined);
        }
      };

      if (signal) {
        pendingQuestion.onAbort = () => this.finishQuestion(pendingQuestion, undefined);
        signal.addEventListener("abort", pendingQuestion.onAbort, { once: true });
      }

      this.pendingQuestion = pendingQuestion;
      this.updateQuestionInputFocus();
      this.requestRender?.();
      if (signal?.aborted) pendingQuestion.onAbort?.();
    });
  }

  close(): void {
    if (this.pendingQuestion) this.finishQuestion(this.pendingQuestion, undefined);

    const finish = this.finishView;
    this.finishView = undefined;
    this.requestRender = undefined;
    finish?.();
  }

  createComponent(
    theme: Theme,
    requestRender: () => void,
    finishView: () => void,
    maximumViewLines: () => number = () => DEFAULT_MAXIMUM_VIEW_LINES,
  ): Component & Focusable & { dispose(): void } {
    this.requestRender = requestRender;
    this.finishView = finishView;
    const dashboard = this;

    return {
      get focused() {
        return dashboard.focused;
      },
      set focused(focused: boolean) {
        dashboard.focused = focused;
        dashboard.updateQuestionInputFocus();
      },
      render: (width) => this.render(width, theme, Math.max(8, maximumViewLines())),
      handleInput: (data) => this.handleInput(data),
      invalidate: () => this.pendingQuestion?.input.invalidate(),
      dispose: () => this.detach(),
    };
  }

  detach(): void {
    if (this.pendingQuestion) this.finishQuestion(this.pendingQuestion, undefined);
    this.focused = false;
    this.requestRender = undefined;
    this.finishView = undefined;
  }

  private finishQuestion(question: PendingAgentDashboardQuestion, answer: string | undefined): void {
    if (this.pendingQuestion !== question) return;

    if (question.onAbort) question.signal?.removeEventListener("abort", question.onAbort);
    question.input.focused = false;
    this.pendingQuestion = undefined;
    question.resolve(answer);
    this.requestRender?.();
  }

  private updateQuestionInputFocus(): void {
    if (!this.pendingQuestion) return;
    this.pendingQuestion.input.focused = this.focused && this.pendingQuestion.inputMode;
  }

  private selectedAgent(): AgentDashboardItem | undefined {
    return this.details?.agents[this.selectedIndex];
  }

  private select(offset: number): void {
    const agents = this.details?.agents ?? [];
    if (agents.length === 0) return;

    this.selectedIndex = (this.selectedIndex + offset + agents.length) % agents.length;
    this.requestRender?.();
  }

  private openSelectedAgent(): void {
    if (!this.selectedAgent()) return;

    this.view = "detail";
    this.detailScrollOffset = 0;
    this.detailMaximumScrollOffset = 0;
    this.detailFollowsTail = true;
    this.requestRender?.();
  }

  private showAgentList(): void {
    this.view = "list";
    this.requestRender?.();
  }

  private scrollDetail(offset: number): void {
    if (offset < 0) this.detailFollowsTail = false;
    this.detailScrollOffset = Math.max(0, Math.min(this.detailScrollOffset + offset, this.detailMaximumScrollOffset));
    if (this.detailScrollOffset === this.detailMaximumScrollOffset) this.detailFollowsTail = true;
    this.requestRender?.();
  }

  private handleInput(data: string): void {
    if (this.pendingQuestion) {
      this.handleQuestionInput(data, this.pendingQuestion);
      return;
    }

    if (matchesKey(data, "alt+x") || matchesKey(data, "ctrl+c") || data === "q") {
      this.close();
      return;
    }

    if (this.view === "detail") {
      if (data === "h" || matchesKey(data, "left") || matchesKey(data, "escape")) {
        this.showAgentList();
      } else if (data === "j" || matchesKey(data, "down")) {
        this.scrollDetail(1);
      } else if (data === "k" || matchesKey(data, "up")) {
        this.scrollDetail(-1);
      } else if (data === "g" || matchesKey(data, "home")) {
        this.detailFollowsTail = false;
        this.detailScrollOffset = 0;
        this.requestRender?.();
      } else if (data === "G" || matchesKey(data, "end")) {
        this.detailFollowsTail = true;
        this.detailScrollOffset = this.detailMaximumScrollOffset;
        this.requestRender?.();
      } else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
        this.scrollDetail(this.detailPageSize);
      } else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
        this.scrollDetail(-this.detailPageSize);
      }
      return;
    }

    if (data === "j" || matchesKey(data, "down")) {
      this.select(1);
    } else if (data === "k" || matchesKey(data, "up")) {
      this.select(-1);
    } else if (data === "l" || matchesKey(data, "right") || matchesKey(data, "enter")) {
      this.openSelectedAgent();
    } else if (matchesKey(data, "escape")) {
      this.close();
    }
  }

  private handleQuestionInput(data: string, question: PendingAgentDashboardQuestion): void {
    if (matchesKey(data, "alt+x")) {
      this.close();
      return;
    }
    if (matchesKey(data, "ctrl+c")) {
      this.finishQuestion(question, undefined);
      return;
    }

    if (question.inputMode) {
      question.input.handleInput(data);
      this.requestRender?.();
      return;
    }

    const optionCount = question.request.options.length + 1;
    if (data === "j" || matchesKey(data, "down")) {
      question.selectedIndex = (question.selectedIndex + 1) % optionCount;
      this.requestRender?.();
    } else if (data === "k" || matchesKey(data, "up")) {
      question.selectedIndex = (question.selectedIndex - 1 + optionCount) % optionCount;
      this.requestRender?.();
    } else if (matchesKey(data, "enter") || matchesKey(data, "right") || data === "l") {
      const selectedOption = question.request.options[question.selectedIndex];
      if (selectedOption) {
        this.finishQuestion(question, selectedOption.label);
      } else {
        question.inputMode = true;
        question.input.setValue("");
        this.updateQuestionInputFocus();
        this.requestRender?.();
      }
    } else if (matchesKey(data, "escape") || matchesKey(data, "left") || data === "h") {
      this.finishQuestion(question, undefined);
    }
  }

  private render(width: number, theme: Theme, maximumViewLines: number): string[] {
    if (width <= 0) return [];
    if (this.pendingQuestion) return this.renderQuestion(width, theme, maximumViewLines, this.pendingQuestion);
    if (this.view === "detail" && this.selectedAgent()) return this.renderAgentDetail(width, theme, maximumViewLines);
    return this.renderAgentList(width, theme, maximumViewLines);
  }

  private renderQuestion(
    width: number,
    theme: Theme,
    maximumViewLines: number,
    pending: PendingAgentDashboardQuestion,
  ): string[] {
    const { request } = pending;
    const lines: string[] = [];
    const push = (line: string) => lines.push(truncateToWidth(line, width, ""));
    const contentWidth = Math.max(1, width - 4);
    const agentName = request.agent?.trim() || "Agent";

    push(theme.fg("borderAccent", "─".repeat(width)));
    push(joinColumns(theme.fg("accent", theme.bold("Agent needs input")), theme.fg("muted", agentName), width, 20));

    const questionLineLimit = Math.max(1, Math.min(4, maximumViewLines - (pending.inputMode ? 7 : 6)));
    const wrappedQuestion = wrapTextWithAnsi(theme.fg("text", request.question), contentWidth);
    const visibleQuestion = wrappedQuestion.slice(0, questionLineLimit);
    if (wrappedQuestion.length > visibleQuestion.length && visibleQuestion.length > 0) {
      visibleQuestion[visibleQuestion.length - 1] = truncateToWidth(
        `${visibleQuestion[visibleQuestion.length - 1]} ${theme.fg("dim", "...")}`,
        contentWidth,
        "",
      );
    }
    for (const questionLine of visibleQuestion) push(`  ${questionLine}`);
    push("");

    if (pending.inputMode) {
      push(theme.fg("muted", "  Your answer:"));
      pending.input.focused = this.focused;
      const [inputLine = ""] = pending.input.render(contentWidth);
      push(`  ${inputLine}`);
      const cancelHint = request.options.length > 0 ? "Esc returns to choices" : "Esc cancels";
      push(theme.fg("dim", `  Enter sends answer · ${cancelHint} · Ctrl+C cancels`));
    } else {
      const options = [
        ...request.options,
        { label: "Write a different answer...", description: undefined },
      ];
      const availableOptionLines = Math.max(1, maximumViewLines - lines.length - 2);
      const firstVisibleIndex = Math.max(
        0,
        Math.min(pending.selectedIndex - Math.floor(availableOptionLines / 2), options.length - availableOptionLines),
      );
      const lastVisibleIndex = Math.min(options.length, firstVisibleIndex + availableOptionLines);

      for (let index = firstVisibleIndex; index < lastVisibleIndex; index++) {
        const option = options[index];
        const selected = index === pending.selectedIndex;
        const selector = selected ? theme.fg("accent", "❯") : " ";
        const label = selected ? theme.fg("accent", option.label) : theme.fg("text", option.label);
        const description = option.description ? theme.fg("muted", ` — ${option.description}`) : "";
        push(`  ${selector} ${index + 1}. ${label}${description}`);
      }

      push(theme.fg("dim", "  j/k or ↑/↓ select · enter sends · esc cancels"));
    }

    push(theme.fg("borderMuted", "─".repeat(width)));
    return lines.slice(0, maximumViewLines);
  }

  private renderAgentList(width: number, theme: Theme, maximumViewLines: number): string[] {
    const details = this.details;
    const agents = details?.agents ?? [];
    const settled = agents.filter((agent) => !isActiveStatus(agent.status) && agent.status !== "pending").length;
    const lines: string[] = [];
    const push = (line: string) => lines.push(truncateToWidth(line, width, ""));
    const innerWidth = Math.max(1, width - 2);
    const bodyHeight = Math.max(2, maximumViewLines - 4);
    const errorRows = this.error ? 1 : 0;
    const maximumVisibleAgents = Math.max(1, bodyHeight - errorRows);

    const headerLeft = theme.fg("accent", theme.bold("Subagents"));
    const headerRight = theme.fg("muted", `${agents.length} agent${agents.length === 1 ? "" : "s"}`);
    push(`  ${joinColumns(headerLeft, headerRight, Math.max(1, width - 4), 14)}  `);
    push(
      theme.fg("borderMuted", "╭") +
        borderSegment(innerWidth, `agents · ${settled}/${agents.length}`, theme) +
        theme.fg("borderMuted", "╮"),
    );

    const rows: string[] = [];
    if (this.error) rows.push(theme.fg("error", ` Build error: ${this.error}`));

    const firstVisibleIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(maximumVisibleAgents / 2), agents.length - maximumVisibleAgents),
    );
    const lastVisibleIndex = Math.min(firstVisibleIndex + maximumVisibleAgents, agents.length);

    for (let index = firstVisibleIndex; index < lastVisibleIndex; index++) {
      const agent = agents[index];
      const selected = index === this.selectedIndex;
      const selector = selected ? theme.fg("accent", "❯") : " ";
      const title = selected ? theme.fg("accent", agent.title) : theme.fg("text", agent.title);
      const left = ` ${selector} ${styledMarker(agent.status, theme)} ${title} ${theme.fg("dim", agent.id)}`;
      const right = [theme.fg("muted", agent.agent), styledModel(agent.model, theme).trim(), styledStatus(agent.status, theme)]
        .filter(Boolean)
        .join(theme.fg("dim", " · "));
      rows.push(joinColumns(left, `${right} `, innerWidth, 24));
    }

    if (agents.length === 0 && !this.error) rows.push(theme.fg("muted", "  Preparing agents..."));

    const divider = theme.fg("borderMuted", "│");
    for (let index = 0; index < bodyHeight; index++) {
      push(`${divider}${padToWidth(rows[index] ?? "", innerWidth)}${divider}`);
    }

    push(theme.fg("borderMuted", "╰") + theme.fg("borderMuted", "─".repeat(innerWidth)) + theme.fg("borderMuted", "╯"));
    push(theme.fg("dim", "  j/k or ↑/↓ select · enter/l/→ open · esc/q close · Alt+X toggle"));
    return lines;
  }

  private renderAgentDetail(width: number, theme: Theme, maximumViewLines: number): string[] {
    const agent = this.selectedAgent();
    if (!agent) return this.renderAgentList(width, theme, maximumViewLines);

    const lines: string[] = [];
    const push = (line: string) => lines.push(truncateToWidth(line, width, ""));
    const outputWidth = Math.max(1, width - 2);
    const output = wrapOutput(agent.output, outputWidth);
    const optionalRows = Number(Boolean(agent.progress)) + Number(Boolean(agent.workspaceName));
    const fixedLineCount = 8 + optionalRows;
    const maximumOutputLines = Math.max(1, maximumViewLines - fixedLineCount);
    this.detailPageSize = Math.max(1, maximumOutputLines - 1);
    this.detailMaximumScrollOffset = Math.max(0, output.length - maximumOutputLines);
    if (this.detailFollowsTail) this.detailScrollOffset = this.detailMaximumScrollOffset;
    else this.detailScrollOffset = Math.min(this.detailScrollOffset, this.detailMaximumScrollOffset);

    const visibleOutput = output.slice(this.detailScrollOffset, this.detailScrollOffset + maximumOutputLines);
    const earlierLines = this.detailScrollOffset;
    const laterLines = Math.max(0, output.length - this.detailScrollOffset - visibleOutput.length);

    push(theme.fg("borderAccent", "─".repeat(width)));
    push(joinColumns(`${theme.fg("accent", "‹ Subagents")} ${theme.fg("muted", "/")} ${theme.fg("accent", theme.bold(agent.id))}`, styledStatus(agent.status, theme), width, 18));
    push(theme.fg("toolTitle", theme.bold(agent.title)));
    push(`${styledMarker(agent.status, theme)} ${theme.fg("toolTitle", agent.agent)}${styledModel(agent.model, theme)}`);
    if (agent.progress) push(theme.fg("muted", compactText(agent.progress, Math.max(40, width))));
    if (agent.workspaceName) push(theme.fg("dim", `workspace ${agent.workspaceName}`));
    push(theme.fg("borderMuted", "─".repeat(width)));

    if (earlierLines > 0) push(theme.fg("dim", `  ... ${earlierLines} earlier output lines`));
    if (visibleOutput.length === 0) {
      push(theme.fg("dim", isActiveStatus(agent.status) ? "  (waiting for output)" : "  (no output)"));
      for (let index = 1; index < maximumOutputLines; index++) push("");
    } else {
      for (const outputLine of visibleOutput) push(`  ${theme.fg("toolOutput", outputLine)}`);
      for (let index = visibleOutput.length; index < maximumOutputLines; index++) push("");
    }
    if (laterLines > 0) push(theme.fg("dim", `  ... ${laterLines} later output lines`));
    else push("");

    push(theme.fg("dim", "  j/k or ↑/↓ scroll · g/G top/bottom · h/←/esc back · q close"));
    push(theme.fg("borderMuted", "─".repeat(width)));
    return lines.slice(0, maximumViewLines);
  }
}

export function showAgentDashboard(ctx: ExtensionContext, dashboard: AgentDashboard): void {
  if (ctx.mode !== "tui" || dashboard.isVisible()) return;

  void ctx.ui
    .custom<void>(
      (tui, theme, _keybindings, done) =>
        dashboard.createComponent(
          theme,
          () => tui.requestRender(),
          () => done(undefined),
          () => Math.max(6, tui.terminal.rows - 1),
        ),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "100%",
          maxHeight: "100%",
        },
      },
    )
    .catch((error) => {
      ctx.ui.notify(`Subagent dashboard failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    })
    .finally(() => dashboard.detach());
}

export function hideAgentDashboard(_ctx: ExtensionContext, dashboard: AgentDashboard): void {
  dashboard.close();
}
