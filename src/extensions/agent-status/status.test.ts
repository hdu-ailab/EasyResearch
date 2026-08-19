import { describe, expect, it } from "vitest";
import {
  AGENT_STATUS_TYPE,
  SUBAGENT_COMPLETED_TYPE,
  SUBAGENT_ERRORED_TYPE,
  buildAgentStatus,
  formatAgentStatus,
  lastAgentStatusText,
  parseAgentStatus,
  readCompletedMarkers,
  readSubagentOutcomes,
  type AgentStatusSnapshot,
  type SubagentDispatched,
  type SubagentOutcome,
} from "./status";

const dispatched: SubagentDispatched[] = [
  { toolCallId: "d0", agent: "search", childSessionId: "s0" },
  { toolCallId: "d1", agent: "search", childSessionId: "s1" },
];

const idsBySession: Record<string, string> = { s0: "search_0", s1: "search_1" };
const resolveId = (childSessionId: string) => idsBySession[childSessionId];

function outcomes(pairs: Array<[string, SubagentOutcome]>): ReadonlyMap<string, SubagentOutcome> {
  return new Map(pairs);
}

describe("buildAgentStatus", () => {
  it("lists every dispatched child as working with its agent id when no outcome is recorded", async () => {
    const snapshot = await buildAgentStatus({
      now: "2026-08-18 10:00:00",
      dispatched,
      outcomes: outcomes([]),
      resolveId,
    });
    expect(snapshot.working).toEqual([{ name: "search_0" }, { name: "search_1" }]);
    expect(snapshot.complete).toEqual([]);
    expect(snapshot.error).toEqual([]);
  });

  it("moves a completed child to Complete once, then drains it", async () => {
    const first = await buildAgentStatus({
      now: "t1",
      dispatched,
      outcomes: outcomes([["d1", "complete"]]),
      resolveId,
    });
    expect(first.working).toEqual([{ name: "search_0" }]);
    expect(first.complete).toEqual([{ name: "search_1" }]);
    expect(first.error).toEqual([]);

    const second = await buildAgentStatus({
      now: "t2",
      dispatched,
      outcomes: outcomes([["d1", "complete"]]),
      previous: first,
      resolveId,
    });
    expect(second.working).toEqual([{ name: "search_0" }]);
    expect(second.complete).toEqual([]);
  });

  it("moves an errored child to Error once, then drains it", async () => {
    const first = await buildAgentStatus({
      now: "t1",
      dispatched,
      outcomes: outcomes([["d1", "error"]]),
      resolveId,
    });
    expect(first.working).toEqual([{ name: "search_0" }]);
    expect(first.complete).toEqual([]);
    expect(first.error).toEqual([{ name: "search_1" }]);

    const second = await buildAgentStatus({
      now: "t2",
      dispatched,
      outcomes: outcomes([["d1", "error"]]),
      previous: first,
      resolveId,
    });
    expect(second.working).toEqual([{ name: "search_0" }]);
    expect(second.error).toEqual([]);
  });

  it("keeps errored children out of Working while they also complete", async () => {
    const snapshot = await buildAgentStatus({
      now: "t",
      dispatched,
      outcomes: outcomes([["d0", "complete"], ["d1", "error"]]),
      resolveId,
    });
    expect(snapshot.working).toEqual([]);
    expect(snapshot.complete).toEqual([{ name: "search_0" }]);
    expect(snapshot.error).toEqual([{ name: "search_1" }]);
  });

  it("falls back to index-based naming when no alias id is resolvable", async () => {
    const snapshot = await buildAgentStatus({
      now: "t",
      dispatched: [{ toolCallId: "d0", agent: "search", childSessionId: "missing" }],
      outcomes: outcomes([]),
      resolveId: () => undefined,
    });
    expect(snapshot.working).toEqual([{ name: "search_0" }]);
  });
});

