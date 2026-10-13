import { Container, Text, type Component } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  AgentDashboard,
  type AgentDashboardData,
  type AgentDashboardItem,
  type AgentDashboardStatus,
  hideAgentDashboard,
  isAgentDashboardData,
  renderAgentDashboardDetails,
  showAgentDashboard,
} from "../shared/agent-dashboard";
import type { GuidanceResult } from "./build-controller.ts";
import type { SessionMapping, SupervisionMode, TaskPhase } from "./build-state.ts";
import type { SupervisorStatus } from "./supervisor.ts";

export type AgentDisplayStatus = AgentDashboardStatus;
export type PlanBuildAgentDetails = AgentDashboardItem;
export interface PlanBuildDashboardData extends AgentDashboardData {
  supervision?: {
    runId: string;
    mode: SupervisionMode;
    agent: string;
    status: SupervisorStatus["state"] | "off" | "starting";
    disableReason?: string;
    runDirectory?: string;
    journalPath?: string;
    supervisor?: SupervisorStatus;
    supervisorSession?: SessionMapping;
    attempts: Array<{
      taskId: string;
      attemptId: string;
      attemptNumber: number;
      phase: TaskPhase;
      humanWait: boolean;
      session?: SessionMapping;
      controls: GuidanceResult[];
    }>;
  };
}
export const DASHBOARD_CONTROL_HELP = "Dashboard close/toggle does not cancel. Use /plan-cancel <runId>. Closing a question declines only that question.";

export function isPlanBuildDetails(value: unknown): value is PlanBuildDashboardData {
  return isAgentDashboardData(value);
}

function projectDetails(details: PlanBuildDashboardData): AgentDashboardData {
  const supervision = details.supervision;
  if (!supervision) return details;
  const agents = details.agents.map((agent) => {
    const attempt = supervision.attempts.find((item) => item.taskId === agent.id);
    if (!attempt) return agent;
    const controls = attempt.controls.map((control) => `${control.controlId}: ${control.status}${control.detail ? ` (${control.detail})` : ""}`);
    return { ...agent, title: `${agent.title} | attempt ${attempt.attemptNumber}: ${attempt.attemptId}`,
      progress: [attempt.humanWait ? "Awaiting human (watchdog paused)" : "", agent.progress].filter(Boolean).join(" | "),
      output: [agent.output, `Attempt: ${attempt.attemptId} (${attempt.phase})`,
        attempt.session?.sessionFile ? `Session: ${attempt.session.sessionFile}` : "", ...controls].filter(Boolean).join("\n") };
  });
  let status: AgentDisplayStatus = "running";
  if (supervision.status === "off" || supervision.status === "stopped") status = "done";
  if (supervision.disableReason) status = "blocked";
  agents.push({ id: "SUPERVISION", title: `Run ${supervision.runId}`, agent: supervision.agent,
    status,
    progress: `${supervision.mode}: ${supervision.status}${supervision.supervisor ? `; ${supervision.supervisor.reviews} reviews, ${supervision.supervisor.tokens} tokens` : ""}`,
    output: [supervision.disableReason, `Journal: ${supervision.journalPath ?? "starting"}`,
      `Sessions: ${supervision.runDirectory ?? "ephemeral"}`, supervision.supervisorSession?.sessionFile, `/plan-inspect ${supervision.runId}`, `/plan-cancel ${supervision.runId}`].filter(Boolean).join("\n") });
  return { ...details, agents };
}

export function renderPlanBuildDetails(details: PlanBuildDashboardData, expanded: boolean, theme: Theme): Component {
  const container = new Container();
  container.addChild(renderAgentDashboardDetails(projectDetails(details), expanded, theme));
  container.addChild(new Text(theme.fg("muted", DASHBOARD_CONTROL_HELP), 0, 0));
  return container;
}

/** Keep the generic dashboard independent of planner lifecycle and control authority. */
export class PlanBuildDashboard extends AgentDashboard {
  override update(details: PlanBuildDashboardData): void { super.update(projectDetails(details)); }

  override createComponent(...args: Parameters<AgentDashboard["createComponent"]>): ReturnType<AgentDashboard["createComponent"]> {
    const component = super.createComponent(...args);
    const render = component.render.bind(component);
    component.render = (width) => {
      const maximumLines = args[3]?.() ?? 30;
      const help = new Text(args[0].fg("muted", DASHBOARD_CONTROL_HELP), 0, 0).render(width).slice(0, maximumLines);
      return [...render(width).slice(0, Math.max(0, maximumLines - help.length)), ...help];
    };
    return component;
  }
}

export { hideAgentDashboard as hidePlanBuildDashboard, showAgentDashboard as showPlanBuildDashboard };
