import { readFileSync } from "node:fs";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureInheritedProxyEnvironment,
  parseNetworkProxySettings,
  resolveNetworkPolicy,
} from "../../runtime/network-policy";
import {
  createAppliedSearchRoute,
  type AppliedSearchRoute,
} from "../../runtime/network-routing";
import type { WebSearchAdapter } from "./adapter";
import { createAbortError, createWebSearchAdapter } from "./adapter";
import type {
  OpenWebSearchService,
  WebSearchDetails,
  WebSearchExecution,
  WebSearchResult,
} from "./contracts";
import { WEB_SEARCH_ENGINES } from "./contracts";
import {
  COLLAPSED_LINE_MAX_CHARS,
  compactLine,
  createWebSearchExtension,
  createWebSearchTool,
  formatPartialFailures,
  formatResults,
  textContent,
  truncateOutput,
} from "./index";
import {
  FIXED_OPEN_WEBSEARCH_CONFIG,
  type InitializedOpenWebSearchRuntime,
} from "./runtime";
import type { SearchRequestRouting } from "./request-context";

const loggerError = vi.hoisted(() => vi.fn());

const directRequestRouting: SearchRequestRouting = Object.freeze({
  bypasses: () => false,
  directAgentsFor: () => undefined,
});

vi.mock("../../runtime/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: loggerError }),
}));

afterEach(() => {
  loggerError.mockClear();
});

function appliedSearchRoute(
  settings: unknown = {},
  environment: Record<string, string | undefined> = {},
): AppliedSearchRoute {
  return createAppliedSearchRoute(resolveNetworkPolicy(
    parseNetworkProxySettings(settings),
    captureInheritedProxyEnvironment(environment),
  ));
}

const result: WebSearchResult = {
  title: "Fixture title",
  url: "https://fixture.example/paper",
  abstract: "Fixture abstract",
  source: "Fixture source",
  engine: "duckduckgo",
  engineReliability: "high",
  matchedEngines: ["duckduckgo", "bing"],
};

const execution = (overrides: Partial<WebSearchExecution> = {}): WebSearchExecution => ({
  engines: ["duckduckgo", "bing"],
  effectiveQuery: "fixture",
  results: [result],
  partialFailures: [],
  allEnginesFailed: false,
  ...overrides,
});

function adapter(output: WebSearchExecution | Error): WebSearchAdapter {
  return {
    search: vi.fn(async () => {
      if (output instanceof Error) throw output;
      return output;
    }),
  };
}

async function executeTool(output: WebSearchExecution | Error) {
  const tool = createWebSearchTool(adapter(output));
  return tool.execute("call", {
    query: "fixture",
    engines: ["duckduckgo", "bing"],
    num: 10,
  }, undefined, undefined, {} as never);
}

