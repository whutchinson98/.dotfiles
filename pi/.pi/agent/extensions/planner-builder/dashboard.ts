import type { Component } from "@mariozechner/pi-tui";
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

export type AgentDisplayStatus = AgentDashboardStatus;
export type PlanBuildAgentDetails = AgentDashboardItem;
export interface PlanBuildDashboardData extends AgentDashboardData {}

export function isPlanBuildDetails(value: unknown): value is PlanBuildDashboardData {
  return isAgentDashboardData(value);
}

export function renderPlanBuildDetails(details: PlanBuildDashboardData, expanded: boolean, theme: Theme): Component {
  return renderAgentDashboardDetails(details, expanded, theme);
}

export {
  AgentDashboard as PlanBuildDashboard,
  hideAgentDashboard as hidePlanBuildDashboard,
  showAgentDashboard as showPlanBuildDashboard,
};
