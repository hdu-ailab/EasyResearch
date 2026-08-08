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

  it("maps tool_execution_start to info with the tool name", () => {
    const start = mapEventToLog({ type: "tool_execution_start", toolName: "web-search" })!;
    expect(start.level).toBe("info");
    expect(start.message).toBe("tool_execution_start web-search");
    expect(start.fields?.toolName).toBe("web-search");
  });

  it("maps tool_execution_update to debug with the tool name", () => {
    const update = mapEventToLog({ type: "tool_execution_update", toolName: "web-search" })!;
    expect(update.level).toBe("debug");
    expect(update.message).toBe("tool_execution_update web-search");
    expect(update.fields?.toolName).toBe("web-search");
  });

  it("maps tool_execution_end to info with ok/error suffix", () => {
    const ok = mapEventToLog({ type: "tool_execution_end", toolName: "subagent", isError: false })!;
    expect(ok.level).toBe("info");
    expect(ok.message).toBe("tool_execution_end subagent ok");
    expect(ok.fields?.toolName).toBe("subagent");
    const error = mapEventToLog({ type: "tool_execution_end", toolName: "subagent", isError: true })!;
    expect(error.level).toBe("info");
    expect(error.message).toBe("tool_execution_end subagent error");
    expect(error.fields?.toolName).toBe("subagent");
  });

  it("maps model_select to info with provider/model", () => {
    const entry = mapEventToLog({ type: "model_select", model: { provider: "anthropic", id: "claude-x" } })!;
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("model_select anthropic/claude-x");
  });

  it("maps model_select to unknown when no model is present", () => {
    expect(mapEventToLog({ type: "model_select" })?.message).toBe("model_select unknown");
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

  it("maps auto_retry_start with attempt fields", () => {
    const entry = mapEventToLog({ type: "auto_retry_start", attempt: 2, maxAttempts: 5 })!;
    expect(entry.level).toBe("warn");
    expect(entry.fields).toEqual({ attempt: 2, maxAttempts: 5 });
  });

  it("returns null for unlogged events", () => {
    for (const type of ["message_start", "message_end", "entry_appended", "queue_update", "session_info_changed", "thinking_level_changed"]) {
      expect(mapEventToLog({ type })).toBeNull();
    }
  });
});
