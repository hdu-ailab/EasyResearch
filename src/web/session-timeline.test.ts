import { describe, expect, it } from "vitest";
import { projectSessionTimeline } from "./session-timeline";

describe("session timeline projection", () => {
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
