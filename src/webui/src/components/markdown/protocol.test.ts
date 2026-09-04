import { describe, expect, it } from "vitest";
import { isMarkdownWorkerResponse, parseMarkdownWorkerRequest } from "./protocol";

describe("Markdown worker protocol", () => {
  it("accepts a complete parse request", () => {
    const value = { type: "parse", scope: "session", key: "message:text", revision: 2, source: "hello" };
    expect(parseMarkdownWorkerRequest(value)).toEqual(value);
  });

  it("rejects malformed request identity", () => {
    expect(parseMarkdownWorkerRequest({ type: "parse", scope: "", key: "k", revision: 0, source: "x" })).toBeNull();
    expect(parseMarkdownWorkerRequest({ type: "parse", scope: "s", key: "k", revision: -1, source: "x" })).toBeNull();
  });

  it("rejects a success response with a non-integer revision", () => {
    expect(
      isMarkdownWorkerResponse({
        type: "parsed",
        scope: "s",
        key: "k",
        revision: 1.5,
        source: "x",
        blocks: [],
      }),
    ).toBe(false);
  });

  it("accepts signed root blocks and safe failures", () => {
    expect(
      isMarkdownWorkerResponse({
        type: "parsed",
        scope: "s",
        key: "k",
        revision: 1,
        source: "x",
        blocks: [{ signature: "a".repeat(64), tree: { type: "root", children: [{ type: "text", value: "x" }] } }],
      }),
    ).toBe(true);
    expect(
      isMarkdownWorkerResponse({ type: "error", scope: "s", key: "k", revision: 1, source: "x", message: "bad" }),
    ).toBe(true);
  });

  it("rejects prototype-bearing protocol records", () => {
    const value = Object.create({ type: "parsed" }) as Record<string, unknown>;
    Object.assign(value, { scope: "s", key: "k", revision: 1, source: "x", blocks: [] });
    expect(isMarkdownWorkerResponse(value)).toBe(false);
  });
});
