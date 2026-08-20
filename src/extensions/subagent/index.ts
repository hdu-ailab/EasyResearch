import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createSubagentTool, formatSubagentDescription } from "../../subagent/tool";
import { discoverAgents, PAPER_ASSISTANT_AGENT } from "../../subagent/agents";
import type { SubagentCoordinator } from "../../subagent/coordinator";
import type { SubagentSupervisor } from "../../subagent/supervisor";
import { createLogger } from "../../runtime/logger";
import { mountPiEventLogger, type PiEventBus } from "../../runtime/pi-event-logger";

/**
 * ADR-022: stage-agent runtimes mount this extension so nested dispatch works
 * (experiment/writing/figures → search). Unlike the Paper Assistant extension it
 * only registers the subagent tool — it never appends the Paper Assistant prompt.
 * Availability of the tool is still controlled by the agent's effective
 * tools allowlist, so agents without `subagent` in frontmatter cannot dispatch.
 * The tool description's third line lists the caller's available subagents,
 * resolved at `session_start` from the caller's allowlist (ADR-084).
 */
export interface SubagentExtensionOptions {
  callerAgent: string;
  allowedSubagents?: string[];
  coordinator: SubagentCoordinator;
  supervisor: SubagentSupervisor;
  agentDir?: string;
  bundledAgentsDir?: string;
  bundledSkillsDir?: string;
  homeDir?: string;
}

export function createSubagentExtension(options: SubagentExtensionOptions): InlineExtension {
  return async (pi) => {
    if (options.allowedSubagents?.length !== 0) {
      pi.on("session_start", async (_event, ctx) => {
        const all = (await discoverAgents({
          cwd: ctx.cwd,
          agentDir: options.agentDir,
          bundledAgentsDir: options.bundledAgentsDir,
          bundledSkillsDir: options.bundledSkillsDir,
          homeDir: options.homeDir,
        })).agents;
        const allowed = options.allowedSubagents === undefined ? undefined : new Set(options.allowedSubagents);
        const available = all.filter((agent) =>
          agent.enabled
          && agent.name !== PAPER_ASSISTANT_AGENT
          && agent.name !== options.callerAgent
          && (allowed === undefined || allowed.has(agent.name)));
        pi.registerTool(createSubagentTool({
          coordinator: options.coordinator,
          supervisor: options.supervisor,
          catalog: { all, available },
          description: formatSubagentDescription(available.map((agent) => agent.name)),
        }));
      });
    }
    const logger = createLogger("stage-agent");
    mountPiEventLogger(pi as unknown as PiEventBus, logger);
    logger.info("stage agent runtime started", { cwd: process.cwd() });
    // ADR-018: project config is always trusted; suppress Pi's trust prompt.
    pi.on("project_trust", () => ({ trusted: "yes" as const }));
  };
}
