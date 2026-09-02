import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mcpRemoteCommand, registerMcpBridge } from "./mcp_bridge/bridge";

const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";

export default function (pi: ExtensionAPI) {
  registerMcpBridge(pi, {
    serverName: "Linear",
    toolPrefix: "linear",
    ...mcpRemoteCommand(LINEAR_MCP_URL),
    startupTimeoutMs: 120_000,
    requestTimeoutMs: 60_000,
    promptGuidelines: [
      "Use linear_* tools when the user asks about Linear issues, projects, teams, cycles, comments, or statuses.",
      "Prefer read-only linear_* tools before mutating Linear data; summarize intended Linear changes before creating or updating issues unless the user explicitly requested the mutation.",
    ],
  });
}
