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
  resolve(cwd: string): Promise<AgentConfig>;
  agentDir: string;
  bundledAgentsDir?: string;
  bundledSkillsDir: string;
  homeDir?: string;
}

/**
 * Legacy dispatch resolver retained until Task 6 moves dispatch to the shared
 * live catalog. It deliberately does not cache Agent Markdown.
 */
export function createPaperAssistantConfigResolver(
  options: PaperAssistantConfigResolverOptions = {},
): PaperAssistantConfigResolver {
  const agentDir = options.agentDir ?? getAgentDir();
  const effectiveBundledSkillsDir = options.bundledSkillsDir ?? bundledSkillsDir();

  return {
    agentDir,
    bundledAgentsDir: options.bundledAgentsDir,
    bundledSkillsDir: effectiveBundledSkillsDir,
    homeDir: options.homeDir,
    resolve(cwd: string): Promise<AgentConfig> {
      return loadPaperAssistantPrompt({
        cwd,
        agentDir,
        bundledAgentsDir: options.bundledAgentsDir,
        bundledSkillsDir: effectiveBundledSkillsDir,
        homeDir: options.homeDir,
      });
    },
  };
}
