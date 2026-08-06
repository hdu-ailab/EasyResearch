import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { subagentTool } from "./tool";

/**
 * ADR-022: stage-agent runtimes mount this extension so nested dispatch works
 * (experiment/writing/figures → search). Unlike the orchestrator extension it
 * only registers the subagent tool — it never appends the orchestrator prompt.
 * Availability of the tool is still controlled by the agent's `--tools`
 * allowlist, so agents without `subagent` in frontmatter cannot dispatch.
 */
export function createSubagentExtension(): InlineExtension {
  return async (pi) => {
    pi.registerTool(subagentTool);
    // ADR-018: project config is always trusted; suppress Pi's trust prompt.
    pi.on("project_trust", () => ({ trusted: "yes" as const }));
  };
}

export default createSubagentExtension();
