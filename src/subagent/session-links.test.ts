import { describe, expect, it } from "vitest";
import {
  isSubagentSessionName,
  readSubagentSessionLinks,
  sessionNameFor,
  SUBAGENT_SESSION_LINK_ENTRY,
} from "./session-links";

describe("subagent session links", () => {
  it("keeps the latest valid link per tool-call step in final-entry order", () => {
    expect(readSubagentSessionLinks([
      {
        type: "custom",
        customType: SUBAGENT_SESSION_LINK_ENTRY,
        data: { toolCallId: "call-a", childSessionId: "child-a-old", agent: "search" },
      },
      {
        type: "custom",
        customType: SUBAGENT_SESSION_LINK_ENTRY,
        data: { toolCallId: "call-b", childSessionId: "child-b-old", agent: "writing", step: 1 },
      },
      {
        type: "custom",
        customType: SUBAGENT_SESSION_LINK_ENTRY,
        data: { toolCallId: "call-a", childSessionId: "", agent: "search" },
      },
      {
        type: "custom",
        customType: SUBAGENT_SESSION_LINK_ENTRY,
        data: {
          toolCallId: "call-a",
          childSessionId: "child-a-new",
          agent: "search",
          ownerSessionId: "root",
          launchId: "launch-a",
          agentId: "search_0",
        },
      },
      {
        type: "custom",
        customType: SUBAGENT_SESSION_LINK_ENTRY,
        data: { toolCallId: "call-c", childSessionId: "child-c", agent: "figures", step: 2 },
      },
      {
        type: "custom",
        customType: SUBAGENT_SESSION_LINK_ENTRY,
        data: { toolCallId: "call-b", childSessionId: "child-b-new", agent: "writing", step: 1 },
      },
    ])).toEqual([
      {
        toolCallId: "call-a",
        childSessionId: "child-a-new",
        agent: "search",
        ownerSessionId: "root",
        launchId: "launch-a",
        agentId: "search_0",
      },
      { toolCallId: "call-c", childSessionId: "child-c", agent: "figures", step: 2 },
      { toolCallId: "call-b", childSessionId: "child-b-new", agent: "writing", step: 1 },
    ]);
  });

  it("strictly rejects malformed links without displacing an older valid link", () => {
    const valid = {
      type: "custom",
      customType: SUBAGENT_SESSION_LINK_ENTRY,
      data: { toolCallId: "parent-call", childSessionId: "child-uuid", agent: "search", step: 1 },
    };
    expect(readSubagentSessionLinks([
      null,
      valid,
      { ...valid, data: { ...valid.data, toolCallId: " " } },
      { ...valid, data: { ...valid.data, childSessionId: 3 } },
      { ...valid, data: { ...valid.data, agent: "" } },
      { ...valid, data: { ...valid.data, step: 0 } },
      { ...valid, data: { ...valid.data, step: 1.5 } },
      { ...valid, data: { ...valid.data, step: Number.POSITIVE_INFINITY } },
      { ...valid, data: { ...valid.data, ownerSessionId: "" } },
      { ...valid, data: { ...valid.data, launchId: 3 } },
      { ...valid, data: { ...valid.data, agentId: " " } },
      { type: "custom", customType: "other", data: valid.data },
    ])).toEqual([
      { toolCallId: "parent-call", childSessionId: "child-uuid", agent: "search", step: 1 },
    ]);
  });

  it("treats easyresearch:search as a session name, not a child session id", () => {
    expect(sessionNameFor("search")).toBe("easyresearch:search");
    expect(isSubagentSessionName("easyresearch:search")).toBe(true);
    expect(isSubagentSessionName("easyresearch:")).toBe(true);
    expect(isSubagentSessionName("child-uuid")).toBe(false);
    expect(isSubagentSessionName(undefined)).toBe(false);
  });
});
