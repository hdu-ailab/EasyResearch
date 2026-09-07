import { describe, expect, it } from "vitest";
import type { WebTreeEntryDto } from "../../web/contracts";
import { buildMessageTreeMeta, versionTarget } from "./message-tree";
import { fromSnapshot, type SessionMessageView } from "./session-reducer";

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

const view = (key: string, role: "user" | "assistant", entryId?: string): SessionMessageView => ({
  key,
  ...(entryId === undefined ? {} : { entryId }),
  role,
  text: "",
  streaming: false,
  error: false,
  order: 0,
});

describe("buildMessageTreeMeta", () => {
  it.each([false, true])("keeps persisted ancestry after tool-only messages (usage: %s)", (withUsage) => {
    const state = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "s", status: "ready", isStreaming: false },
      subagents: [],
      timeline: [
        { kind: "message", entryId: "u1", message: { role: "user", content: "Question" } },
        {
          kind: "message",
          entryId: "call",
          message: { role: "assistant", content: [{ type: "toolCall", id: "tool", name: "bash", arguments: {} }] },
        },
        { kind: "message", entryId: "result", message: { role: "toolResult", toolCallId: "tool", content: "result" } },
        { kind: "message", entryId: "answer", message: { role: "assistant", content: "Answer" } },
        { kind: "message", entryId: "u2", message: { role: "user", content: "Follow-up" } },
      ],
      inlineUsage: withUsage
        ? [
            {
              id: "call",
              sessionId: "s",
              source: "assistant",
              timestamp: "2026-09-07T00:00:00Z",
              anchor: { kind: "message", messageEntryId: "call" },
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cacheHitRate: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
          ]
        : [],
    } as never);
    const tree = [
      entry("u1", null, "user"),
      entry("call", "u1", "assistant"),
      otherEntry("result", "call"),
      entry("answer", "result", "assistant"),
      entry("u2-old", "answer", "user"),
      entry("u2", "answer", "user"),
    ];
    const meta = buildMessageTreeMeta(state.messages, tree, "u2");
    expect(meta.u1).toEqual({ entryId: "u1" });
    expect(meta.answer).toEqual({ entryId: "answer" });
    expect(meta.u2).toEqual({ entryId: "u2", version: { index: 2, count: 2 } });
    expect(meta["usage:call"]).toBeUndefined();
  });

  it("keeps the full persisted active branch editable across compaction", () => {
    const tree = [
      entry("u1", null, "user"),
      entry("a1", "u1", "assistant"),
      entry("u2", "a1", "user"),
      otherEntry("compact", "u2", { firstKeptEntryId: "u2" }),
      entry("a2", "compact", "assistant"),
    ];
    const messages = [view("u1", "user"), view("a1", "assistant"), view("u2", "user"), view("a2", "assistant")].map(
      (message) => ({ ...message, entryId: message.key }),
    );
    const meta = buildMessageTreeMeta(messages, tree, "a2");
    for (const message of messages) expect(meta[message.key]?.entryId).toBe(message.entryId);
  });

  it("does not guess ancestry for persisted ids absent from the active branch", () => {
    const meta = buildMessageTreeMeta(
      [{ ...view("old", "user"), entryId: "old" }],
      [entry("old", null, "user"), entry("current", null, "user")],
      "current",
    );
    expect(meta.old).toBeUndefined();
  });

  it("keeps live user ancestry independent of hidden assistant tool calls", () => {
    const messages = [view("live-u1", "user"), view("live-answer", "assistant"), view("live-u2", "user")];
    const tree = [
      entry("u1", null, "user"),
      entry("call", "u1", "assistant"),
      entry("answer", "call", "assistant"),
      entry("u2", "answer", "user"),
    ];
    const meta = buildMessageTreeMeta(messages, tree, "u2");
    expect(meta["live-u1"]).toEqual({ entryId: "u1" });
    expect(meta["live-u2"]).toEqual({ entryId: "u2" });
  });

  // root has two version siblings: m1(user) -> a1(assistant) and
  // m2(user, edited) -> a2(assistant). The leaf determines which version
  // appears in the transcript.
  const tree = [
    entry("m1", null, "user", "v1"),
    entry("a1", "m1", "assistant", "r1"),
    entry("m2", null, "user", "v2"),
    entry("a2", "m2", "assistant", "r2"),
  ];

  it("joins active leaf-path entries with view messages and computes version groups", () => {
    const messages = [view("k1", "user", "m2"), view("k2", "assistant", "a2")];
    const meta = buildMessageTreeMeta(messages, tree, "a2");
    expect(meta.k1).toEqual({ entryId: "m2", version: { index: 2, count: 2 } });
    expect(meta.k2).toEqual({ entryId: "a2" });
  });

  it("reflects the active version when the older branch is the leaf", () => {
    const messages = [view("k1", "user", "m1"), view("k2", "assistant", "a1")];
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
    const messages = [
      view("k1", "user", "m1"),
      view("k2", "assistant", "a1"),
      view("k3", "user", "m2"),
      view("k4", "assistant", "a2"),
    ];
    const meta = buildMessageTreeMeta(messages, tree, "a2");
    expect(meta.k1).toEqual({ entryId: "m1" });
    expect(meta.k2).toEqual({ entryId: "a1" });
    expect(meta.k3).toEqual({ entryId: "m2" });
    expect(meta.k4).toEqual({ entryId: "a2" });
  });

  it("maps persisted ids even when only part of the branch has visible bubbles", () => {
    const tree = [
      entry("m1", null, "user"),
      entry("a1", "m1", "assistant"),
      otherEntry("c1", "a1", { text: "summary", firstKeptEntryId: "m2" }),
      entry("m2", "c1", "user"),
      entry("a2", "m2", "assistant"),
    ];
    const messages = [view("k1", "user", "m2"), view("k2", "assistant", "a2")];
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
    const messages = [
      view("k1", "user", "m1"),
      view("k2", "assistant", "a1"),
      view("k3", "user", "m2"),
      view("k4", "assistant", "a2"),
    ];
    const meta = buildMessageTreeMeta(messages, tree, "a2");
    expect(meta.k1).toEqual({ entryId: "m1" });
    expect(meta.k2).toEqual({ entryId: "a1" });
    expect(meta.k3).toEqual({ entryId: "m2" });
    expect(meta.k4).toEqual({ entryId: "a2" });
  });

  it("does not let standalone usage rows shift message ancestry", () => {
    const messages = [
      view("k1", "user", "m1"),
      { ...view("usage", "assistant"), usageOnly: true },
      view("k2", "assistant", "a1"),
    ];
    const meta = buildMessageTreeMeta(messages, [entry("m1", null, "user"), entry("a1", "m1", "assistant")], "a1");
    expect(meta.k1).toEqual({ entryId: "m1" });
    expect(meta.k2).toEqual({ entryId: "a1" });
    expect(meta.usage).toBeUndefined();
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
