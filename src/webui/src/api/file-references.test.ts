import { afterEach, describe, expect, it, vi } from "vitest";
import { parseFileReferences, resolveFileReferences } from "./file-references";

afterEach(() => vi.unstubAllGlobals());
describe("typed file reference API", () => {
  it("passes literal reference bytes and cancellation without URL rewriting", async () => {
    const reference = "reports/100% #报告.txt";
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ references: [{ reference, paths: [`/p/${reference}`], truncated: false }] })),
      );
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    expect((await resolveFileReferences("s/1", [reference], controller.signal)).references[0]?.reference).toBe(
      reference,
    );
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/sessions/s%2F1/file-references/resolve");
    expect(JSON.parse(init.body)).toEqual({ references: [reference] });
    expect(init.signal).toBe(controller.signal);
  });
  it("rejects unbounded, relative or malformed server results", () => {
    for (const entry of [
      { reference: "a", paths: ["relative"], truncated: false },
      { reference: "a", paths: ["/p/a"], truncated: "false" },
      { reference: "a", paths: Array(129).fill("/p/a"), truncated: false },
    ])
      expect(() => parseFileReferences({ references: [entry] })).toThrow();
  });
});
