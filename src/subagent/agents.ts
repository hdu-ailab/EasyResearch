import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { getAgentDir, importPi } from "../runtime/pi-import";
import { mergeAgentRegistry, parseAgentRegistry, type AgentRegistry } from "./registry";

export type AgentSource = "global";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  /** Agents this agent may dispatch via the subagent tool; absent = all (ADR-022). */
  subagents?: string[];
  skills?: string[];
  model?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
}

async function readRegistryForCwd(cwd?: string): Promise<AgentRegistry> {
  const { SettingsManager } = await importPi();
  const manager = SettingsManager.create(cwd ?? process.cwd(), getAgentDir());
  return mergeAgentRegistry(parseAgentRegistry(manager.getProjectSettings()), parseAgentRegistry(manager.getGlobalSettings()));
}

export async function discoverAgents(opts: {
  agentDir?: string;
  registry?: AgentRegistry;
  cwd?: string;
} = {}): Promise<AgentDiscoveryResult> {
  const agentDir = opts.agentDir ?? getAgentDir();
  const registry = opts.registry ?? (await readRegistryForCwd(opts.cwd));
  const agents: AgentConfig[] = [];
  for (const [name, entry] of Object.entries(registry)) {
    const definitionPath = entry.definition ? resolveDefinition(agentDir, entry.definition) : join(agentDir, "agents", `${name}.md`);
    if (!existsSync(definitionPath)) continue;
    const parsed = parseAgentFile(definitionPath, name);
    if (!parsed) continue;
    agents.push({
      ...parsed,
      tools: entry.tools,
      skills: entry.skills,
      subagents: entry.subagents,
      model: entry.model,
    });
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));
  return { agents };
}

function resolveDefinition(agentDir: string, p: string): string {
  if (p.startsWith("~")) return join(homedir(), p.slice(1));
  if (p.startsWith("/")) return p;
  return join(agentDir, p);
}

function parseAgentFile(defPath: string, name: string): Pick<AgentConfig, "name" | "description" | "systemPrompt" | "source" | "filePath"> | null {
  let content: string;
  try {
    content = readFileSync(defPath, "utf-8");
  } catch {
    return null;
  }
  const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
  if (Object.keys(frontmatter).length === 0) return null;
  return {
    name,
    description: typeof frontmatter.description === "string" ? frontmatter.description : name,
    systemPrompt: body,
    source: "global",
    filePath: defPath,
  };
}
