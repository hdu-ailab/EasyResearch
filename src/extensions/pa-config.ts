import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../runtime/pi-import";
import { discoverAgents, PAPER_ASSISTANT_AGENT, type AgentConfig } from "../subagent/agents";

export interface PaperAssistantConfigResolverOptions {
  agentDir?: string;
  bundledAgentsDir?: string;
  bundledSkillsDir?: string;
  homeDir?: string;
}

export interface LoadPaperAssistantPromptOptions extends PaperAssistantConfigResolverOptions {
  cwd: string;
  agentDir: string;
}

function bundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
}

export async function loadPaperAssistantPrompt(options: LoadPaperAssistantPromptOptions): Promise<AgentConfig> {
  const { agents } = await discoverAgents({
    cwd: options.cwd,
    agentDir: options.agentDir,
    bundledAgentsDir: options.bundledAgentsDir,
    bundledSkillsDir: options.bundledSkillsDir,
    homeDir: options.homeDir,
  });
  const paperAssistant = agents.find((agent) => agent.name === PAPER_ASSISTANT_AGENT);
  if (!paperAssistant) throw new Error("Missing valid Paper Assistant definition");
  return paperAssistant;
}

/** Effective discovery directories a resolver instance is bound to. */
export interface PaperAssistantConfigResolver {
  resolve(cwd: string, refresh?: boolean): Promise<AgentConfig>;
  agentDir: string;
  bundledAgentsDir?: string;
  bundledSkillsDir: string;
  homeDir?: string;
}

/**
 * Cached resolver for the effective Paper Assistant definition. ADR-063: shared
 * by the definition-application extension and the subagent-dispatch extension;
 * each holder creates its own resolver instance so per-cwd cache state stays
 * independent, mirroring the pre-split single-extension behavior.
 */
export function createPaperAssistantConfigResolver(
  options: PaperAssistantConfigResolverOptions = {},
): PaperAssistantConfigResolver {
  const agentDir = options.agentDir ?? getAgentDir();
  const effectiveBundledSkillsDir = options.bundledSkillsDir ?? bundledSkillsDir();
  let current: { cwd: string; config: AgentConfig } | undefined;

  return {
    agentDir,
    bundledAgentsDir: options.bundledAgentsDir,
    bundledSkillsDir: effectiveBundledSkillsDir,
    homeDir: options.homeDir,
    async resolve(cwd: string, refresh = false): Promise<AgentConfig> {
      if (!refresh && current?.cwd === cwd) return current.config;
      const config = await loadPaperAssistantPrompt({
        cwd,
        agentDir,
        bundledAgentsDir: options.bundledAgentsDir,
        bundledSkillsDir: effectiveBundledSkillsDir,
        homeDir: options.homeDir,
      });
      current = { cwd, config };
      return config;
    },
  };
}