describe("formatAgentStatus / parseAgentStatus", () => {
  it("omits empty working/complete/error lines and round-trips", () => {
    const snapshot: AgentStatusSnapshot = {
      time: "2026-08-18 10:00:00",
      working: [],
      complete: [{ name: "search_1" }],
      error: [],
    };
    const text = formatAgentStatus(snapshot);
    expect(text).toContain("<agent_status>");
    expect(text).toContain("Current time: 2026-08-18 10:00:00");
    expect(text).not.toContain("Working subagent:");
    expect(text).not.toContain("Error subagent:");
    expect(text).toContain("Complete subagent:search_1");
    expect(parseAgentStatus(text)).toEqual(snapshot);
  });

  it("renders all three lists and round-trips a full block", () => {
    const snapshot: AgentStatusSnapshot = {
      time: "t",
      working: [{ name: "search_0" }, { name: "search_1" }],
      complete: [{ name: "search_1" }],
      error: [{ name: "search_2" }],
    };
    const text = formatAgentStatus(snapshot);
    expect(text).toContain("Working subagent:search_0,search_1");
    expect(text).toContain("Complete subagent:search_1");
    expect(text).toContain("Error subagent:search_2");
    expect(parseAgentStatus(text)).toEqual(snapshot);
  });

  it("parses legacy items that still carry session_path (extracts the id)", () => {
    const legacy =
      '<agent_status>\nCurrent time: 2026-08-18 10:00:00\n' +
      'Working subagent:{"name":"search_0","session_path":"/sessions/0.jsonl"}\n' +
      'Complete subagent:{"name":"search_1","session_path":"/sessions/1.jsonl"}\n' +
      '</agent_status>';
    const parsed = parseAgentStatus(legacy);
    expect(parsed?.working).toEqual([{ name: "search_0" }]);
    expect(parsed?.complete).toEqual([{ name: "search_1" }]);
  });

  it("returns undefined for non-status text", () => {
    expect(parseAgentStatus("hello")).toBeUndefined();
  });
});

describe("session entry readers", () => {
  const entries = [
    { type: "custom", customType: SUBAGENT_COMPLETED_TYPE, data: { toolCallId: "d1" } },
    { type: "custom", customType: "other", data: { x: 1 } },
    { type: "custom", customType: SUBAGENT_COMPLETED_TYPE, data: {} },
  ];

  it("reads completion markers, ignoring malformed ones", () => {
    expect(readCompletedMarkers(entries)).toEqual([{ toolCallId: "d1" }]);
  });

  it("reads the last persisted status text and ignores non-status entries", () => {
    const withStatus = [
      { type: "custom_message", customType: AGENT_STATUS_TYPE, content: "<agent_status>one</agent_status>", display: false },
      { type: "custom_message", customType: AGENT_STATUS_TYPE, content: "<agent_status>two</agent_status>", display: false },
    ];
    expect(lastAgentStatusText(withStatus)).toBe("<agent_status>two</agent_status>");
    expect(lastAgentStatusText(entries)).toBeUndefined();
  });
});

describe("readSubagentOutcomes", () => {
  it("combines success and error markers", () => {
    const entries = [
      { type: "custom", customType: SUBAGENT_COMPLETED_TYPE, data: { toolCallId: "d0" } },
      { type: "custom", customType: SUBAGENT_ERRORED_TYPE, data: { toolCallId: "d1" } },
      { type: "custom", customType: SUBAGENT_ERRORED_TYPE, data: {} },
    ];
    expect(readSubagentOutcomes(entries)).toEqual(outcomes([["d0", "complete"], ["d1", "error"]]));
  });

  it("classifies dispatch outcomes from subagent toolResult transcript rows", () => {
    const entries = [
      {
        type: "message",
        message: { role: "toolResult", toolCallId: "d0", toolName: "subagent", isError: false },
      },
      {
        type: "message",
        message: { role: "toolResult", toolCallId: "d1", toolName: "subagent", isError: true },
      },
      {
        type: "message",
        message: { role: "toolResult", toolCallId: "d2", toolName: "web-search", isError: true },
      },
      { type: "message", message: { role: "user", content: [] } },
    ];
    expect(readSubagentOutcomes(entries)).toEqual(outcomes([["d0", "complete"], ["d1", "error"]]));
  });

  it("prefers explicit markers over transcript rows for the same tool call", async () => {
    const entries = [
      { type: "custom", customType: SUBAGENT_COMPLETED_TYPE, data: { toolCallId: "d0" } },
      {
        type: "message",
        message: { role: "toolResult", toolCallId: "d0", toolName: "subagent", isError: true },
      },
    ];
    const out = readSubagentOutcomes(entries);
    const snapshot = await buildAgentStatus({
      now: "t",
      dispatched: [{ toolCallId: "d0", agent: "search", childSessionId: "s0" }],
      outcomes: out,
      resolveId,
    });
    expect(snapshot.complete).toEqual([{ name: "search_0" }]);
    expect(snapshot.error).toEqual([]);
  });
});