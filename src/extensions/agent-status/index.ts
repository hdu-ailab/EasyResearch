import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { importPi } from "../../runtime/pi-import";
import { readSubagentSessionLinks } from "../../subagent/session-links";
import {
  AGENT_STATUS_TYPE,
  SUBAGENT_COMPLETED_TYPE,
  buildAgentStatus,
  formatAgentStatus,
  lastAgentStatusText,
  parseAgentStatus,
  readCompletedMarkers,
} from "./status";

/**
 * ADR-082: Paper Assistant context status. Persists `easyresearch:subagent_completed`
 * markers when the `subagent` tool finishes and, on every `before_agent_start`,
 * renders a `<agent_status>` block (time + working/complete subagents) as a
 * `custom_message` (`display: false`) so each submission appends a frozen,
 * cache-friendly snapshot that is strictly model-visible.
 */
export function createAgentStatusExtension(options: { now?: () => string } = {}): InlineExtension {
  const now = options.now ?? (() => new Date().toLocaleString());
  return async (pi) => {
    pi.on("tool_execution_end", async (event) => {
      if (event.toolName !== "subagent") return;
      pi.appendEntry(SUBAGENT_COMPLETED_TYPE, { toolCallId: event.toolCallId });
    });

    pi.on("before_agent_start", async (_event, ctx) => {
      const entries = ctx.sessionManager.getEntries();
      const dispatched = readSubagentSessionLinks(entries);
      const completed = readCompletedMarkers(entries);
      const previousText = lastAgentStatusText(entries);
      const { SessionManager } = await importPi();
      const resolvePath = async (childSessionId: string) => {
        try {
          const sessions = await SessionManager.list(ctx.cwd);
          return sessions.find((session) => session.id === childSessionId)?.path;
        } catch {
          return undefined;
        }
      };
      const snapshot = await buildAgentStatus({
        now: now(),
        dispatched,
        completed,
        previous: previousText ? parseAgentStatus(previousText) : undefined,
        resolvePath,
      });
      const content = formatAgentStatus(snapshot);
      if (previousText === content) return {};
      return { message: { customType: AGENT_STATUS_TYPE, content, display: false } };
    });
  };
}

export default createAgentStatusExtension();
