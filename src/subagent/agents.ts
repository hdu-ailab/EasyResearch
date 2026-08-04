import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { getAgentsDir } from "../config";

export type AgentSource = "package" | "user";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
}

/**
 * Discover agents from the config root's agents dir, plus the agents bundled
 * with the lazypaper package. Bundled agents act as built-in defaults; user
 * agents in the config root with the same name override them.
 */
export function discoverAgents(userAgentsDir: string = getAgentsDir()): AgentDiscoveryResult {
  const map = new Map<string, AgentConfig>();

  // Bundled agents are defaults; user agents with the same name override them.
  for (const a of loadBundledAgents()) map.set(a.name, a);
  for (const a of loadFromDir(userAgentsDir, "user")) map.set(a.name, a);

  return { agents: Array.from(map.values()) };
}

function listMdFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((e) => e.endsWith(".md"));
}

function loadFromDir(dir: string, source: AgentSource): AgentConfig[] {
  const agents: AgentConfig[] = [];
  for (const name of listMdFiles(dir)) {
    const filePath = join(dir, name);
    const parsed = parseAgentFile(filePath, source);
    if (parsed) agents.push(parsed);
  }
  return agents;
}

function loadBundledAgents(): AgentConfig[] {
  const bundledDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "agents");
  return loadFromDir(bundledDir, "package");
}

function parseAgentFile(filePath: string, source: AgentSource): AgentConfig | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
  if (!frontmatter.name || !frontmatter.description) return null;
  const tools = frontmatter.tools
    ?.split(",")
    .map((t: string) => t.trim())
    .filter(Boolean);
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    tools: tools && tools.length > 0 ? tools : undefined,
    model: frontmatter.model,
    systemPrompt: body,
    source,
    filePath,
  };
}
