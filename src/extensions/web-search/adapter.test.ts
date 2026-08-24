import { describe, expect, it, vi } from "vitest";
import type {
  OpenWebSearchRequest,
  OpenWebSearchResponse,
  OpenWebSearchService,
  WebSearchInput,
} from "./contracts";
import {
  createAbortError,
  createWebSearchAdapter,
  serializeWebSearch,
} from "./adapter";

const emptyResponse = (input: OpenWebSearchRequest): OpenWebSearchResponse => ({
  query: input.query,
  engines: input.engines,
  totalResults: 0,
  results: [],
  partialFailures: [],
});

function service(
  execute: (input: OpenWebSearchRequest) => Promise<OpenWebSearchResponse>,
): OpenWebSearchService {
  return { execute };
}

describe("web-search adapter validation", () => {
  it.each([
    [{ query: " ", engines: ["duckduckgo"] }, /query/i],
    [{ query: "q", engines: [] }, /engine/i],
    [{ query: "q", engines: ["duckduckgo", "duckduckgo"] }, /unique/i],
    [{ query: "q", engines: ["google"] }, /supported/i],
    [{ query: "q", engines: ["duckduckgo"], num: 0 }, /1.*25/i],
    [{ query: "q", engines: ["duckduckgo"], num: 1.5 }, /integer/i],
    [{ query: "q", engines: ["duckduckgo", "bing", "brave"], num: 2 }, /at least.*selected engine/i],
  ])("rejects invalid input before package execution", async (raw, expected) => {
    const execute = vi.fn();
    const adapter = createWebSearchAdapter(service(execute));

    await expect(adapter.search(raw as WebSearchInput)).rejects.toThrow(expected as RegExp);
    expect(execute).not.toHaveBeenCalled();
  });

  it("defaults to ten results and always sends request mode after site normalization", async () => {
    const execute = vi.fn(async (input: OpenWebSearchRequest) => emptyResponse(input));
    const adapter = createWebSearchAdapter(service(execute));

    const result = await adapter.search({
      query: "  bun compile  ",
      engines: ["duckduckgo", "bing"],
      site: "https://Docs.Example.com/path",
    });

    expect(execute).toHaveBeenCalledWith({
      query: "bun compile site:docs.example.com",
      engines: ["duckduckgo", "bing"],
      limit: 10,
      searchMode: "request",
    });
    expect(result.effectiveQuery).toBe("bun compile site:docs.example.com");
  });
});

describe("web-search adapter outcomes", () => {
  it("keeps partial results and ordered failures", async () => {
    const adapter = createWebSearchAdapter(service(async (input) => ({
      ...emptyResponse(input),
      totalResults: 1,
      results: [{
        title: "Result",
        url: "https://example.com",
        description: "Lead",
        source: "Example",
        engine: "bing",
      }],
      partialFailures: [{ engine: "duckduckgo", code: "engine_error", message: "blocked" }],
    })));

    const result = await adapter.search({ query: "q", engines: ["duckduckgo", "bing"] });

    expect(result.results).toHaveLength(1);
    expect(result.partialFailures).toEqual([
      { engine: "duckduckgo", code: "engine_error", message: "blocked", engineReliability: "high" },
    ]);
    expect(result.allEnginesFailed).toBe(false);
  });

  it("distinguishes total failure from mixed and clean empty responses", async () => {
    const total = createWebSearchAdapter(service(async (input) => ({
      ...emptyResponse(input),
      partialFailures: input.engines.map((engine) => ({ engine, code: "engine_error", message: "failed" })),
    })));
    const mixed = createWebSearchAdapter(service(async (input) => ({
      ...emptyResponse(input),
      partialFailures: [{ engine: input.engines[0]!, code: "engine_error", message: "failed" }],
    })));
    const clean = createWebSearchAdapter(service(async (input) => emptyResponse(input)));

    await expect(total.search({ query: "q", engines: ["duckduckgo", "bing"] }))
      .resolves.toMatchObject({ allEnginesFailed: true });
    await expect(mixed.search({ query: "q", engines: ["duckduckgo", "bing"] }))
      .resolves.toMatchObject({ allEnginesFailed: false, results: [] });
    await expect(clean.search({ query: "q", engines: ["duckduckgo", "bing"] }))
      .resolves.toMatchObject({ allEnginesFailed: false, results: [], partialFailures: [] });
  });

  it("propagates an unexpected package failure for the tool layer", async () => {
    const adapter = createWebSearchAdapter(service(async () => {
      throw new Error("package exploded");
    }));

    await expect(adapter.search({ query: "q", engines: ["duckduckgo"] }))
      .rejects.toThrow("package exploded");
  });

  it("gives Pi Stop precedence over a package response", async () => {
    const controller = new AbortController();
    const adapter = createWebSearchAdapter(service(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return emptyResponse(input);
    }));

    const pending = adapter.search({ query: "q", engines: ["duckduckgo"] }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
});

describe("web-search serialization", () => {
  it("does not let a canceled waiter release a later call over its predecessor", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = serializeWebSearch(async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first:end");
    });
    await Promise.resolve();
    const controller = new AbortController();
    const canceled = serializeWebSearch(async () => {
      events.push("canceled:ran");
    }, controller.signal);
    const third = serializeWebSearch(async () => {
      events.push("third:start");
    });

    controller.abort();
    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, third]);
    expect(events).toEqual(["first:start", "first:end", "third:start"]);
  });

  it("creates canonical AbortError values", () => {
    expect(createAbortError()).toMatchObject({ name: "AbortError", message: "Search cancelled" });
  });
});
