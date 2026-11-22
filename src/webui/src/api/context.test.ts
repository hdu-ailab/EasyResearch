import { afterEach, describe, expect, it, vi } from "vitest";
import { contextPreview, contextSnapshot } from "../testing/context";
import { applyContextEdits, getContextItemText, getSessionContext, previewContextEdits } from "./context";
import { parseContextItemText, parseContextPreview, parseContextSnapshot } from "./context-parsers";
import { ApiError } from "./transport";

afterEach(() => vi.unstubAllGlobals());
describe("context HTTP boundary", () => {
  it("encodes identities, preserves ordered scope edits and forwards cancellation", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(contextSnapshot()))
      .mockResolvedValueOnce(
        Response.json({
          revision: "r/?",
          itemId: "tool/#",
          view: "original",
          text: "abc",
          offset: 10,
          totalChars: 13,
          nextOffset: null,
        }),
      )
      .mockResolvedValueOnce(Response.json(contextPreview()))
      .mockResolvedValueOnce(Response.json(contextSnapshot("r2")));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    await getSessionContext("root/?", controller.signal);
    await getContextItemText("root/?", "r/?", "tool/#", "original", 10, controller.signal);
    const edits = {
      revision: "r1",
      edits: [
        { target: "segment" as const, id: "first", action: "delete" as const },
        { target: "item" as const, id: "result", action: "reset" as const },
      ],
    };
    await previewContextEdits("root/?", edits, controller.signal);
    await applyContextEdits("root/?", edits, controller.signal);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/sessions/root%2F%3F/context");
    const query = new URL(fetch.mock.calls[1]?.[0] as string, "https://local.test").searchParams;
    expect(Object.fromEntries(query)).toEqual({ revision: "r/?", itemId: "tool/#", view: "original", offset: "10" });
    for (const call of fetch.mock.calls.slice(2)) {
      expect(call[1]).toMatchObject({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      });
      expect(JSON.parse(call[1].body)).toEqual(edits);
    }
  });

  it("preserves safe error codes for draft recovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ code: "CONTEXT_STALE", error: "Refresh context" }, { status: 409 })),
    );
    const result = getSessionContext("s1");
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({ status: 409, details: { code: "CONTEXT_STALE" } });
  });

  it("rejects invalid identities, percentages, unbounded metadata and broken page cursors", () => {
    const snapshot = contextSnapshot();
    expect(parseContextSnapshot(snapshot)).toEqual(snapshot);
    expect(() => parseContextSnapshot({ ...snapshot, items: [...snapshot.items, snapshot.items[0]] })).toThrow();
    expect(() =>
      parseContextSnapshot({ ...snapshot, segments: [{ ...snapshot.segments[0], itemIds: ["missing"] }] }),
    ).toThrow();
    expect(() =>
      parseContextSnapshot({ ...snapshot, items: snapshot.items.map((item) => ({ ...item, percent: NaN })) }),
    ).toThrow();
    expect(() =>
      parseContextSnapshot({
        ...snapshot,
        items: snapshot.items.map((item) => ({ ...item, preview: "😀".repeat(241) })),
      }),
    ).toThrow();
    expect(() =>
      parseContextPreview({
        ...contextPreview(),
        cache: { basis: "unchanged-prefix", hitRate: 1.1, reusableTokens: 4 },
      }),
    ).toThrow();
    expect(
      parseContextPreview({
        ...contextPreview(),
        cache: { basis: "unchanged-prefix", hitRate: null, reusableTokens: null },
      }).cache.hitRate,
    ).toBeNull();
    expect(() =>
      parseContextItemText({
        revision: "r1",
        itemId: "i",
        view: "original",
        text: "text",
        offset: 5,
        totalChars: 20,
        nextOffset: 5,
      }),
    ).toThrow();
  });
});
