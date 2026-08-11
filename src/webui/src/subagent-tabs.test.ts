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
} from "./subagent-tabs";

const empty: SubagentTabsState = { tabs: [], hiddenRunningToolCalls: [] };

function runningTool(key: string, agent = "search", latestMessage?: string, step?: number): ToolView {
  return {
    key,
    name: "subagent",
    running: true,
    done: false,
    error: false,
    agentName: agent,
    latestMessage,
    step,
    order: 0,
  };
}

function summary(toolCallId: string, childSessionId: string, agent = "search"): SubagentSessionSummaryDto {
  return { toolCallId, childSessionId, agent };
}

describe("subagent tab state", () => {
  it("derives temporary tabs only while tools run and preserves retained tabs after settlement", () => {
    const derived = syncRunningSubagentTabs(empty, [runningTool("call-1", "search", "finding papers")]);
    expect(derived.tabs).toEqual([
      {
        key: "tool:call-1",
        toolCallId: "call-1",
        agent: "search",
        retained: false,
        running: true,
        latestMessage: "finding papers",
      },
    ]);
    expect(syncRunningSubagentTabs(derived, []).tabs).toEqual([]);

    const retained = retainSubagentTab(derived, "call-1");
    expect(syncRunningSubagentTabs(retained, []).tabs).toEqual([
      expect.objectContaining({ key: "tool:call-1", retained: true, running: false }),
    ]);
  });

  it("promotes a retained tool tab to its exact child UUID and deduplicates UUID tabs", () => {
    let state = retainSubagentTab(syncRunningSubagentTabs(empty, [runningTool("call-1")]), "call-1");
    state = promoteSubagentTab(state, summary("call-1", "12345678-aaaa"));
    state = promoteSubagentTab(state, summary("call-2", "12345678-aaaa"));

    expect(state.tabs).toEqual([
      expect.objectContaining({
        key: "session:12345678-aaaa",
        sessionId: "12345678-aaaa",
        toolCallId: "call-1",
        retained: true,
      }),
    ]);
    expect(syncRunningSubagentTabs(state, []).tabs).toHaveLength(1);
  });

  it("tombstones a closed running tab until explicit retain or tool settlement", () => {
    const running = syncRunningSubagentTabs(empty, [runningTool("call-1")]);
    const closed = closeSubagentTab(running, "tool:call-1");
    expect(closed.hiddenRunningToolCalls).toEqual(["call-1"]);
    expect(syncRunningSubagentTabs(closed, [runningTool("call-1")]).tabs).toEqual([]);

    const unhidden = retainSubagentTab(closed, "call-1");
    expect(unhidden.hiddenRunningToolCalls).toEqual([]);
    const reopened = retainSubagentTab(syncRunningSubagentTabs(unhidden, [runningTool("call-1")]), "call-1");
    expect(reopened.tabs).toEqual([expect.objectContaining({ key: "tool:call-1", retained: true })]);

    const settled = syncRunningSubagentTabs(closed, []);
    expect(settled.hiddenRunningToolCalls).toEqual([]);
  });

  it("disambiguates same-agent UUID tabs with the first eight UUID characters", () => {
    let state = retainSubagentTab(syncRunningSubagentTabs(empty, [runningTool("one")]), "one");
    state = promoteSubagentTab(state, summary("one", "11111111-aaaa"));
    state = retainSubagentTab(syncRunningSubagentTabs(state, [runningTool("two")]), "two");
    state = promoteSubagentTab(state, summary("two", "22222222-bbbb"));

    expect(state.tabs.map((tab) => childTabLabel(tab, state.tabs))).toEqual(["search · 11111111", "search · 22222222"]);
  });

  it("reuses an open UUID tab with the later invocation's current fields", () => {
    let state = retainSubagentTab(
      syncRunningSubagentTabs(empty, [runningTool("call-old", "search", "old progress")]),
      "call-old",
    );
    state = promoteSubagentTab(state, summary("call-old", "shared-uuid", "search"));
    state = syncRunningSubagentTabs(state, [runningTool("call-new", "writing", "current progress")]);
    state = retainSubagentTab(state, "call-new");
    state = promoteSubagentTab(state, {
      ...summary("call-new", "shared-uuid", "writing"),
      latestMessage: "current progress",
    });

    expect(state.tabs).toEqual([
      {
        key: "session:shared-uuid",
        sessionId: "shared-uuid",
        toolCallId: "call-new",
        agent: "writing",
        retained: true,
        running: true,
        latestMessage: "current progress",
      },
    ]);
  });

  it("merges an unretained reused invocation into its existing UUID tab without leaving a temporary", () => {
    let state = retainSubagentTab(syncRunningSubagentTabs(empty, [runningTool("call-old")]), "call-old");
    state = promoteSubagentTab(state, summary("call-old", "shared-uuid"));
    state = syncRunningSubagentTabs(state, [runningTool("call-new", "writing", "current progress")]);
    state = promoteSubagentTab(state, {
      ...summary("call-new", "shared-uuid", "writing"),
      latestMessage: "current progress",
    });

    expect(state.tabs).toEqual([
      {
        key: "session:shared-uuid",
        sessionId: "shared-uuid",
        toolCallId: "call-new",
        agent: "writing",
        retained: true,
        running: true,
        latestMessage: "current progress",
      },
    ]);
  });

  it("preserves a retained prior chain UUID while creating and promoting the next step tab", () => {
    let state = syncRunningSubagentTabs(empty, [runningTool("chain", "search", "finding", 1)]);
    state = retainSubagentTab(state, "chain", 1);
    state = promoteSubagentTab(state, { ...summary("chain", "child-search"), step: 1 });

    state = syncRunningSubagentTabs(state, [runningTool("chain", "writing", "drafting", 2)]);
    expect(state.tabs).toEqual([
      expect.objectContaining({ key: "session:child-search", step: 1, running: false }),
      expect.objectContaining({ key: "tool:chain:2", step: 2, retained: false, running: true }),
    ]);

    state = retainSubagentTab(state, "chain", 2);
    state = promoteSubagentTab(state, { ...summary("chain", "child-writing", "writing"), step: 2 });
    expect(state.tabs.map((tab) => tab.key)).toEqual(["session:child-search", "session:child-writing"]);
  });

  it("tombstones the current invocation when a reused UUID tab closes while running", () => {
    let state = retainSubagentTab(syncRunningSubagentTabs(empty, [runningTool("call-old")]), "call-old");
    state = promoteSubagentTab(state, summary("call-old", "shared-uuid"));
    state = syncRunningSubagentTabs(state, [runningTool("call-new", "search", "new progress")]);
    state = retainSubagentTab(state, "call-new");
    state = promoteSubagentTab(state, summary("call-new", "shared-uuid"));

    const closed = closeSubagentTab(state, "session:shared-uuid");
    expect(closed.hiddenRunningToolCalls).toEqual(["call-new"]);
    expect(syncRunningSubagentTabs(closed, [runningTool("call-new")]).tabs).toEqual([]);
  });
});
