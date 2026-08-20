import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createSubagentTool, formatSubagentDescription } from "../../subagent/tool";
import { discoverAgents, PAPER_ASSISTANT_AGENT } from "../../subagent/agents";
import type { AgentCatalog, SubagentCoordinator } from "../../subagent/coordinator";
import type { SubagentSupervisor } from "../../subagent/supervisor";
import {
  createPaperAssistantConfigResolver,
  type PaperAssistantConfigResolverOptions,
} from "../pa-config";

/**
 * ADR-063: atomic extension registering the `subagent` dispatch tool for the
 * Paper Assistant runtime. Each extension instance closes over the coordinator
 * and direct-child supervisor owned by one root AgentSession.
 */
export interface SubagentDispatchExtensionOptions extends PaperAssistantConfigResolverOptions {
  coordinator: SubagentCoordinator;
  supervisor: SubagentSupervisor;
}

export function createSubagentDispatchExtension(options: SubagentDispatchExtensionOptions): InlineExtension {
  return async (pi) => {
    const resolver = createPaperAssistantConfigResolver(options);
    const resolveCatalog = async (cwd: string): Promise<{ catalog: AgentCatalog; leaf: boolean }> => {
      const config = await resolver.resolve(cwd);
      const { agents } = await discoverAgents({
        cwd,
        agentDir: resolver.agentDir,
        bundledAgentsDir: resolver.bundledAgentsDir,
        bundledSkillsDir: resolver.bundledSkillsDir,
        homeDir: resolver.homeDir,
      });
      const all = agents;
      const allowed = config.subagents === undefined ? undefined : new Set(config.subagents);
      const available = all.filter((agent) =>
        agent.enabled
        && agent.name !== PAPER_ASSISTANT_AGENT
        && (allowed === undefined || allowed.has(agent.name)));
      return { catalog: { all, available }, leaf: config.subagents?.length === 0 };
    };
    pi.on("session_start", async (_event, ctx) => {
      const { catalog, leaf } = await resolveCatalog(ctx.cwd);
      if (leaf) return;
      pi.registerTool(createSubagentTool({
        coordinator: options.coordinator,
        supervisor: options.supervisor,
        catalog,
        description: formatSubagentDescription(catalog.available.map((agent) => agent.name)),
      }));
    });
  };
}
