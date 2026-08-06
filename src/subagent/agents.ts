import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { getAgentsDir } from "../runtime/pi-import";

export type AgentSource = "global";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  /** Agents this agent may dispatch via the subagent tool; absent = all (ADR-022). */
  subagents?: string[];
  model?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
}

/**
 * Discover agents from the LazyResearch global agents dir
 * (`<agent-dir>/agents`, bootstrapped with bundled defaults on first run).
 * Users edit or replace these files; definitions are global, never packaged.
 */
export function discoverAgents(userAgentsDir: string = getAgentsDir()): AgentDiscoveryResult {
  return { agents: loadFromDir(userAgentsDir, "global") };
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
  const subagents = frontmatter.subagents
    ?.split(",")
    .map((a: string) => a.trim())
    .filter(Boolean);
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    tools: tools && tools.length > 0 ? tools : undefined,
    subagents: subagents && subagents.length > 0 ? subagents : undefined,
    model: frontmatter.model,
    systemPrompt: body,
    source,
    filePath,
  };
}
