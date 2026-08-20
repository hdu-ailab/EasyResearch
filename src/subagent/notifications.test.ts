import { describe, expect, it } from "vitest";
import {
  AGENT_STATUS_TYPE,
  formatTerminalNotification,
  notificationBatchId,
} from "./notifications";

describe("formatTerminalNotification", () => {
  it("formats full Working state and one-shot outcomes one item per line", () => {
    const text = formatTerminalNotification({
      time: "2026-08-19T00:00:00Z",
      workingAgentIds: ["review agent_0", "检索,甲_0"],
      outcomes: [
        {
          launchId: "l0",
          agentId: "search_0",
          status: "complete",
          sessionPath: "/private/s0.jsonl",
          latestAssistantText: "status: complete\nartifacts: ref_papers/index.md",
        },
        { launchId: "l1", agentId: "figures_0", status: "error", sessionPath: "/private/f0.jsonl" },
      ],
    });

    expect(text).toContain("Working subagent:review agent_0\nWorking subagent:检索,甲_0");
    expect(text).toContain("Complete subagent:search_0");
    expect(text).toContain('Error subagent:{"name":"figures_0","session_path":"/private/f0.jsonl"}');
    expect(text).not.toContain("/private/s0.jsonl");
    expect(text).toContain("Result: status: complete\nartifacts: ref_papers/index.md");
  });

  it("groups multiple status lines deterministically and keeps handoffs in outcome order", () => {
    const text = formatTerminalNotification({
      time: "t0",
      workingAgentIds: ["working_1", "working_0"],
      outcomes: [
        { launchId: "l0", agentId: "error_1", status: "error", sessionPath: "/errors/1.jsonl", latestAssistantText: "error result" },
        { launchId: "l1", agentId: "complete_1", status: "complete", sessionPath: "/success/1.jsonl", latestAssistantText: "complete result 1" },
        { launchId: "l2", agentId: "complete_0", status: "complete", sessionPath: "/success/0.jsonl", latestAssistantText: "complete result 0" },
        { launchId: "l3", agentId: "error_0", status: "error", sessionPath: "/errors/0.jsonl", latestAssistantText: "error result 0" },
      ],
    });

    expect(text).toBe(
      "<agent_status>\n" +
      "Current time: t0\n" +
      "Working subagent:working_1\n" +
      "Working subagent:working_0\n" +
      "Complete subagent:complete_1\n" +
      "Complete subagent:complete_0\n" +
      'Error subagent:{"name":"error_1","session_path":"/errors/1.jsonl"}\n' +
      'Error subagent:{"name":"error_0","session_path":"/errors/0.jsonl"}\n' +
      "</agent_status>\n" +
      "<agent_handoff>\n" +
      "Agent: error_1\n" +
      "Result: error result\n" +
      "Agent: complete_1\n" +
      "Result: complete result 1\n" +
      "Agent: complete_0\n" +
      "Result: complete result 0\n" +
      "Agent: error_0\n" +
      "Result: error result 0\n" +
      "</agent_handoff>",
    );
  });

  it("keeps complete assistant text untruncated", () => {
    const latestAssistantText = `${"full result ".repeat(2_000)}\nlast line`;

    const text = formatTerminalNotification({
      time: "t0",
      workingAgentIds: [],
      outcomes: [{
        launchId: "l0",
        agentId: "writing_0",
        status: "complete",
        sessionPath: "/private/writing.jsonl",
        latestAssistantText,
      }],
    });

    expect(text).toContain(`Agent: writing_0\nResult: ${latestAssistantText}\n</agent_handoff>`);
    expect(text).not.toContain("/private/writing.jsonl");
  });

  it("does not fabricate a handoff result for an Error without assistant text", () => {
    const text = formatTerminalNotification({
      time: "t0",
      workingAgentIds: [],
      outcomes: [{ launchId: "l0", agentId: "search_0", status: "error", sessionPath: "/private/search.jsonl" }],
    });

    expect(text).toContain('Error subagent:{"name":"search_0","session_path":"/private/search.jsonl"}');
    expect(text).not.toContain("Agent: search_0");
    expect(text).not.toContain("Result:");
    expect(text).toContain("<agent_handoff>\n</agent_handoff>");
  });

  it("does not treat whitespace-only assistant content as a handoff", () => {
    const text = formatTerminalNotification({
      time: "t0",
      workingAgentIds: [],
      outcomes: [{
        launchId: "l0",
        agentId: "search_0",
        status: "error",
        sessionPath: "/private/search.jsonl",
        latestAssistantText: "  \n\t",
      }],
    });

    expect(text).not.toContain("Agent: search_0");
    expect(text).not.toContain("Result:");
  });

  it("escapes Error status data with JSON.stringify", () => {
    const agentId = "quote\" slash\\ newline\n_0";
    const sessionPath = "/private/quote\"/slash\\/newline\n.jsonl";
    const text = formatTerminalNotification({
      time: "t0",
      workingAgentIds: [],
      outcomes: [{ launchId: "l0", agentId, status: "error", sessionPath }],
    });

    expect(text).toContain(`Error subagent:${JSON.stringify({ name: agentId, session_path: sessionPath })}`);
  });
});

describe("notificationBatchId", () => {
  it("reads batch ids from live and persisted hidden status messages", () => {
    expect(notificationBatchId({
      role: "custom",
      customType: AGENT_STATUS_TYPE,
      content: "status",
      display: false,
      details: { batchId: "batch-live" },
    })).toBe("batch-live");
    expect(notificationBatchId({
      type: "custom_message",
      customType: AGENT_STATUS_TYPE,
      content: "status",
      display: false,
      details: { batchId: "batch-persisted" },
    })).toBe("batch-persisted");
  });

  it("ignores unrelated or malformed messages", () => {
    expect(notificationBatchId(undefined)).toBeUndefined();
    expect(notificationBatchId({ role: "custom", customType: "other", details: { batchId: "batch" } })).toBeUndefined();
    expect(notificationBatchId({ role: "custom", customType: AGENT_STATUS_TYPE, details: { batchId: "" } })).toBeUndefined();
    expect(notificationBatchId({ role: "custom", customType: AGENT_STATUS_TYPE, details: { batchId: 1 } })).toBeUndefined();
    expect(notificationBatchId({ customType: AGENT_STATUS_TYPE, details: { batchId: "batch" } })).toBeUndefined();
  });
});
