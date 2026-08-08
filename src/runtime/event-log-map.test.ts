import { describe, expect, it } from "vitest";
import { mapEventToLog } from "./event-log-map";

describe("mapEventToLog", () => {
  it("maps lifecycle events to info", () => {
    for (const type of ["session_start", "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end"]) {
      const entry = mapEventToLog({ type });
      expect(entry?.level).toBe("info");
      expect(entry?.message).toBe(type);
    }
  });

  it("maps tool events to info with the tool name", () => {
    const start = mapEventToLog({ type: "tool_execution_start", toolName: "web-search" })!;
    expect(start.level).toBe("info");
    expect(start.message).toContain("web-search");
    const end = mapEventToLog({ type: "tool_execution_end", toolName: "subagent", isError: false })!;
    expect(end.level).toBe("info");
    expect(end.fields?.toolName).toBe("subagent");
  });

  it("maps model_select to info with provider/model", () => {
    const entry = mapEventToLog({ type: "model_select", model: { provider: "anthropic", id: "claude-x" } })!;
    expect(entry.level).toBe("info");
    expect(entry.message).toContain("anthropic/claude-x");
  });

  it("maps streaming events to debug", () => {
    for (const type of ["message_update", "tool_execution_update", "tool_result"]) {
      expect(mapEventToLog({ type })?.level).toBe("debug");
    }
  });

  it("maps retry/compaction events to warn", () => {
    for (const type of ["auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end", "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished"]) {
      expect(mapEventToLog({ type })?.level).toBe("warn");
    }
  });

  it("returns null for unlogged events", () => {
    for (const type of ["message_start", "message_end", "entry_appended", "queue_update", "session_info_changed", "thinking_level_changed"]) {
      expect(mapEventToLog({ type })).toBeNull();
    }
  });
});