describe("web-search tool contract", () => {
  it("requires explicit supported unique engines and omits the time input", () => {
    const tool = createWebSearchTool(adapter(execution()));
    const parameters = tool.parameters as {
      properties: Record<string, unknown>;
    };

    for (const engine of WEB_SEARCH_ENGINES) {
      expect(Value.Check(tool.parameters, { query: "q", engines: [engine] })).toBe(true);
    }
    expect(Value.Check(tool.parameters, { query: "q" })).toBe(false);
    expect(Value.Check(tool.parameters, { query: "q", engines: [] })).toBe(false);
    expect(Value.Check(tool.parameters, { query: "q", engines: ["google"] })).toBe(false);
    expect(Value.Check(tool.parameters, { query: "q", engines: ["bing", "bing"] })).toBe(false);
    expect(parameters.properties.time).toBeUndefined();
    expect(parameters.properties.site).toBeDefined();
  });

  it("guides engine fallback and source verification without treating reliability as truth", () => {
    const tool = createWebSearchTool(adapter(execution()));
    const guidance = [tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join("\n");

    expect(guidance).toMatch(/DuckDuckGo.*first/is);
    expect(guidance).toMatch(/Bing.*Brave.*Startpage/is);
    expect(guidance).toMatch(/Baidu.*Sogou.*fallback/is);
    expect(guidance).toMatch(/channel.*not.*fact/is);
    expect(guidance).toMatch(/webfetch/is);
    expect(guidance).toMatch(/Google.*Playwright/is);
    expect(guidance).toMatch(/empty.*inconclusive/is);
  });

  it("uses the adapter's default limit when num is omitted from tool execution", async () => {
    const service: OpenWebSearchService = {
      execute: vi.fn(async (input) => ({
        query: input.query,
        engines: input.engines,
        totalResults: 0,
        results: [],
        partialFailures: [],
      })),
    };
    const tool = createWebSearchTool(createWebSearchAdapter(service));

    await tool.execute(
      "call",
      { query: "fixture", engines: ["duckduckgo", "bing"] },
      undefined,
      undefined,
      {} as never,
    );

    expect(service.execute).toHaveBeenCalledWith({
      query: "fixture",
      engines: ["duckduckgo", "bing"],
      limit: 10,
      searchMode: "request",
    });
  });

  it("returns every normalized field and structured details", async () => {
    const output = await executeTool(execution());
    const text = textContent(output);

    expect(text).toContain("Result 1");
    expect(text).toContain("Title: Fixture title");
    expect(text).toContain("URL: https://fixture.example/paper");
    expect(text).toContain("Abstract: Fixture abstract");
    expect(text).toContain("Source: Fixture source");
    expect(text).toContain("Engine: duckduckgo");
    expect(text).toContain("Engine reliability: high");
    expect(text).toContain("Matched engines: duckduckgo, bing");
    expect(output.details).toMatchObject({
      engines: ["duckduckgo", "bing"],
      results: [result],
      count: 1,
      partialFailures: [],
    });
  });

  it("keeps successful results when a sibling engine fails", async () => {
    const output = await executeTool(execution({
      partialFailures: [{
        engine: "bing",
        code: "engine_error",
        message: "blocked",
        engineReliability: "high",
      }],
    }));

    expect(textContent(output)).toContain("Partial engine failures");
    expect(textContent(output)).toContain("bing [high] engine_error: blocked");
    expect(output.details).not.toHaveProperty("error");
  });

  it("uses details.error only when every selected engine failed", async () => {
    const failures = [
      { engine: "duckduckgo" as const, code: "engine_error", message: "blocked", engineReliability: "high" as const },
      { engine: "bing" as const, code: "engine_error", message: "blocked", engineReliability: "high" as const },
    ];
    const output = await executeTool(execution({
      results: [],
      partialFailures: failures,
      allEnginesFailed: true,
    }));

    expect(textContent(output)).toMatch(/every selected search engine failed/i);
    expect(output.details).toMatchObject({ error: "Every selected search engine failed.", partialFailures: failures });
  });

  it("reports mixed and clean empty responses as inconclusive without details.error", async () => {
    const mixed = await executeTool(execution({
      results: [],
      partialFailures: [{
        engine: "duckduckgo",
        code: "engine_error",
        message: "blocked",
        engineReliability: "high",
      }],
    }));
    const clean = await executeTool(execution({ results: [] }));

    expect(textContent(mixed)).toMatch(/some engines failed.*remaining engines returned no usable results/is);
    expect(mixed.details).not.toHaveProperty("error");
    expect(textContent(clean)).toMatch(/inconclusive.*throttling/is);
    expect(clean.details).not.toHaveProperty("error");
  });

  it("converts unexpected failures to visible errors", async () => {
    const failed = await executeTool(new Error("package exploded"));
    expect(textContent(failed)).toContain("Search failed: package exploded");
    expect(failed.details).toMatchObject({ error: "package exploded" });
  });

  it("rethrows the original AbortError without replacing its identity", async () => {
    const abortError = createAbortError("original cancellation");
    abortError.stack = "original abort stack";

    await expect(executeTool(abortError)).rejects.toBe(abortError);
  });

  it("synthesizes an AbortError when Stop accompanies a non-abort adapter failure", async () => {
    const controller = new AbortController();
    const tool = createWebSearchTool({
      search: vi.fn(async () => {
        controller.abort();
        throw new Error("adapter failed after Stop");
      }),
    });

    await expect(tool.execute(
      "call",
      { query: "fixture", engines: ["duckduckgo"] },
      controller.signal,
      undefined,
      {} as never,
    )).rejects.toMatchObject({ name: "AbortError", message: "Search cancelled" });
  });
});

describe("web-search formatting and rendering", () => {
  it("formats result and failure provenance", () => {
    expect(formatResults([result])).toContain("Matched engines: duckduckgo, bing");
    expect(formatPartialFailures([{
      engine: "baidu",
      code: "operation_timeout",
      message: "timed out",
      engineReliability: "low",
    }])).toBe("Partial engine failures\n- baidu [low] operation_timeout: timed out");
  });

  it("compacts long call text", () => {
    expect(compactLine("  hello   world ")).toBe("hello world");
    const compact = compactLine("x".repeat(COLLAPSED_LINE_MAX_CHARS + 20));
    expect(Array.from(compact)).toHaveLength(COLLAPSED_LINE_MAX_CHARS);
    expect(compact.endsWith("...")).toBe(true);
  });

  it("renders collapsed results with title and URL", async () => {
    const tool = createWebSearchTool(adapter(execution()));
    const output = await tool.execute(
      "call",
      { query: "fixture", engines: ["duckduckgo", "bing"] },
      undefined,
      undefined,
      {} as never,
    );
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const rendered = tool.renderResult?.(
      output,
      { expanded: false, isPartial: false },
      theme as never,
      {} as never,
    );

    expect(rendered?.render(200).join("\n")).toContain("1. Fixture title");
    expect(rendered?.render(200).join("\n")).toContain("https://fixture.example/paper");
  });

  it("renders expanded results with complete provenance", async () => {
    const tool = createWebSearchTool(adapter(execution()));
    const output = await executeTool(execution());
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };

    const rendered = tool.renderResult?.(
      output,
      { expanded: true, isPartial: false },
      theme as never,
      {} as never,
    );
    const text = rendered?.render(200).join("\n");

    expect(text).toContain("Abstract: Fixture abstract");
    expect(text).toContain("Engine reliability: high");
    expect(text).toContain("Matched engines: duckduckgo, bing");
  });

  it("propagates the complete-output path when tool execution truncates results", async () => {
    const largeResult = { ...result, abstract: "x".repeat(60_000) };
    const output = await executeTool(execution({ results: [largeResult] }));
    const details = output.details as WebSearchDetails;

    expect(textContent(output)).toContain("[Output truncated:");
    expect(details.fullOutputPath).toEqual(expect.any(String));
    expect(readFileSync(details.fullOutputPath!, "utf8")).toBe(formatResults([largeResult]));
  });

  it("writes complete output to a temp file when Pi truncates it", async () => {
    const big = Array.from({ length: 10_000 }, (_, index) => `line ${index} ${"x".repeat(80)}`).join("\n");
    const output = await truncateOutput(big);

    expect(output.text).toContain("[Output truncated:");
    expect(output.fullOutputPath).toBeDefined();
    expect(readFileSync(output.fullOutputPath!, "utf8")).toBe(big);
  });
});

