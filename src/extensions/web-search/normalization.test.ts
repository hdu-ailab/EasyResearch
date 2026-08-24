import { describe, expect, it } from "vitest";
import { WEB_SEARCH_ENGINES } from "./contracts";
import {
  addOperationTimeoutFailures,
  buildEffectiveQuery,
  canonicalizeResultUrl,
  engineReliability,
  normalizePartialFailures,
  normalizeSearchResults,
  normalizeSite,
} from "./normalization";

describe("web-search normalization", () => {
  it("classifies every supported engine and only domestic fallbacks as low reliability", () => {
    expect(WEB_SEARCH_ENGINES.map((engine) => [engine, engineReliability(engine)]))
      .toEqual([
        ["duckduckgo", "high"],
        ["bing", "high"],
        ["brave", "high"],
        ["startpage", "high"],
        ["baidu", "low"],
        ["sogou", "low"],
      ]);
  });

  it("normalizes full URLs and bare site values to a lowercase hostname", () => {
    expect(normalizeSite("https://Docs.Example.com:8443/path?q=1#top"))
      .toBe("docs.example.com");
    expect(normalizeSite("Papers.Example.org/archive"))
      .toBe("papers.example.org");
    expect(buildEffectiveQuery("  bun compile  ", "https://Docs.Example.com/path"))
      .toBe("bun compile site:docs.example.com");
  });

  it("rejects site values that are not public HTTP domain restrictions", () => {
    for (const site of ["", "not a domain value", "localhost", "https://user:pass@example.com", "ftp://example.com"]) {
      expect(() => normalizeSite(site)).toThrow(/valid domain/i);
    }
  });

  it("trims the query and rejects an empty effective query", () => {
    expect(buildEffectiveQuery("  quoted phrase  ")).toBe("quoted phrase");
    expect(() => buildEffectiveQuery("   ")).toThrow(/query/i);
  });

  it("canonicalizes HTTP URLs without merging schemes or removing query parameters", () => {
    expect(canonicalizeResultUrl("HTTPS://Example.com/p?a=1#top"))
      .toBe("https://example.com/p?a=1");
    expect(canonicalizeResultUrl("http://example.com/p?a=1"))
      .toBe("http://example.com/p?a=1");
    expect(canonicalizeResultUrl("https://example.com/p?a=2"))
      .toBe("https://example.com/p?a=2");
    expect(canonicalizeResultUrl("ftp://example.com/file")).toBeUndefined();
    expect(canonicalizeResultUrl("not a URL")).toBeUndefined();
  });

  it("orders results by requested engine and accumulates duplicate provenance", () => {
    const results = normalizeSearchResults([
      { title: "Bing first upstream", url: "https://EXAMPLE.com/p?a=1#x", description: "B", source: "bing source", engine: "bing" },
      { title: "Duck first by request", url: "https://example.com/p?a=1#y", description: "D", source: "duck source", engine: "duckduckgo" },
      { title: "HTTP remains distinct", url: "http://example.com/p?a=1", description: "H", source: "http source", engine: "duckduckgo" },
      { title: "Duplicate same engine", url: "https://example.com/p?a=1", description: "ignored", source: "ignored", engine: "duckduckgo" },
    ], ["duckduckgo", "bing"], 10);

    expect(results).toEqual([
      {
        title: "Duck first by request",
        url: "https://example.com/p?a=1#y",
        abstract: "D",
        source: "duck source",
        engine: "duckduckgo",
        engineReliability: "high",
        matchedEngines: ["duckduckgo", "bing"],
      },
      {
        title: "HTTP remains distinct",
        url: "http://example.com/p?a=1",
        abstract: "H",
        source: "http source",
        engine: "duckduckgo",
        engineReliability: "high",
        matchedEngines: ["duckduckgo"],
      },
    ]);
  });

  it("rejects malformed rows and applies the total limit after requested-engine ordering", () => {
    const results = normalizeSearchResults([
      { title: "Unrequested", url: "https://exa.ai", description: "x", source: "x", engine: "exa" },
      { title: "", url: "https://empty.example", description: "x", source: "x", engine: "duckduckgo" },
      { title: "FTP", url: "ftp://example.com", description: "x", source: "x", engine: "duckduckgo" },
      { title: "Bing", url: "https://bing.example", description: "b", source: "b", engine: "bing" },
      { title: "Duck", url: "https://duck.example", description: "d", source: "d", engine: "duckduckgo" },
      null,
    ], ["duckduckgo", "bing"], 1);

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("Duck");
  });

  it("orders one usable partial failure per requested engine", () => {
    const failures = normalizePartialFailures([
      { engine: "bing", code: "engine_error", message: "blocked" },
      { engine: "duckduckgo", code: "first", message: "failed" },
      { engine: "duckduckgo", code: "second", message: "duplicate" },
      { engine: "brave", code: "", message: "malformed" },
      { engine: "exa", code: "ignored", message: "not requested" },
    ], ["duckduckgo", "bing", "brave"]);

    expect(failures).toEqual([
      { engine: "duckduckgo", code: "first", message: "failed", engineReliability: "high" },
      { engine: "bing", code: "engine_error", message: "blocked", engineReliability: "high" },
    ]);
  });

  it("synthesizes timeout failures only for engines with no result or failure", () => {
    const results = normalizeSearchResults([
      { title: "Bing", url: "https://bing.example", description: "b", source: "b", engine: "bing" },
    ], ["duckduckgo", "bing", "brave"], 10);
    const failures = normalizePartialFailures([
      { engine: "duckduckgo", code: "engine_error", message: "failed" },
    ], ["duckduckgo", "bing", "brave"]);

    expect(addOperationTimeoutFailures(results, failures, ["duckduckgo", "bing", "brave"]))
      .toEqual([
        { engine: "duckduckgo", code: "engine_error", message: "failed", engineReliability: "high" },
        {
          engine: "brave",
          code: "operation_timeout",
          message: "The search operation deadline expired before this engine produced a result or failure.",
          engineReliability: "high",
        },
      ]);
  });
});
