import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createSubagentTool, formatSubagentDescription } from "../../subagent/tool";
import { discoverAgents } from "../../subagent/agents";
import type { AgentConfig } from "../../subagent/agents";
import { SUBAGENT_SESSION_LINK_ENTRY } from "../../subagent/session-links";
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
  callerAgent?: string;
  allowedSubagents?: string[];
  /** Coordinator (main session) SessionManager so nested dispatch shares the
   * agent-id alias counters with the main session (ADR-084). */
  ownerSessionManager?: unknown;
}

export function createSubagentExtension(options: SubagentExtensionOptions = {}): InlineExtension {
  return async (pi) => {
    const agentProvider = async (cwd: string): Promise<AgentConfig[]> => {
      const specialists = (await discoverAgents({ cwd })).agents.filter(
        (agent) => agent.enabled && agent.name !== "paper-assistant" && agent.name !== options.callerAgent,
      );
      if (options.allowedSubagents === undefined) return specialists;
      const allowed = new Set(options.allowedSubagents);
      return specialists.filter((agent) => allowed.has(agent.name));
    };
    const register = async (available: AgentConfig[]) => {
      pi.registerTool(createSubagentTool({
        persistSessionLink: (link) => pi.appendEntry(SUBAGENT_SESSION_LINK_ENTRY, link),
        ...(options.ownerSessionManager ? { coordinator: options.ownerSessionManager } : {}),
        ...(options.callerAgent || options.allowedSubagents ? { agentProvider } : {}),
        description: formatSubagentDescription(available.map((agent) => agent.name)),
      }));
    };
    if (options.allowedSubagents === undefined || options.allowedSubagents.length > 0) {
      await register([]);
      pi.on("session_start", async (_event, ctx) => {
        await register(await agentProvider(ctx.cwd));
      });
    }
    const logger = createLogger("stage-agent");
    mountPiEventLogger(pi as unknown as PiEventBus, logger);
    logger.info("stage agent runtime started", { cwd: process.cwd() });
    // ADR-018: project config is always trusted; suppress Pi's trust prompt.
    pi.on("project_trust", () => ({ trusted: "yes" as const }));
  };
}

export default createSubagentExtension();
