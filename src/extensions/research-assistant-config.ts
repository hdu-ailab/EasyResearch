import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../runtime/pi-import";
import { discoverAgents, RESEARCH_ASSISTANT_AGENT, type AgentConfig } from "../subagent/agents";

export interface ResearchAssistantConfigResolverOptions {
  agentDir?: string;
  bundledAgentsDir?: string;
  bundledSkillsDir?: string;
  homeDir?: string;
}

export interface LoadResearchAssistantPromptOptions extends ResearchAssistantConfigResolverOptions {
  cwd: string;
  agentDir: string;
}

function bundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
}

export async function loadResearchAssistantPrompt(options: LoadResearchAssistantPromptOptions): Promise<AgentConfig> {
  const { agents } = await discoverAgents({
    cwd: options.cwd,
    agentDir: options.agentDir,
    bundledAgentsDir: options.bundledAgentsDir,
    bundledSkillsDir: options.bundledSkillsDir,
    homeDir: options.homeDir,
  });
  const researchAssistant = agents.find((agent) => agent.name === RESEARCH_ASSISTANT_AGENT);
  if (!researchAssistant) throw new Error("Missing valid Research Assistant definition");
  return researchAssistant;
}

/** Effective discovery directories a resolver instance is bound to. */
export interface ResearchAssistantConfigResolver {
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
export function createResearchAssistantConfigResolver(
  options: ResearchAssistantConfigResolverOptions = {},
): ResearchAssistantConfigResolver {
  const agentDir = options.agentDir ?? getAgentDir();
  const effectiveBundledSkillsDir = options.bundledSkillsDir ?? bundledSkillsDir();

  return {
    agentDir,
    bundledAgentsDir: options.bundledAgentsDir,
    bundledSkillsDir: effectiveBundledSkillsDir,
    homeDir: options.homeDir,
    resolve(cwd: string): Promise<AgentConfig> {
      return loadResearchAssistantPrompt({
        cwd,
        agentDir,
        bundledAgentsDir: options.bundledAgentsDir,
        bundledSkillsDir: effectiveBundledSkillsDir,
        homeDir: options.homeDir,
      });
    },
  };
}