describe("web-search async extension", () => {
  it("registers only after exact runtime initialization succeeds", async () => {
    const fakeService: OpenWebSearchService = {
      execute: vi.fn(async (input) => ({
        query: input.query,
        engines: input.engines,
        totalResults: 0,
        results: [],
        partialFailures: [],
      })),
    };
    let resolve!: (runtime: InitializedOpenWebSearchRuntime) => void;
    const initializeRuntime = vi.fn(() => new Promise<InitializedOpenWebSearchRuntime>((next) => {
      resolve = next;
    }));
    const registerTool = vi.fn();
    const factory: ExtensionFactory = createWebSearchExtension({ initializeRuntime });

    const pending = factory({ registerTool } as never);
    expect(registerTool).not.toHaveBeenCalled();
    resolve({
      config: FIXED_OPEN_WEBSEARCH_CONFIG,
      requestRouting: directRequestRouting,
      search: fakeService,
    });
    await pending;

    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool.mock.calls[0]?.[0].name).toBe("web-search");
  });

  it("registers the normal tool for invalid Search policy and fails safely only on execute", async () => {
    const initializeRuntime = vi.fn(async () => {
      throw new Error("Open-WebSearch must not initialize");
    });
    const registerTool = vi.fn();
    const factory: ExtensionFactory = createWebSearchExtension({
      appliedSearchRoute: appliedSearchRoute({
        httpProxy: "http://all.proxy:8000",
        easyresearch: { network: { searchProxy: "not-a-proxy" } },
      }),
      initializeRuntime,
    });

    await expect(factory({ registerTool } as never)).resolves.toBeUndefined();

    expect(initializeRuntime).not.toHaveBeenCalled();
    expect(registerTool).toHaveBeenCalledTimes(1);
    const tool = registerTool.mock.calls[0]?.[0];
    expect(tool.name).toBe("web-search");
    const output = await tool.execute(
      "call",
      { query: "fixture", engines: ["duckduckgo"] },
      undefined,
      undefined,
      {} as never,
    );
    expect(textContent(output)).toContain("NETWORK_PROXY_INVALID");
    expect(output.details).toMatchObject({ error: expect.stringContaining("NETWORK_PROXY_INVALID") });
  });

  it("retains construction rejection for ordinary Open-WebSearch initialization failures", async () => {
    const initializationError = new Error("Open-WebSearch package exploded");
    const registerTool = vi.fn();
    const factory: ExtensionFactory = createWebSearchExtension({
      appliedSearchRoute: appliedSearchRoute(),
      initializeRuntime: vi.fn(async () => {
        throw initializationError;
      }),
    });

    await expect(factory({ registerTool } as never)).rejects.toBe(initializationError);
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("redacts configured and inherited proxy URLs plus userinfo from tool and log errors", async () => {
    const configuredProxy = "http://configured.proxy:8001";
    const inheritedProxy = "http://ambient-user:ambient-secret@ambient.proxy:9000";
    const arbitraryProxy = "https://other-user:other-secret@other.proxy/path";
    const fakeService: OpenWebSearchService = {
      execute: vi.fn(async () => {
        throw new Error(`connect ${configuredProxy} via ${inheritedProxy}; fallback ${arbitraryProxy}`);
      }),
    };
    const registerTool = vi.fn();
    const factory: ExtensionFactory = createWebSearchExtension({
      appliedSearchRoute: appliedSearchRoute({
        easyresearch: { network: { searchProxy: configuredProxy } },
      }, {
        HTTPS_PROXY: inheritedProxy,
      }),
      initializeRuntime: vi.fn(async () => ({
        config: FIXED_OPEN_WEBSEARCH_CONFIG,
        requestRouting: directRequestRouting,
        search: fakeService,
      })),
    });
    await factory({ registerTool } as never);

    const output = await registerTool.mock.calls[0]?.[0].execute(
      "call",
      { query: "fixture", engines: ["duckduckgo"] },
      undefined,
      undefined,
      {} as never,
    );
    const visible = `${textContent(output)}\n${JSON.stringify(output.details)}\n${JSON.stringify(loggerError.mock.calls)}`;

    expect(visible).toContain("Search failed:");
    expect(visible).not.toContain(configuredProxy);
    expect(visible).not.toContain(inheritedProxy);
    expect(visible).not.toContain("ambient-user");
    expect(visible).not.toContain("ambient-secret");
    expect(visible).not.toContain("other-user");
    expect(visible).not.toContain("other-secret");
  });

  it("redacts proxy URLs and userinfo from partial engine failures", async () => {
    const configuredProxy = "http://configured.proxy:8001";
    const inheritedProxy = "http://ambient-user:ambient-secret@ambient.proxy:9000";
    const route = appliedSearchRoute({
      easyresearch: { network: { searchProxy: configuredProxy } },
    }, {
      HTTPS_PROXY: inheritedProxy,
    });
    const tool = createWebSearchTool(adapter(execution({
      partialFailures: [{
        engine: "bing",
        code: "engine_error",
        message: `failed through ${configuredProxy} and ${inheritedProxy}`,
        engineReliability: "high",
      }],
    })), { sanitizeError: (error) => route.sanitizeError(error) });

    const output = await tool.execute(
      "call",
      { query: "fixture", engines: ["duckduckgo", "bing"] },
      undefined,
      undefined,
      {} as never,
    );
    const visible = `${textContent(output)}\n${JSON.stringify(output.details)}`;

    expect(visible).toContain("engine_error");
    expect(visible).not.toContain(configuredProxy);
    expect(visible).not.toContain(inheritedProxy);
    expect(visible).not.toContain("ambient-user");
    expect(visible).not.toContain("ambient-secret");
  });

  it("sanitizes package console errors without changing concurrent daemon diagnostics", async () => {
    const inheritedProxy = "http://ambient-user:ambient-secret@ambient.proxy:9000";
    const arbitraryProxy = "https://other-user:other-secret@other.proxy/path";
    let markPackageLog!: () => void;
    let releasePackage!: () => void;
    const packageLogged = new Promise<void>((resolve) => {
      markPackageLog = resolve;
    });
    const packageGate = new Promise<void>((resolve) => {
      releasePackage = resolve;
    });
    const fakeService: OpenWebSearchService = {
      execute: vi.fn(async (input) => {
        console.error(
          "Open-WebSearch engine failed:",
          new Error(`connect through ${inheritedProxy}; fallback ${arbitraryProxy}`),
        );
        markPackageLog();
        await packageGate;
        return {
          query: input.query,
          engines: input.engines,
          totalResults: 0,
          results: [],
          partialFailures: [{
            engine: "duckduckgo",
            code: "engine_error",
            message: `connect through ${inheritedProxy}`,
          }],
        };
      }),
    };
    const route = appliedSearchRoute({}, { HTTPS_PROXY: inheritedProxy });
    const registerTool = vi.fn();
    const factory: ExtensionFactory = createWebSearchExtension({
      appliedSearchRoute: route,
      initializeRuntime: vi.fn(async () => ({
        config: FIXED_OPEN_WEBSEARCH_CONFIG,
        requestRouting: directRequestRouting,
        search: fakeService,
      })),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await factory({ registerTool } as never);
      const pending = registerTool.mock.calls[0]?.[0].execute(
        "call",
        { query: "fixture", engines: ["duckduckgo"] },
        undefined,
        undefined,
        {} as never,
      );
      await packageLogged;
      const concurrentDiagnostic = { status: 418 };
      console.error("Concurrent daemon diagnostic", concurrentDiagnostic);
      releasePackage();
      const output = await pending;

      const packageCall = consoleError.mock.calls.find(([message]) => (
        message === "Open-WebSearch engine failed:"
      ));
      const concurrentCall = consoleError.mock.calls.find(([message]) => (
        message === "Concurrent daemon diagnostic"
      ));
      const packageVisible = packageCall?.map((value) => (
        value instanceof Error ? `${String(value)}\n${value.stack ?? ""}` : String(value)
      )).join("\n") ?? "";
      const outputVisible = `${textContent(output)}\n${JSON.stringify(output.details)}`;

      expect(packageVisible).toContain("connect through");
      expect(packageVisible).not.toContain(inheritedProxy);
      expect(packageVisible).not.toContain("ambient-user");
      expect(packageVisible).not.toContain("ambient-secret");
      expect(packageVisible).not.toContain("other-user");
      expect(packageVisible).not.toContain("other-secret");
      expect(concurrentCall).toEqual(["Concurrent daemon diagnostic", concurrentDiagnostic]);
      expect(outputVisible).not.toContain(inheritedProxy);
      expect(outputVisible).not.toContain("ambient-secret");
    } finally {
      releasePackage();
      consoleError.mockRestore();
    }
  });
});
