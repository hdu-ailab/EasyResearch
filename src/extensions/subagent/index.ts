import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createSubagentTool } from "../../subagent/tool";
import { SUBAGENT_SESSION_LINK_ENTRY } from "../../subagent/session-links";
import { createLogger } from "../../runtime/logger";
import { mountPiEventLogger, type PiEventBus } from "../../runtime/pi-event-logger";

/**
 * ADR-022: stage-agent runtimes mount this extension so nested dispatch works
 * (experiment/writing/figures → search). Unlike the Paper Assistant extension it
 * only registers the subagent tool — it never appends the Paper Assistant prompt.
 * Availability of the tool is still controlled by the agent's `--tools`
 * allowlist, so agents without `subagent` in frontmatter cannot dispatch.
 */
export function createSubagentExtension(): InlineExtension {
  return async (pi) => {
    pi.registerTool(createSubagentTool({
      persistSessionLink: (link) => pi.appendEntry(SUBAGENT_SESSION_LINK_ENTRY, link),
    }));
    const logger = createLogger("stage-agent");
    mountPiEventLogger(pi as unknown as PiEventBus, logger);
    logger.info("stage agent runtime started", { cwd: process.cwd() });
    // ADR-018: project config is always trusted; suppress Pi's trust prompt.
    pi.on("project_trust", () => ({ trusted: "yes" as const }));
    pi.on("session_start", () => {
      if (process.env.EASYRESEARCH_AGENT_TOOLS === "all") {
        pi.setActiveTools(pi.getAllTools().map(({ name }) => name));
      }
    });
  };
}

export default createSubagentExtension();
