import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { getAgentDir, importPi } from "../runtime/pi-import";
import {
  mergeAgentRegistry,
  parseAgentRegistry,
  type AgentRegistry,
  type AgentRegistryEntry,
} from "./registry";

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

/** The orchestrator's fixed session agent can never be disabled (ADR-034). */
export const ORCHESTRATOR_AGENT = "orchestrator";

function bundledRegistryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "agents.json");
}

function readBundledRegistry(): AgentRegistry {
  try {
    return parseAgentRegistry({ lazyresearch: { agents: JSON.parse(readFileSync(bundledRegistryPath(), "utf8")) } });
  } catch {
    return {};
  }
}

/** The two user registry layers for an exact cwd: project and global settings. */
async function readRegistryLayersForCwd(cwd?: string): Promise<{ global: AgentRegistry; project: AgentRegistry }> {
  const { SettingsManager } = await importPi();
  const manager = SettingsManager.create(cwd ?? process.cwd(), getAgentDir());
  return {
    global: parseAgentRegistry(manager.getGlobalSettings()),
    project: parseAgentRegistry(manager.getProjectSettings()),
  };
}

/**
 * `<project.settings>` over `<global.settings>` over the bundled default
 * registry (ADR-034). Pure and exported for tests: `mergeRegistryChain`
 * merges three explicit layers, lowest precedence first.
 */
export function mergeRegistryChain(bundled: AgentRegistry, global: AgentRegistry, project: AgentRegistry): AgentRegistry {
  return mergeAgentRegistry(mergeAgentRegistry(project, global), bundled);
}

/**
 * Resolves the effective registry for `discoverAgents`. An explicitly injected
 * `opts.registry` is treated as the complete effective registry (test
 * injection); otherwise the bundled `src/agents/agents.json` is the read-only
 * base layer merged under the merged project+global settings.
 */
function resolveMergedRegistry(opts: { registry?: AgentRegistry; bundled?: AgentRegistry; cwd?: string }): Promise<AgentRegistry> {
  if (opts.registry) return Promise.resolve(opts.registry);
  const bundled = opts.bundled ?? readBundledRegistry();
  return readRegistryLayersForCwd(opts.cwd).then(({ global, project }) => mergeRegistryChain(bundled, global, project));
}

function isDisabled(entry: AgentRegistryEntry | undefined, name: string): boolean {
  return entry?.disabled === true && name !== ORCHESTRATOR_AGENT;
}

export async function discoverAgents(opts: {
  agentDir?: string;
  registry?: AgentRegistry;
  bundled?: AgentRegistry;
  cwd?: string;
} = {}): Promise<AgentDiscoveryResult> {
  const agentDir = opts.agentDir ?? getAgentDir();
  const registry = await resolveMergedRegistry(opts);
  const agents: AgentConfig[] = [];
  for (const [name, entry] of Object.entries(registry)) {
    if (isDisabled(entry, name)) continue;
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
