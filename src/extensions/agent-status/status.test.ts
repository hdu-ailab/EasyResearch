import { describe, expect, it } from "vitest";
import {
  AGENT_STATUS_TYPE,
  SUBAGENT_COMPLETED_TYPE,
  buildAgentStatus,
  formatAgentStatus,
  lastAgentStatusText,
  parseAgentStatus,
  readCompletedMarkers,
  type AgentStatusSnapshot,
  type SubagentDispatched,
} from "./status";

const dispatched: SubagentDispatched[] = [
  { toolCallId: "d0", agent: "search", childSessionId: "s0" },
  { toolCallId: "d1", agent: "search", childSessionId: "s1" },
];

const paths: Record<string, string> = { s0: "/sessions/0.jsonl", s1: "/sessions/1.jsonl" };
const resolvePath = (id: string) => Promise.resolve(paths[id]);

describe("buildAgentStatus", () => {
  it("lists every dispatched child as working when none completed", async () => {
    const snapshot = await buildAgentStatus({
      now: "2026-08-18 10:00:00",
      dispatched,
      completed: [],
      resolvePath,
    });
    expect(snapshot.working).toEqual([
      { name: "search_0", sessionPath: "/sessions/0.jsonl" },
      { name: "search_1", sessionPath: "/sessions/1.jsonl" },
    ]);
    expect(snapshot.complete).toEqual([]);
  });

  it("moves a completed child to Complete once, then drains it", async () => {
    const first = await buildAgentStatus({
      now: "t1",
      dispatched,
      completed: [{ toolCallId: "d1" }],
      resolvePath,
    });
    expect(first.working).toEqual([{ name: "search_0", sessionPath: "/sessions/0.jsonl" }]);
    expect(first.complete).toEqual([{ name: "search_1", sessionPath: "/sessions/1.jsonl" }]);

    const second = await buildAgentStatus({
      now: "t2",
      dispatched,
      completed: [{ toolCallId: "d1" }],
      previous: first,
      resolvePath,
    });
    expect(second.working).toEqual([{ name: "search_0", sessionPath: "/sessions/0.jsonl" }]);
    expect(second.complete).toEqual([]);
  });

  it("skips items whose session path cannot be resolved", async () => {
    const snapshot = await buildAgentStatus({
      now: "t",
      dispatched: [{ toolCallId: "d0", agent: "search", childSessionId: "missing" }],
      completed: [],
      resolvePath: () => Promise.resolve(undefined),
    });
    expect(snapshot.working).toEqual([]);
  });
});

describe("formatAgentStatus / parseAgentStatus", () => {
  it("omits empty working/complete lines and round-trips", () => {
    const snapshot: AgentStatusSnapshot = {
      time: "2026-08-18 10:00:00",
      working: [],
      complete: [{ name: "search_1", sessionPath: "/sessions/1.jsonl" }],
    };
    const text = formatAgentStatus(snapshot);
    expect(text).toContain("<agent_status>");
    expect(text).toContain("Current time: 2026-08-18 10:00:00");
    expect(text).not.toContain("Working subagent:");
    expect(text).toContain("Complete subagent:{\"name\":\"search_1\",\"session_path\":\"/sessions/1.jsonl\"}");
    expect(parseAgentStatus(text)).toEqual(snapshot);
  });

  it("renders both lists and round-trips a full block", () => {
    const snapshot: AgentStatusSnapshot = {
      time: "t",
      working: [
        { name: "search_0", sessionPath: "/sessions/0.jsonl" },
        { name: "search_1", sessionPath: "/sessions/1.jsonl" },
      ],
      complete: [{ name: "search_1", sessionPath: "/sessions/1.jsonl" }],
    };
    const text = formatAgentStatus(snapshot);
    expect(text).toContain('Working subagent:{"name":"search_0","session_path":"/sessions/0.jsonl"},{"name":"search_1","session_path":"/sessions/1.jsonl"}');
    expect(text).toContain("Complete subagent:{\"name\":\"search_1\",\"session_path\":\"/sessions/1.jsonl\"}");
    expect(parseAgentStatus(text)).toEqual(snapshot);
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