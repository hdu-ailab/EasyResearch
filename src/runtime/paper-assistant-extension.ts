import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { importPi } from "./pi-import";
import { createSubagentTool } from "../subagent/tool";
import { discoverAgents, PAPER_ASSISTANT_AGENT, type AgentConfig } from "../subagent/agents";
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

export interface PaperAssistantExtensionOptions {
  agentDir?: string;
  bundledAgentsDir?: string;
  bundledSkillsDir?: string;
  homeDir?: string;
}

function bundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
}

export interface LoadPaperAssistantPromptOptions extends PaperAssistantExtensionOptions {
  cwd: string;
  agentDir: string;
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

export function createPaperAssistantExtension(options: PaperAssistantExtensionOptions = {}): InlineExtension {
  return async (pi) => {
    const { getAgentDir, SettingsManager } = await importPi();
    const agentDir = options.agentDir ?? getAgentDir();
    const controlledBundledSkillsDir = options.bundledSkillsDir ?? bundledSkillsDir();
    let current: { cwd: string; config: AgentConfig } | undefined;
    const resolvePaperAssistant = async (cwd: string, refresh = false): Promise<AgentConfig> => {
      if (!refresh && current?.cwd === cwd) return current.config;
      const config = await loadPaperAssistantPrompt({
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
        const config = await resolvePaperAssistant(cwd);
        const { agents } = await discoverAgents({
          cwd,
          agentDir,
          bundledAgentsDir: options.bundledAgentsDir,
          bundledSkillsDir: controlledBundledSkillsDir,
          homeDir: options.homeDir,
        });
        const specialists = agents.filter((agent) => agent.name !== PAPER_ASSISTANT_AGENT);
        if (config.subagents === undefined) return specialists;
        const allowed = new Set(config.subagents);
        return specialists.filter((agent) => allowed.has(agent.name));
      },
    }));
    pi.registerTool(webSearchTool);
    mountWelcomeBanner(pi);
    const isRpcChild = process.env.EASYRESEARCH_RPC_CHILD === "1";
    if (!isRpcChild) {
      const logger = createLogger("paper-assistant");
      mountPiEventLogger(pi as unknown as PiEventBus, logger);
      logger.info("paper-assistant session started", { cwd: process.cwd() });
    }
    pi.on("session_start", async (_event, ctx) => {
      const config = await resolvePaperAssistant(ctx.cwd, true);
      pi.setActiveTools(config.tools ?? pi.getAllTools().map(({ name }) => name));
    });
    pi.on("before_agent_start", async (event, ctx) => {
      const config = await resolvePaperAssistant(ctx.cwd);
      return { systemPrompt: `${event.systemPrompt}\n\n${config.systemPrompt}` };
    });
    // ADR-018: project config is always trusted; suppress Pi's trust prompt.
    pi.on("project_trust", () => ({ trusted: "yes" as const }));
    pi.on("resources_discover", async (event) => {
      const config = await resolvePaperAssistant(event.cwd);
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

export default createPaperAssistantExtension();
