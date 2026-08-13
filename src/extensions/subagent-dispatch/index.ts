import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createSubagentTool } from "../../subagent/tool";
import { discoverAgents, PAPER_ASSISTANT_AGENT } from "../../subagent/agents";
import { SUBAGENT_SESSION_LINK_ENTRY } from "../../subagent/session-links";
import {
  createPaperAssistantConfigResolver,
  type PaperAssistantConfigResolverOptions,
} from "../pa-config";

/**
 * ADR-063: atomic extension registering the `subagent` dispatch tool for the
 * Paper Assistant runtime. The `agentProvider` filters specialists by the
 * effective paper-assistant definition's `subagents` allowlist (ADR-022/035);
 * the sibling duties that used to live in the monolithic paper-assistant
 * extension now live in their own atomic extensions.
 */
export function createSubagentDispatchExtension(options: PaperAssistantConfigResolverOptions = {}): InlineExtension {
  return async (pi) => {
    const resolver = createPaperAssistantConfigResolver(options);
    pi.registerTool(createSubagentTool({
      persistSessionLink: (link) => pi.appendEntry(SUBAGENT_SESSION_LINK_ENTRY, link),
      agentProvider: async (cwd) => {
        const config = await resolver.resolve(cwd);
        const { agents } = await discoverAgents({
          cwd,
          agentDir: resolver.agentDir,
          bundledAgentsDir: resolver.bundledAgentsDir,
          bundledSkillsDir: resolver.bundledSkillsDir,
          homeDir: resolver.homeDir,
        });
        const specialists = agents.filter((agent) => agent.name !== PAPER_ASSISTANT_AGENT);
        if (config.subagents === undefined) return specialists;
        const allowed = new Set(config.subagents);
        return specialists.filter((agent) => allowed.has(agent.name));
      },
    }));
  };
}

export default createSubagentDispatchExtension();
