import { describe, expect, it } from "vitest";
import {
  AGENT_ALIAS_ENTRY,
  formatAgentId,
  isAgentId,
  nextAgentIndex,
  readAgentAliases,
  resolveAgentAlias,
  type SubagentAlias,
} from "./agent-alias";

function aliasEntries(records: SubagentAlias[]): unknown[] {
  return records.map((data) => ({ type: "custom", customType: AGENT_ALIAS_ENTRY, data }));
}

const search0: SubagentAlias = { id: "search_0", agent: "search", sessionId: "s0", sessionPath: "/sessions/s0.jsonl" };
const search1: SubagentAlias = { id: "search_1", agent: "search", sessionId: "s1", sessionPath: "/sessions/s1.jsonl" };

describe("agent-alias helpers (ADR-084)", () => {
  it("reads aliases keeping the latest entry per id, in append order", () => {
    expect(readAgentAliases(aliasEntries([search0, search1]))).toEqual([search0, search1]);
    const superseded = aliasEntries([search0, { ...search0, sessionPath: "/sessions/s0-v2.jsonl" }]);
    expect(readAgentAliases(superseded)).toEqual([{ ...search0, sessionPath: "/sessions/s0-v2.jsonl" }]);
  });

  it("ignores malformed alias entries", () => {
    const entries = [
      ...aliasEntries([search0]),
      { type: "custom", customType: AGENT_ALIAS_ENTRY, data: { agent: "search" } },
      { type: "custom", customType: "other", data: search1 },
    ];
    expect(readAgentAliases(entries)).toEqual([search0]);
  });

  it("resolves an alias by id", () => {
    expect(resolveAgentAlias([search0, search1], "search_1")).toEqual(search1);
    expect(resolveAgentAlias([search0], "search_2")).toBeUndefined();
  });

  it("allocates ids per agent from the persisted count (shared counter)", () => {
    expect(nextAgentIndex([search0, search1], "search")).toBe(2);
    expect(nextAgentIndex([search0, search1], "writing")).toBe(0);
    expect(formatAgentId("search", 2)).toBe("search_2");
  });

  it("matches id-shaped session values", () => {
    expect(isAgentId("search_0")).toBe(true);
    expect(isAgentId("experiment-writer_12")).toBe(true);
    expect(isAgentId("")).toBe(false);
    expect(isAgentId("search")).toBe(false);
    expect(isAgentId("/sessions/x.jsonl")).toBe(false);
  });
});
