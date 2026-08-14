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

  it("skips non-message entries and maps unknown roles to assistant", () => {
    const tree = [
      node({
        type: "compaction",
        id: "c1",
        parentId: null,
        timestamp: "",
        summary: "s",
        firstKeptEntryId: "m1",
        tokensBefore: 0,
      }),
      node(messageEntry("m1", null, "system", "sys"), [
        node({ type: "label", id: "l1", parentId: "m1", timestamp: "", targetId: "m1", label: "x" }),
      ]),
    ];
    expect(flattenMessageTree(tree)).toEqual([{ id: "m1", parentId: null, role: "assistant", text: "sys" }]);
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
