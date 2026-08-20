import { describe, expect, it } from "vitest";
import type { SubagentSessionSummaryDto } from "../../web/contracts";
import type { ToolView } from "./session-reducer";
import {
  childTabLabel,
  closeSubagentTab,
  promoteSubagentTab,
  retainSubagentTab,
  type SubagentTabsState,
  syncRunningSubagentTabs,
  temporarySubagentTabKey,
} from "./subagent-tabs";

const empty: SubagentTabsState = { tabs: [], hiddenRunningToolCalls: [] };

function subagentTool({
  ownerSessionId = "root",
  toolCallId = "call-1",
  agent = "search",
  agentId,
  childSessionId,
  status = "working",
  latestMessage,
  supervised = true,
  step,
}: {
  ownerSessionId?: string;
  toolCallId?: string;
  agent?: string;
  agentId?: string;
  childSessionId?: string;
  status?: "working" | "complete" | "error";
  latestMessage?: string;
  supervised?: boolean;
  step?: number;
} = {}): ToolView {
  const terminal = status !== "working";
  return {
    key: toolCallId,
    toolCallId,
    name: "subagent",
    running: !terminal,
    done: terminal,
    error: status === "error",
    ownerSessionId,
    agentName: agent,
    agentId,
    sessionId: childSessionId,
    supervised,
    latestMessage,
    step,
    order: 0,
  };
}

function summary({
  ownerSessionId = "root",
  toolCallId = "call-1",
  childSessionId = "child-1",
  agent = "search",
  agentId = "search_0",
  status = "working",
  latestMessage,
  step,
}: Partial<SubagentSessionSummaryDto> = {}): SubagentSessionSummaryDto {
  return {
    ownerSessionId,
    toolCallId,
    childSessionId,
    agent,
    agentId,
    status,
    latestMessage,
    step,
  };
}

