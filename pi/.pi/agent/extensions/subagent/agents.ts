import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  includeExtensions?: boolean;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  userAgentsDir: string;
  projectAgentsDir: string | null;
}

type AgentFrontmatter = Record<string, unknown>;

function getString(frontmatter: AgentFrontmatter, key: string): string | undefined {
  const value = frontmatter[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getBoolean(frontmatter: AgentFrontmatter, key: string): boolean | undefined {
  const value = frontmatter[key];
  return typeof value === "boolean" ? value : undefined;
}

function getTools(frontmatter: AgentFrontmatter): string[] | undefined {
  const value = frontmatter.tools;

  if (typeof value === "string") {
    const tools = value
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean);
    return tools.length > 0 ? tools : undefined;
  }

  if (Array.isArray(value)) {
    const tools = value
      .filter((tool): tool is string => typeof tool === "string")
      .map((tool) => tool.trim())
      .filter(Boolean);
    return tools.length > 0 ? tools : undefined;
  }

  return undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
    const name = getString(frontmatter, "name");
    const description = getString(frontmatter, "description");

    if (!name || !description) continue;

    agents.push({
      name,
      description,
      tools: getTools(frontmatter),
      model: getString(frontmatter, "model"),
      includeExtensions: getBoolean(frontmatter, "includeExtensions"),
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;

  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const userAgentsDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const userAgents = scope === "project" ? [] : loadAgentsFromDir(userAgentsDir, "user");
  const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

  const agentsByName = new Map<string, AgentConfig>();

  if (scope === "both") {
    for (const agent of userAgents) agentsByName.set(agent.name, agent);
    for (const agent of projectAgents) agentsByName.set(agent.name, agent);
  } else {
    for (const agent of scope === "project" ? projectAgents : userAgents) {
      agentsByName.set(agent.name, agent);
    }
  }

  const agents = Array.from(agentsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
  return { agents, userAgentsDir, projectAgentsDir };
}

export function formatAgent(agent: AgentConfig): string {
  const tools = agent.tools?.length ? agent.tools.join(",") : "default";
  const model = agent.model ? `, model: ${agent.model}` : "";
  const extensions = agent.includeExtensions ? ", extensions: enabled" : "";
  return `${agent.name} (${agent.source}): ${agent.description} [tools: ${tools}${model}${extensions}]`;
}

export function formatAgentList(agents: AgentConfig[], maxItems = 20): string {
  if (agents.length === 0) return "none";

  const listed = agents.slice(0, maxItems).map(formatAgent);
  const remaining = agents.length - listed.length;
  if (remaining > 0) listed.push(`... ${remaining} more`);

  return listed.join("\n");
}
