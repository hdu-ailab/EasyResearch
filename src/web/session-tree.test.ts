import { describe, expect, it } from "vitest";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { flattenMessageTree } from "./session-tree";

const node = (entry: SessionTreeNode["entry"], children: SessionTreeNode[] = []): SessionTreeNode => ({
  entry,
  children,
});

function messageEntry(id: string, parentId: string | null, role: string, text: string): SessionTreeNode["entry"] {
  return { type: "message", id, parentId, timestamp: "", message: { role, content: text } as never };
}

describe("flattenMessageTree", () => {
  it("flattens message entries depth-first in order", () => {
    const tree = [
      node(messageEntry("m1", null, "user", "hello"), [
        node(messageEntry("m2", "m1", "assistant", "hi")),
        node(messageEntry("m3", "m1", "user", "again"), [node(messageEntry("m4", "m3", "assistant", "ok"))]),
      ]),
    ];
    expect(flattenMessageTree(tree)).toEqual([
      { id: "m1", parentId: null, role: "user", text: "hello" },
      { id: "m2", parentId: "m1", role: "assistant", text: "hi" },
      { id: "m3", parentId: "m1", role: "user", text: "again" },
      { id: "m4", parentId: "m3", role: "assistant", text: "ok" },
    ]);
  });

  it("keeps non-message entries as other so parent chains stay intact", () => {
    const tree = [
      node({
        type: "thinking_level_change",
        id: "t1",
        parentId: null,
        timestamp: "",
        thinkingLevel: "high",
      }),
      node(messageEntry("m1", "t1", "user", "hi"), [
        node({ type: "label", id: "l1", parentId: "m1", timestamp: "", targetId: "m1", label: "x" }),
        node(messageEntry("m2", "l1", "assistant", "yo")),
      ]),
    ];
    expect(flattenMessageTree(tree)).toEqual([
      { id: "t1", parentId: null, role: "other", text: "" },
      { id: "m1", parentId: "t1", role: "user", text: "hi" },
      { id: "l1", parentId: "m1", role: "other", text: "" },
      { id: "m2", parentId: "l1", role: "assistant", text: "yo" },
    ]);
  });

  it("maps non-bubble message roles (toolResult/system) to other", () => {
    const tree = [
      node(messageEntry("m1", null, "user", "a")),
      node(messageEntry("tr1", "m1", "toolResult", "tool output")),
      node(messageEntry("m2", "tr1", "assistant", "b")),
      node(messageEntry("sys1", "m2", "system", "system note")),
    ];
    expect(flattenMessageTree(tree)).toEqual([
      { id: "m1", parentId: null, role: "user", text: "a" },
      { id: "tr1", parentId: "m1", role: "other", text: "" },
      { id: "m2", parentId: "tr1", role: "assistant", text: "b" },
      { id: "sys1", parentId: "m2", role: "other", text: "" },
    ]);
  });

  it("carries compaction summaries with firstKeptEntryId and branch summaries as other", () => {
    const tree = [
      node({
        type: "compaction",
        id: "c1",
        parentId: null,
        timestamp: "",
        summary: "summarized",
        firstKeptEntryId: "m2",
        tokensBefore: 100,
      }),
      node({ type: "branch_summary", id: "b1", parentId: "c1", timestamp: "", fromId: "m9", summary: "branch" }),
    ];
    expect(flattenMessageTree(tree)).toEqual([
      { id: "c1", parentId: null, role: "other", text: "summarized", firstKeptEntryId: "m2" },
      { id: "b1", parentId: "c1", role: "other", text: "branch" },
    ]);
  });

  it("extracts text from block content", () => {
    const entry = {
      type: "message" as const,
      id: "m1",
      parentId: null,
      timestamp: "",
      message: { role: "user", content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "t" }] } as never,
    };
    expect(flattenMessageTree([node(entry)])).toEqual([{ id: "m1", parentId: null, role: "user", text: "a" }]);
  });
});
