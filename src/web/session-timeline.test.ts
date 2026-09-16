import { describe, expect, it } from "vitest";
import { projectSessionTimeline } from "./session-timeline";

describe("session timeline projection", () => {
  it("places one completion batch at its real branch position without raw hidden bubbles", () => {
    const status = {
      type: "custom_message", id: "completion", timestamp: "2026-09-16T00:00:00.000Z",
      customType: "easyresearch:agent_status", display: false, content: "private control",
      details: { batchId: "b0", outcomes: [
        { launchId: "l0", agentId: "search_0", status: "complete", text: "status: partial" },
        { launchId: "l1", agentId: "search_1", status: "error" },
      ] },
    };
    const before = { type: "message", id: "user", message: { role: "user", content: "task", timestamp: 1 } };
    const timeline = projectSessionTimeline([
      before, status,
      { ...status, id: "visible-status", display: true },
      { ...status, id: "legacy", details: undefined },
      { type: "message", id: "other-hidden", message: { role: "custom", display: false, customType: "other", content: "private" } },
      { type: "compaction", id: "compaction", timestamp: status.timestamp, summary: "summary" },
    ]);
    expect(timeline).toEqual([
      { kind: "message", entryId: "user", message: before.message },
      { kind: "subagent-completion", entryId: "completion", timestamp: status.timestamp, ...status.details },
      { kind: "compaction", entryId: "compaction", timestamp: status.timestamp, summary: "summary" },
    ]);
  });

  it("keeps visible custom messages without exposing hidden supervisor context", () => {
    const timeline = projectSessionTimeline([
      {
        type: "custom_message",
        id: "visible-custom",
        parentId: null,
        timestamp: "2026-09-01T00:00:00.000Z",
        customType: "user-extension",
        content: "Visible extension note",
        display: true,
        details: { privatePath: "/private/file" },
      },
      {
        type: "custom_message",
        id: "hidden-status",
        parentId: "visible-custom",
        timestamp: "2026-09-01T00:01:00.000Z",
        customType: "easyresearch:agent_status",
        content: "private supervisor status",
        display: false,
      },
      {
        type: "compaction",
        id: "compact-malformed",
        parentId: "hidden-status",
        timestamp: "2026-09-01T00:02:00.000Z",
        summary: null,
      },
    ]);

    expect(timeline).toEqual([
      {
        kind: "message",
        entryId: "visible-custom",
        message: {
          role: "custom",
          customType: "user-extension",
          content: "Visible extension note",
          display: true,
          timestamp: Date.parse("2026-09-01T00:00:00.000Z"),
        },
      },
      {
        kind: "compaction",
        entryId: "compact-malformed",
        timestamp: "2026-09-01T00:02:00.000Z",
      },
    ]);
    expect(JSON.stringify(timeline)).not.toContain("privatePath");
    expect(JSON.stringify(timeline)).not.toContain("private supervisor status");
  });
});
