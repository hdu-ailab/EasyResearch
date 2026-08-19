import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { readAgentAliases } from "../../subagent/agent-alias";
import { readSubagentSessionLinks } from "../../subagent/session-links";
import {
  AGENT_STATUS_TYPE,
  SUBAGENT_COMPLETED_TYPE,
  SUBAGENT_ERRORED_TYPE,
  buildAgentStatus,
  formatAgentStatus,
  lastAgentStatusText,
  parseAgentStatus,
  readSubagentOutcomes,
} from "./status";

/**
 * ADR-082: Paper Assistant context status. Persists `easyresearch:subagent_completed`
 * (success) or `easyresearch:subagent_errored` (failure/abort) markers when the
 * `subagent` tool finishes and, on every `before_agent_start`, renders a
 * `<agent_status>` block (time + working/complete/error subagents) as a
 * `custom_message` (`display: false`) so each submission appends a frozen,
 * cache-friendly snapshot that is strictly model-visible. Outcome classification
 * also falls back to the persisted `subagent` `toolResult` transcript row so
 * children whose parent run aborted at the loop level (no `tool_execution_end`)
 * still leave Working. ADR-084: items carry agent ids only (`{"name":"search_0"}`),
 * resolved from the coordinator session's alias entries, never session paths.
 */
export function createAgentStatusExtension(options: { now?: () => string } = {}): InlineExtension {
  const now = options.now ?? (() => new Date().toLocaleString());
  return async (pi) => {
    pi.on("tool_execution_end", async (event) => {
      if (event.toolName !== "subagent") return;
      pi.appendEntry(event.isError ? SUBAGENT_ERRORED_TYPE : SUBAGENT_COMPLETED_TYPE, {
        toolCallId: event.toolCallId,
      });
    });

    pi.on("before_agent_start", async (_event, ctx) => {
      const entries = ctx.sessionManager.getEntries();
      const dispatched = readSubagentSessionLinks(entries);
      const outcomes = readSubagentOutcomes(entries);
      const previousText = lastAgentStatusText(entries);
      const aliases = readAgentAliases(entries);
      const idBySession = new Map<string, string>();
      for (const alias of aliases) idBySession.set(alias.sessionId, alias.id);
      const resolveId = (childSessionId: string) => idBySession.get(childSessionId);
      const snapshot = await buildAgentStatus({
        now: now(),
        dispatched,
        outcomes,
        previous: previousText ? parseAgentStatus(previousText) : undefined,
        resolveId,
      });
      const content = formatAgentStatus(snapshot);
      if (previousText === content) return {};
      return { message: { customType: AGENT_STATUS_TYPE, content, display: false } };
    });
  };
}

export default createAgentStatusExtension();
