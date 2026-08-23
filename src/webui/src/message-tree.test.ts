import { describe, expect, it } from "vitest";
import type { WebTreeEntryDto } from "../../web/contracts";
import { buildMessageTreeMeta, versionTarget } from "./message-tree";
import type { SessionMessageView } from "./session-reducer";

const entry = (id: string, parentId: string | null, role: "user" | "assistant", text = ""): WebTreeEntryDto => ({
  id,
  parentId,
  role,
  kind: role,
  text,
});

const otherEntry = (
  id: string,
  parentId: string | null,
  extra: Partial<Pick<WebTreeEntryDto, "firstKeptEntryId" | "text">> = {},
): WebTreeEntryDto => ({ id, parentId, role: "other", kind: "other", text: "", ...extra });

const view = (key: string, role: "user" | "assistant"): SessionMessageView => ({
  key,
  role,
  text: "",
  streaming: false,
  error: false,
  order: 0,
});

describe("buildMessageTreeMeta", () => {
  // root has two version siblings: m1(user) -> a1(assistant) and
  // m2(user, edited) -> a2(assistant). The leaf determines which version
  // appears in the transcript.
  const tree = [
    entry("m1", null, "user", "v1"),
    entry("a1", "m1", "assistant", "r1"),
    entry("m2", null, "user", "v2"),
    entry("a2", "m2", "assistant", "r2"),
  ];

  it("zips leaf-path entries with view messages and computes version groups", () => {
    const messages = [view("k1", "user"), view("k2", "assistant")];
    const meta = buildMessageTreeMeta(messages, tree, "a2");
    expect(meta.k1).toEqual({ entryId: "m2", version: { index: 2, count: 2 } });
    expect(meta.k2).toEqual({ entryId: "a2" });
  });

  it("reflects the active version when the older branch is the leaf", () => {
    const messages = [view("k1", "user"), view("k2", "assistant")];
    const meta = buildMessageTreeMeta(messages, tree, "a1");
    expect(meta.k1).toEqual({ entryId: "m1", version: { index: 1, count: 2 } });
    expect(meta.k2).toEqual({ entryId: "a1" });
  });

  it("leaves out version info for single-version messages", () => {
    const meta = buildMessageTreeMeta([view("k1", "user")], [entry("m1", null, "user")], "m1");
    expect(meta.k1).toEqual({ entryId: "m1" });
  });

  it("walks through non-message entries so parent chains stay intact", () => {
    // thinking_level_change nodes sit between messages and must not break the zip
    const tree = [
      otherEntry("t1", null),
      entry("m1", "t1", "user"),
      entry("a1", "m1", "assistant"),
      otherEntry("t2", "a1"),
      entry("m2", "t2", "user"),
      entry("a2", "m2", "assistant"),
    ];
    const messages = [view("k1", "user"), view("k2", "assistant"), view("k3", "user"), view("k4", "assistant")];
    const meta = buildMessageTreeMeta(messages, tree, "a2");
    expect(meta.k1).toEqual({ entryId: "m1" });
    expect(meta.k2).toEqual({ entryId: "a1" });
    expect(meta.k3).toEqual({ entryId: "m2" });
    expect(meta.k4).toEqual({ entryId: "a2" });
  });

  it("mirrors pi compaction semantics (summarized entries omitted)", () => {
    const tree = [
      entry("m1", null, "user"),
      entry("a1", "m1", "assistant"),
      otherEntry("c1", "a1", { text: "summary", firstKeptEntryId: "m2" }),
      entry("m2", "c1", "user"),
      entry("a2", "m2", "assistant"),
    ];
    // transcript context: [compaction summary (system), m2, a2] -> zip sees [m2, a2]
    const messages = [view("k1", "user"), view("k2", "assistant")];
    const meta = buildMessageTreeMeta(messages, tree, "a2");
    expect(meta.k1).toEqual({ entryId: "m2" });
    expect(meta.k2).toEqual({ entryId: "a2" });
  });

  it("skips toolResult entries on both sides of the zip", () => {
    const tree = [
      entry("m1", null, "user"),
      entry("a1", "m1", "assistant"),
      otherEntry("tr1", "a1"),
      entry("m2", "tr1", "user"),
      entry("a2", "m2", "assistant"),
    ];
    const messages = [view("k1", "user"), view("k2", "assistant"), view("k3", "user"), view("k4", "assistant")];
    const meta = buildMessageTreeMeta(messages, tree, "a2");
    expect(meta.k1).toEqual({ entryId: "m1" });
    expect(meta.k2).toEqual({ entryId: "a1" });
    expect(meta.k3).toEqual({ entryId: "m2" });
    expect(meta.k4).toEqual({ entryId: "a2" });
  });
});

describe("versionTarget", () => {
  const tree = [
    entry("m1", null, "user"),
    entry("a1", "m1", "assistant"),
    entry("m2", null, "user"),
    entry("a2", "m2", "assistant"),
  ];

  it("returns the subtree leaf of the previous/next version", () => {
    expect(versionTarget(tree, "m2", -1)).toBe("a1");
    expect(versionTarget(tree, "m1", 1)).toBe("a2");
  });

  it("returns undefined past the group bounds or for non-user entries", () => {
    expect(versionTarget(tree, "m1", -1)).toBeUndefined();
    expect(versionTarget(tree, "m2", 1)).toBeUndefined();
    expect(versionTarget(tree, "a1", 1)).toBeUndefined();
    expect(versionTarget(tree, "missing", 1)).toBeUndefined();
  });

  it("falls back to the message itself when the version has no replies", () => {
    const bare = [entry("m1", null, "user"), entry("m2", null, "user")];
    expect(versionTarget(bare, "m2", -1)).toBe("m1");
  });
});
