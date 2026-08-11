import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createSubagentTool } from "./tool";
import { SUBAGENT_SESSION_LINK_ENTRY } from "./session-links";
import { webSearchTool } from "../tools/duckduckgo-search";
import { createLogger } from "../runtime/logger";
import { mountPiEventLogger, type PiEventBus } from "../runtime/pi-event-logger";

/**
 * ADR-022: stage-agent runtimes mount this extension so nested dispatch works
 * (experiment/writing/figures → search). Unlike the assistant extension it
 * only registers the subagent tool — it never appends the assistant prompt.
 * Availability of the tool is still controlled by the agent's `--tools`
 * allowlist, so agents without `subagent` in frontmatter cannot dispatch.
 */
export function createSubagentExtension(): InlineExtension {
  return async (pi) => {
    pi.registerTool(createSubagentTool({
      persistSessionLink: (link) => pi.appendEntry(SUBAGENT_SESSION_LINK_ENTRY, link),
    }));
    pi.registerTool(webSearchTool);
    const logger = createLogger("stage-agent");
    mountPiEventLogger(pi as unknown as PiEventBus, logger);
    logger.info("stage agent runtime started", { cwd: process.cwd() });
    // ADR-018: project config is always trusted; suppress Pi's trust prompt.
    pi.on("project_trust", () => ({ trusted: "yes" as const }));
  };
}

export default createSubagentExtension();
