import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { importPi } from "./pi-import";
import { createSubagentTool } from "../subagent/tool";
import { discoverAgents, type AgentConfig } from "../subagent/agents";
import { SUBAGENT_SESSION_LINK_ENTRY } from "../subagent/session-links";
import { webSearchTool } from "../tools/duckduckgo-search";
import { mountWelcomeBanner } from "../tui/welcome-banner";
import { createLogger } from "./logger";
import { mountPiEventLogger, type PiEventBus } from "./pi-event-logger";
import {
  defaultSkillDirectories,
  isDotAgentsSkillEnabled,
  resolveSkillDirectories,
} from "../subagent/skill-resolution";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface AssistantExtensionOptions {
  agentDir?: string;
  bundledAgentsDir?: string;
  bundledSkillsDir?: string;
  homeDir?: string;
}

function bundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
}

export interface LoadAssistantConfigOptions extends AssistantExtensionOptions {
  cwd: string;
  agentDir: string;
}

export async function loadAssistantConfig(options: LoadAssistantConfigOptions): Promise<AgentConfig> {
  const { agents } = await discoverAgents({
    cwd: options.cwd,
    agentDir: options.agentDir,
    bundledAgentsDir: options.bundledAgentsDir,
    bundledSkillsDir: options.bundledSkillsDir,
    homeDir: options.homeDir,
  });
  const assistant = agents.find((agent) => agent.name === "assistant");
  if (!assistant) throw new Error("Missing valid Assistant definition");
  return assistant;
}

export function createAssistantExtension(options: AssistantExtensionOptions = {}): InlineExtension {
  return async (pi) => {
    const { getAgentDir, SettingsManager } = await importPi();
    const agentDir = options.agentDir ?? getAgentDir();
    const controlledBundledSkillsDir = options.bundledSkillsDir ?? bundledSkillsDir();
    let current: { cwd: string; config: AgentConfig } | undefined;
    const resolveAssistant = async (cwd: string, refresh = false): Promise<AgentConfig> => {
      if (!refresh && current?.cwd === cwd) return current.config;
      const config = await loadAssistantConfig({
        cwd,
        agentDir,
        bundledAgentsDir: options.bundledAgentsDir,
        bundledSkillsDir: controlledBundledSkillsDir,
        homeDir: options.homeDir,
      });
      current = { cwd, config };
      return config;
    };
    pi.registerTool(createSubagentTool({
      persistSessionLink: (link) => pi.appendEntry(SUBAGENT_SESSION_LINK_ENTRY, link),
      agentProvider: async (cwd) => {
        const config = await resolveAssistant(cwd);
        const { agents } = await discoverAgents({
          cwd,
          agentDir,
          bundledAgentsDir: options.bundledAgentsDir,
          bundledSkillsDir: controlledBundledSkillsDir,
          homeDir: options.homeDir,
        });
        if (config.subagents === undefined) return agents;
        const allowed = new Set(config.subagents);
        return agents.filter((agent) => allowed.has(agent.name));
      },
    }));
    pi.registerTool(webSearchTool);
    mountWelcomeBanner(pi);
    const isRpcChild = process.env.EASYRESEARCH_RPC_CHILD === "1";
    if (!isRpcChild) {
      const logger = createLogger("assistant");
      mountPiEventLogger(pi as unknown as PiEventBus, logger);
      logger.info("assistant session started", { cwd: process.cwd() });
    }
    pi.on("session_start", async (_event, ctx) => {
      const config = await resolveAssistant(ctx.cwd, true);
      pi.setActiveTools(config.tools ?? pi.getAllTools().map(({ name }) => name));
    });
    pi.on("before_agent_start", async (event, ctx) => {
      const config = await resolveAssistant(ctx.cwd);
      return { systemPrompt: `${event.systemPrompt}\n\n${config.systemPrompt}` };
    });
    // ADR-018: project config is always trusted; suppress Pi's trust prompt.
    pi.on("project_trust", () => ({ trusted: "yes" as const }));
    pi.on("resources_discover", async (event) => {
      const config = await resolveAssistant(event.cwd);
      const deps = {
        cwd: event.cwd,
        agentDir,
        homeDir: options.homeDir,
        bundledSkillsDir: controlledBundledSkillsDir,
        enableDotAgentsSkill: isDotAgentsSkillEnabled(
          SettingsManager.create(event.cwd, agentDir).getGlobalSettings(),
        ),
      };
      return {
        skillPaths: config.skills === undefined
          ? defaultSkillDirectories(deps)
          : resolveSkillDirectories(config.skills, deps) ?? [],
      };
    });
  };
}

export default createAssistantExtension();