describe("subagent tab state", () => {
  it("scopes temporary and hidden-running identities by owner and tool call", () => {
    expect(temporarySubagentTabKey("root", "t0")).not.toBe(temporarySubagentTabKey("writing-child", "t0"));

    const root = syncRunningSubagentTabs(empty, [subagentTool({ toolCallId: "t0", supervised: false })], "root");
    const closed = closeSubagentTab(root, temporarySubagentTabKey("root", "t0"));
    const nested = syncRunningSubagentTabs(
      closed,
      [subagentTool({ ownerSessionId: "writing-child", toolCallId: "t0", supervised: false })],
      "writing-child",
    );

    expect(closed.hiddenRunningToolCalls).toHaveLength(1);
    expect(nested.tabs).toEqual([
      expect.objectContaining({ ownerSessionId: "writing-child", toolCallId: "t0", running: true }),
    ]);
  });

  it("keeps concurrent same-role jobs distinct through out-of-order terminal events", () => {
    const first = subagentTool({
      toolCallId: "t0",
      agentId: "opaque:first",
      childSessionId: "child-0",
      latestMessage: "first progress",
    });
    const second = subagentTool({
      toolCallId: "t1",
      agentId: "opaque/second",
      childSessionId: "child-1",
      latestMessage: "second progress",
    });
    let state = syncRunningSubagentTabs(empty, [first, second], "root");

    expect(state.tabs).toEqual([
      expect.objectContaining({ toolCallId: "t0", agentId: "opaque:first", running: true }),
      expect.objectContaining({ toolCallId: "t1", agentId: "opaque/second", running: true }),
    ]);

    state = syncRunningSubagentTabs(
      state,
      [first, subagentTool({ ...second, toolCallId: "t1", status: "complete" })],
      "root",
    );
    expect(state.tabs.map((tab) => tab.toolCallId)).toEqual(["t0"]);

    state = syncRunningSubagentTabs(state, [subagentTool({ ...first, toolCallId: "t0", status: "error" })], "root");
    expect(state.tabs).toEqual([]);
  });

  it("does not collapse an untouched tab at launch acknowledgement", () => {
    const launching = subagentTool({ toolCallId: "launch", supervised: false });
    const state = syncRunningSubagentTabs(empty, [launching], "root");
    const acknowledged = syncRunningSubagentTabs(
      state,
      [subagentTool({ toolCallId: "launch", agentId: "search_9", childSessionId: "child-9" })],
      "root",
    );

    expect(acknowledged.tabs).toEqual([
      expect.objectContaining({ toolCallId: "launch", agentId: "search_9", running: true, error: false }),
    ]);
  });

  it("keeps a retained UUID tab after Complete or Error", () => {
    let state = syncRunningSubagentTabs(
      empty,
      [subagentTool({ toolCallId: "complete", agentId: "search_0", childSessionId: "child-complete" })],
      "root",
    );
    state = retainSubagentTab(state, "root", "complete");
    state = promoteSubagentTab(
      state,
      summary({ toolCallId: "complete", childSessionId: "child-complete", agentId: "search_0" }),
    );
    state = syncRunningSubagentTabs(
      state,
      [
        subagentTool({
          toolCallId: "complete",
          agentId: "search_0",
          childSessionId: "child-complete",
          status: "complete",
        }),
      ],
      "root",
    );

    expect(state.tabs).toEqual([
      expect.objectContaining({ key: "session:child-complete", running: false, error: false, retained: true }),
    ]);

    state = syncRunningSubagentTabs(
      state,
      [
        subagentTool({
          toolCallId: "complete",
          agentId: "search_0",
          childSessionId: "child-complete",
          status: "error",
        }),
      ],
      "root",
    );
    expect(state.tabs[0]).toMatchObject({ running: false, error: true, retained: true });
  });

  it("deduplicates a continuation into its retained child UUID", () => {
    let state = syncRunningSubagentTabs(
      empty,
      [subagentTool({ toolCallId: "old", agentId: "opaque id", childSessionId: "shared-child" })],
      "root",
    );
    state = retainSubagentTab(state, "root", "old");
    state = promoteSubagentTab(
      state,
      summary({ toolCallId: "old", childSessionId: "shared-child", agentId: "opaque id" }),
    );
    state = syncRunningSubagentTabs(
      state,
      [subagentTool({ toolCallId: "next", agentId: "opaque id", childSessionId: "shared-child" })],
      "root",
    );
    state = promoteSubagentTab(
      state,
      summary({ toolCallId: "next", childSessionId: "shared-child", agentId: "opaque id" }),
    );

    expect(state.tabs).toEqual([
      expect.objectContaining({
        key: "session:shared-child",
        ownerSessionId: "root",
        toolCallId: "next",
        sessionId: "shared-child",
        agentId: "opaque id",
        running: true,
      }),
    ]);
  });

  it("removes a selected unmapped pre-materialization failure", () => {
    let state = syncRunningSubagentTabs(empty, [subagentTool({ toolCallId: "failed", supervised: false })], "root");
    state = retainSubagentTab(state, "root", "failed");
    state = syncRunningSubagentTabs(
      state,
      [subagentTool({ toolCallId: "failed", supervised: false, status: "error" })],
      "root",
    );

    expect(state.tabs).toEqual([]);
  });

  it("labels duplicate legacy UUID tabs without interpreting opaque Agent ids", () => {
    const tabs = [
      {
        key: "session:first-child",
        ownerSessionId: "root",
        toolCallId: "first",
        agent: "search",
        agentId: "opaque::alpha/1",
        sessionId: "first-child",
        retained: true,
        running: false,
        error: false,
      },
      {
        key: "session:second-child",
        ownerSessionId: "root",
        toolCallId: "second",
        agent: "search",
        sessionId: "second-child",
        retained: true,
        running: false,
        error: false,
      },
    ];

    expect(tabs.map((tab) => childTabLabel(tab, tabs))).toEqual(["opaque::alpha/1", "search · second-c"]);
  });
});
