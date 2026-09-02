import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mcpRemoteCommand, registerMcpBridge } from "./mcp_bridge/bridge";

const PULUMI_MCP_URL = "https://mcp.ai.pulumi.com/mcp";

export default function (pi: ExtensionAPI) {
  registerMcpBridge(pi, {
    serverName: "Pulumi",
    toolPrefix: "pulumi",
    ...mcpRemoteCommand(PULUMI_MCP_URL),
    startupTimeoutMs: 120_000,
    requestTimeoutMs: 60_000,
    promptGuidelines: [
      "Use pulumi_* tools when the user asks about Pulumi infrastructure as code, Pulumi Cloud stacks/resources/policies/users, provider schemas, packages, or Pulumi Registry documentation.",
      "Prefer read-only pulumi_* tools before suggesting infrastructure changes; summarize intended Pulumi actions before using mutating tools unless the user explicitly requested the mutation.",
      "Do not use pulumi_deploy_to_aws or approve Pulumi Neo actions unless the user explicitly asks for deployment/automation and confirms the intended changes.",
    ],
  });
}
