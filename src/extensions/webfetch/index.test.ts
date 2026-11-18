import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeylessWebClient, type KeylessWebClient } from "../keyless-web/client";
import {
  captureInheritedProxyEnvironment,
  parseNetworkProxySettings,
  resolveNetworkPolicy,
} from "../../runtime/network-policy";
import {
  installNetworkRouter,
  type InstalledNetworkRouter,
} from "../../runtime/network-routing";
import webFetchExtension, {
  createWebFetchExtension,
  createWebFetchTool,
} from "./index";
import {
  COLLAPSED_LINE_MAX_CHARS,
  MAX_RESPONSE_SIZE,
  abortError,
  collapsedUrl,
  compactLine,
  convertHtmlToMarkdown,
  extractTextFromHtml,
  isImageAttachment,
  readLimited,
  textContent,
  webFetchTool,
} from "./index";

const platformFetch = globalThis.fetch;
let installedRouter: InstalledNetworkRouter | undefined;

afterEach(() => {
  installedRouter?.restore();
  installedRouter = undefined;
  globalThis.fetch = platformFetch;
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function proxyFrom(init: Parameters<typeof fetch>[1]): string | undefined {
  return (init as (RequestInit & { proxy?: string }) | undefined)?.proxy;
}

describe("webfetch tool definition (ADR-068)", () => {
  it("is named webfetch", () => {
    expect(webFetchTool.name).toBe("webfetch");
  });

  it("declares url required and format/timeout optional", () => {
    const schema = webFetchTool.parameters as {
      type: string;
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["url"]);
    const properties = schema.properties ?? {};
    expect(properties).toHaveProperty("url");
    expect(properties).toHaveProperty("format");
    expect(properties).toHaveProperty("timeout");
  });

  it("keeps the exported default extension and dependency-free factory on the direct tool", async () => {
    const defaultRegister = vi.fn();
    const factoryRegister = vi.fn();

    await webFetchExtension({ registerTool: defaultRegister } as never);
    await createWebFetchExtension()({ registerTool: factoryRegister } as never);

    expect(defaultRegister).toHaveBeenCalledWith(webFetchTool);
    expect(factoryRegister).toHaveBeenCalledWith(webFetchTool);
  });

  it("keeps the complete async request in Search scope while concurrent LLM fetch stays isolated", async () => {
    const firstSearchEntered = deferred<void>();
    const releaseFirstSearch = deferred<void>();
    const calls: Array<{ url: string; proxy?: string }> = [];
    let searchRequests = 0;
    globalThis.fetch = (async (input, init) => {
      const url = inputUrl(input);
      calls.push({ url, proxy: proxyFrom(init) });
      if (url === "https://search-target.example/") {
        searchRequests += 1;
        if (searchRequests === 1) {
          firstSearchEntered.resolve();
          await releaseFirstSearch.promise;
          return new Response("challenge", {
            status: 403,
            headers: { "cf-mitigated": "challenge" },
          });
        }
        return new Response("search body", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response("llm body", { status: 200 });
    }) as typeof fetch;
    installedRouter = installNetworkRouter(resolveNetworkPolicy(
      parseNetworkProxySettings({
        httpProxy: "http://all.proxy:8000",
        easyresearch: {
          network: {
            llmProxy: "http://llm.proxy:8001",
            searchProxy: "http://search.proxy:8002",
          },
        },
      }),
      captureInheritedProxyEnvironment({}),
    ));
    const router = installedRouter;
    const tool = createWebFetchTool({
      runRequest: (operation) => router.withScope("search", operation),
    });

    const search = tool.execute("search-call", {
      url: "https://search-target.example/",
      format: "text",
    }, undefined, undefined, {} as never);
    await firstSearchEntered.promise;
    await router.withScope("llm", async () => {
      await Promise.resolve();
      await globalThis.fetch("https://llm-target.example/");
    });
    releaseFirstSearch.resolve();
    const result = await search;

    expect(result.content).toEqual([{ type: "text", text: "search body" }]);
    expect(calls).toEqual([
      { url: "https://search-target.example/", proxy: "http://search.proxy:8002" },
      { url: "https://llm-target.example/", proxy: "http://llm.proxy:8001" },
      { url: "https://search-target.example/", proxy: "http://search.proxy:8002" },
    ]);
  });
});

describe("extractTextFromHtml", () => {
  it("strips scripts, styles, and markup, keeping text", () => {
    const html = `<html><body><script>var x = 1;</script><h1>Title</h1><style>p { color: red }</style><p>Hello <b>world</b></p></body></html>`;
    expect(extractTextFromHtml(html)).toBe("TitleHello world");
  });

  it("drops nested skipped content entirely", () => {
    const html = `<div><script>if (a < b) { document.write("<p>nested</p>"); }</script>kept</div>`;
    expect(extractTextFromHtml(html)).toBe("kept");
  });
});

describe("convertHtmlToMarkdown", () => {
  it("converts headings, lists, and links", () => {
    const md = convertHtmlToMarkdown("<h1>Title</h1><ul><li><a href=\"https://x.example\">item</a></li></ul>");
    expect(md).toContain("# Title");
    expect(md).toContain("[item](https://x.example)");
    expect(md).toContain("- ");
  });

  it("removes script and style blocks", () => {
    const md = convertHtmlToMarkdown("<script>bad()</script><style>p{}</style><p>ok</p>");
    expect(md).not.toContain("bad()");
    expect(md).toContain("ok");
  });
});

describe("isImageAttachment", () => {
  it("accepts raster image MIME types", () => {
    expect(isImageAttachment("image/png")).toBe(true);
    expect(isImageAttachment("image/jpeg")).toBe(true);
    expect(isImageAttachment("image/gif")).toBe(true);
  });

  it("rejects SVG and non-image MIME types", () => {
    expect(isImageAttachment("image/svg+xml")).toBe(false);
    expect(isImageAttachment("text/html")).toBe(false);
    expect(isImageAttachment("")).toBe(false);
  });
});

describe("compactLine", () => {
  it("keeps short lines and truncates long ones with an ellipsis", () => {
    expect(compactLine("short")).toBe("short");
    const long = "x".repeat(COLLAPSED_LINE_MAX_CHARS + 10);
    const out = compactLine(long);
    expect(out.length).toBe(COLLAPSED_LINE_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("collapsedUrl", () => {
  it("shows the final URL when it matches the request", () => {
    expect(collapsedUrl("https://a.example/page")).toBe("https://a.example/page");
  });

  it("renders a redirect arrow when the final URL differs", () => {
    expect(collapsedUrl("https://a.example/start", "https://b.example/end")).toContain("→");
    expect(collapsedUrl("https://a.example/start", "https://b.example/end")).toContain("https://b.example/end");
  });
});

describe("textContent", () => {
  it("joins only text items", () => {
    expect(
      textContent({
        content: [
          { type: "text", text: "first" },
          { type: "image" },
          { type: "text", text: "second" },
        ],
      }),
    ).toBe("first\nsecond");
  });
});

describe("abortError", () => {
  it("creates an Error named AbortError", () => {
    const error = abortError("boom");
    expect(error.message).toBe("boom");
    expect(error.name).toBe("AbortError");
  });
});

describe("bounded response ownership", () => {
  it("cancels a declared oversized body before returning the size error", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const response = new Response(body, { headers: { "content-length": String(MAX_RESPONSE_SIZE + 1) } });

    await expect(readLimited(response)).rejects.toThrow("Response too large");

    expect(cancelled).toBe(true);
    expect((await body.getReader().read()).done).toBe(true);
  });

  it.each([true, false])("preserves the size error when cancellation fails (declared: %s)", async (declared) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(MAX_RESPONSE_SIZE + 1)); },
      cancel() { cancelled = true; throw new Error("source cleanup failed"); },
    }, { highWaterMark: 0 });
    const response = new Response(body, { headers: declared ? { "content-length": String(MAX_RESPONSE_SIZE + 1) } : {} });

    await expect(readLimited(response)).rejects.toThrow("Response too large");

    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
});

describe("explicit remote extraction", () => {
  const url = "https://example.com/article?q=a%26b";
  const markdown = "# Evidence\n\n`<sample>` and a < b & c > d\n\n[Source](https://example.com)";
  function firecrawl(data: Record<string, unknown> = {}) {
    return { success: true, data: { markdown, metadata: { sourceURL: url, statusCode: 200 }, ...data } };
  }
  function client(data: unknown, headers = new Headers()) {
    const request = vi.fn<KeylessWebClient["request"]>().mockResolvedValue({ data, status: 200, headers });
    return { request };
  }
  function execute(provider: "firecrawl" | "tavily", keylessClient: KeylessWebClient, format: "markdown" | "text" | "html" = "markdown") {
    return createWebFetchTool({ keylessClient }).execute("remote", { url, provider, format }, undefined, undefined, {} as never);
  }

  it.each([undefined, "direct"] as const)("keeps %s fetching direct, including raw text and images", async (provider) => {
    const remote = client(firecrawl());
    const direct = vi.fn().mockResolvedValueOnce(new Response("<literal>&raw", { headers: { "content-type": "text/plain" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
    const tool = createWebFetchTool({ request: direct, keylessClient: remote });
    const text = await tool.execute("direct", { url, provider }, undefined, undefined, {} as never);
    expect(text.content).toEqual([{ type: "text", text: "<literal>&raw" }]);
    const image = await tool.execute("image", { url, provider }, undefined, undefined, {} as never);
    expect(image.content[1]).toEqual({ type: "image", data: "AQID", mimeType: "image/png" });
    expect(remote.request).not.toHaveBeenCalled();
  });

  it("preserves direct raw HTML, HTML conversion and HTTP errors", async () => {
    const html = "<h1>Title</h1><p>Body</p>";
    const request = vi.fn().mockImplementation(async () => new Response(html, { headers: { "content-type": "text/html" } }));
    const tool = createWebFetchTool({ request });
    const raw = await tool.execute("html", { url, format: "html" }, undefined, undefined, {} as never);
    expect(textContent(raw)).toBe(html);
    const converted = await tool.execute("markdown", { url }, undefined, undefined, {} as never);
    expect(textContent(converted)).toBe("# Title\n\nBody");
    request.mockResolvedValue(new Response("untrusted body", { status: 404, statusText: "Not Found" }));
    await expect(tool.execute("error", { url }, undefined, undefined, {} as never)).rejects.toThrow("HTTP 404 Not Found");
  });

  it("rejects an unknown provider rather than silently selecting direct", async () => {
    const remote = client(null);
    const direct = vi.fn();
    await expect(createWebFetchTool({ request: direct, keylessClient: remote }).execute("unknown", {
      url, provider: "unknown" as never,
    }, undefined, undefined, {} as never)).rejects.toThrow("Unsupported webfetch provider");
    expect(direct).not.toHaveBeenCalled();
    expect(remote.request).not.toHaveBeenCalled();
  });

  it("sends exactly one URL and preserves reported redirect, cache and source status", async () => {
    const finalUrl = "https://example.com/published";
    const metadata = { sourceURL: url, url: finalUrl, statusCode: 200, cacheState: "hit", cachedAt: "2026-11-16", title: "<script>fake()</script>" };
    const remote = client(firecrawl({ metadata }), new Headers({ "x-cache": "HIT", age: "42" }));
    const direct = vi.fn();
    const tool = createWebFetchTool({ keylessClient: remote, request: direct });
    const result = await tool.execute("extract", { url, provider: "firecrawl", timeout: 45 }, undefined, undefined, {} as never);
    expect(remote.request).toHaveBeenCalledExactlyOnceWith({
      provider: "firecrawl", url: "https://api.firecrawl.dev/v2/scrape", method: "POST",
      body: { url, formats: ["markdown"], onlyMainContent: true, timeout: 45000 },
      signal: expect.any(AbortSignal), timeoutMs: 45000, maxBytes: MAX_RESPONSE_SIZE,
    });
    expect(direct).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      provider: "firecrawl", requestedUrl: url, sourceUrl: url, finalUrl, url: finalUrl,
      providerStatus: 200, directOriginVerified: false, format: "markdown",
      provenance: { metadata }, providerCacheHeaders: { "x-cache": "HIT", age: "42" },
    });
    const text = textContent(result);
    expect(text).toContain("not direct-origin verified");
    expect(text).toContain(markdown);
    expect(text).not.toContain("<script>");
    expect(text).toContain("\\u003cscript\\u003e");
    expect(text).toContain(finalUrl);
  });

  it("does not invent a returned source, final URL or source status", async () => {
    const result = await execute("firecrawl", client(firecrawl({ metadata: {} })));
    expect(result.details).toMatchObject({ requestedUrl: url, directOriginVerified: false, provenance: { metadata: {} } });
    expect(result.details).not.toHaveProperty("sourceUrl", url);
    expect(result.details).not.toHaveProperty("finalUrl", url);
  });

  it.each(["firecrawl", "tavily"] as const)("accepts %s stripping a fragment while retaining both supplied identities", async (provider) => {
    const requestedUrl = `${url}#section`;
    const remote = client(provider === "firecrawl" ? firecrawl() : { results: [{ url, raw_content: markdown }], failed_results: [] });
    const result = await createWebFetchTool({ keylessClient: remote }).execute("fragment", {
      url: requestedUrl, provider,
    }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ requestedUrl, sourceUrl: url });
    expect(remote.request).toHaveBeenCalledWith(expect.objectContaining({
      body: provider === "firecrawl" ? expect.objectContaining({ url: requestedUrl }) : expect.objectContaining({ urls: [requestedUrl] }),
    }));
  });

  it.each([
    "https://example.com/different?q=a%26b#section",
    "https://example.com/article?q=different#section",
  ])("continues to reject changed path/query identities: %s", async (returnedUrl) => {
    await expect(execute("firecrawl", client(firecrawl({ metadata: { sourceURL: returnedUrl } })))).rejects.toThrow("mismatched");
    await expect(execute("tavily", client({ results: [{ url: returnedUrl, raw_content: markdown }] }))).rejects.toThrow("mismatched");
  });

  it("bounds known provenance and API headers while discarding unknown and nested provider objects", async () => {
    const huge = "x".repeat(200_000);
    const metadata = {
      sourceURL: url, url: "https://example.com/final", statusCode: 200,
      title: huge, description: huge, keywords: Array(1000).fill(huge),
      cached: null, cacheState: "unknown", cachedAt: "2026-11-17T00:00:00Z",
      unknownPayload: { giant: huge }, cache: { giant: huge }, warning: { giant: huge },
    };
    const remote = client({
      ...firecrawl({ metadata, cached: false, cache: { giant: huge }, warning: { giant: huge } }),
      request_id: huge, status: { giant: huge }, unknownPayload: huge,
    }, new Headers({ "x-cache": huge, "cache-control": huge, age: "42" }));
    const result = await execute("firecrawl", remote);
    const details = result.details as { provenance: { metadata: Record<string, unknown> }; providerCacheHeaders: Record<string, string> };
    const serialized = JSON.stringify(details);
    expect(Buffer.byteLength(serialized)).toBeLessThan(16 * 1024);
    expect(textContent(result).length).toBeLessThan(20 * 1024);
    expect(serialized).not.toContain("unknownPayload");
    expect(serialized).not.toContain("giant");
    expect(serialized).not.toContain(huge);
    expect(details.provenance.metadata).toMatchObject({
      sourceURL: url, url: metadata.url, statusCode: 200, cached: null, cacheState: "unknown", cachedAt: metadata.cachedAt,
    });
    expect(details.provenance.metadata.title).toEqual(expect.stringMatching(/…$/));
    expect(details.provenance.metadata.keywords).toHaveLength(4);
    expect(result.details).toMatchObject({
      provenance: { cached: false }, providerCacheHeaders: { age: "42" },
      providerCacheHeadersScope: "extraction-api-response", directOriginVerified: false,
    });
    expect(details.providerCacheHeaders["x-cache"]?.length).toBeLessThan(1024);
  });

  it("rejects oversized URL identities rather than truncating their provenance", async () => {
    const oversizedUrl = `https://example.com/${"x".repeat(8192)}`;
    await expect(execute("firecrawl", client(firecrawl({ metadata: { sourceURL: url, url: oversizedUrl } })))).rejects.toThrow("oversized");
    const remote = client(firecrawl());
    await expect(createWebFetchTool({ keylessClient: remote }).execute("oversized", {
      url: oversizedUrl, provider: "firecrawl",
    }, undefined, undefined, {} as never)).rejects.toThrow("oversized");
    expect(remote.request).not.toHaveBeenCalled();
  });

  it("rejects synchronous extraction overrunning the deadline even before its timer can fire", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const remote = client(null);
      remote.request.mockImplementation(async () => {
        now = 900; // The response body completed just within the one-second deadline.
        return { status: 200, headers: new Headers(), data: {
          success: true,
          data: {
            metadata: { sourceURL: url },
            get markdown() {
              // Synchronous content processing occupies the remaining time;
              // no event-loop timer or AbortSignal has fired.
              now = 1100;
              return markdown;
            },
          },
        } };
      });
      await expect(createWebFetchTool({ keylessClient: remote }).execute("cpu", {
        url, provider: "firecrawl", format: "text", timeout: 1,
      }, undefined, undefined, {} as never)).rejects.toThrow("timed out");
      expect(remote.request.mock.calls[0]?.[0].signal?.aborted).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("converts Firecrawl Markdown to text without parsing angle brackets as HTML", async () => {
    const result = await execute("firecrawl", client(firecrawl()), "text");
    expect(result.details).toMatchObject({ format: "text", contentType: "text/plain" });
    expect(textContent(result)).toContain("Evidence\n\n<sample> and a < b & c > d\n\nSource");
    expect(textContent(result)).not.toContain("# Evidence");
  });

  it.each(["markdown", "text"] as const)("uses Tavily's requested %s format and unmodified raw_content", async (format) => {
    const raw = "<literal> & [brackets]\nline";
    const remote = client({ results: [{ url, raw_content: raw, cached: false }], failed_results: [], request_id: "request-1" });
    const result = await execute("tavily", remote, format);
    expect(remote.request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      url: "https://api.tavily.com/extract", body: { urls: [url], extract_depth: "basic", format },
      timeoutMs: 30000, maxBytes: MAX_RESPONSE_SIZE,
    }));
    expect(textContent(result)).toContain(raw);
    expect(result.details).toMatchObject({ provider: "tavily", sourceUrl: url, format, provenance: { cached: false, request_id: "request-1" } });
  });

  it.each(["firecrawl", "tavily"] as const)("honors a %s text-only response's actual format", async (provider) => {
    const data = provider === "firecrawl"
      ? firecrawl({ markdown: undefined, text: "<literal>text" })
      : { results: [{ url, text: "<literal>text" }], failed_results: [] };
    const result = await execute(provider, client(data));
    expect(result.details).toMatchObject({ requestedFormat: "markdown", format: "text", contentType: "text/plain" });
    expect(textContent(result)).toContain("<literal>text");
  });

  it.each(["firecrawl", "tavily"] as const)("rejects %s HTML and credential-bearing URLs before network work", async (provider) => {
    const remote = client(firecrawl());
    await expect(execute(provider, remote, "html")).rejects.toThrow("only markdown or text");
    await expect(createWebFetchTool({ keylessClient: remote }).execute("private", {
      url: "https://user:password@example.com/", provider,
    }, undefined, undefined, {} as never)).rejects.toThrow("without embedded credentials");
    expect(remote.request).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { success: false, error: "secret upstream instruction" },
    { success: true, error: "secret upstream instruction", data: { markdown } },
    { success: true, data: { markdown, metadata: { sourceURL: "https://other.example/" } } },
    { success: true, data: { markdown, metadata: { url: "https://other.example/" } } },
    { success: true, data: { markdown, metadata: { sourceURL: url, statusCode: 404, error: "secret upstream instruction" } } },
    { success: true, data: { markdown, metadata: { sourceURL: "javascript:bad()" } } },
    { success: true, data: { markdown, metadata: { statusCode: "404" } } },
    { success: true, data: { markdown, metadata: "invalid" } },
    { success: true, data: { markdown: "   " } },
    { success: true, data: { html: "<p>not requested</p>" } },
  ])("rejects malformed, failed or mismatched Firecrawl data without echoing bodies: %j", async (data) => {
    const remote = client(data);
    await expect(execute("firecrawl", remote)).rejects.toThrow();
    await expect(execute("firecrawl", remote)).rejects.not.toThrow("secret upstream instruction");
  });

  it.each([
    { results: [], failed_results: [{ url, error: "secret upstream instruction" }] },
    { results: [{ url, raw_content: markdown }], failed_results: [{ url, error: "secret upstream instruction" }] },
    { results: [{ url: "https://other.example/", raw_content: markdown }], failed_results: [] },
    { results: [{ raw_content: markdown }] },
    { results: [{ url, raw_content: markdown }, { url, raw_content: markdown }] },
    { results: [{ url, raw_content: markdown, status: "failed" }] },
    { results: [{ url, raw_content: markdown, metadata: { sourceURL: "https://other.example/" } }] },
    { results: [{ url, raw_content: markdown }], detail: { error: "secret upstream instruction" } },
    { results: [{ url, raw_content: "" }] },
  ])("rejects failed, incorrect-source or malformed Tavily results: %j", async (data) => {
    await expect(execute("tavily", client(data))).rejects.toThrow();
    await expect(execute("tavily", client(data))).rejects.not.toThrow("secret upstream instruction");
  });

  it("propagates owned client failures without retry or direct fallback", async () => {
    const remote = client(null);
    const failure = Object.assign(new Error("Provider rate limited; retry after 60 seconds"), { code: "rate_limited", provider: "tavily", retryAfterSeconds: 60 });
    remote.request.mockRejectedValue(failure);
    const direct = vi.fn();
    await expect(createWebFetchTool({ keylessClient: remote, request: direct }).execute("limit", {
      url, provider: "tavily",
    }, undefined, undefined, {} as never)).rejects.toBe(failure);
    expect(remote.request).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
  });

  it("keeps the standalone client's body consumption inside its one injected request scope", async () => {
    let scoped = false;
    let calls = 0;
    globalThis.fetch = (async () => {
      expect(scoped).toBe(true);
      return new Response(new ReadableStream({ pull(controller) {
        expect(scoped).toBe(true);
        controller.enqueue(new TextEncoder().encode(JSON.stringify(firecrawl())));
        controller.close();
      } }, { highWaterMark: 0 }));
    }) as unknown as typeof fetch;
    const tool = createWebFetchTool({ runRequest: (<T>(operation: () => Promise<T>) => {
      calls++;
      scoped = true;
      return operation().finally(() => { scoped = false; });
    }) as never });
    await tool.execute("scoped", { url, provider: "firecrawl" }, undefined, undefined, {} as never);
    expect(calls).toBe(1);
    expect(scoped).toBe(false);
  });

  it.each(["stop", "timeout"] as const)("covers %s while the shared client consumes an unfinished response body", async (reason) => {
    vi.useFakeTimers();
    const entered = deferred<void>();
    let cancelled = false;
    const keylessClient = createKeylessWebClient({ fetch: (async () => new Response(new ReadableStream({
      pull() { entered.resolve(); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }))) as unknown as typeof fetch });
    const controller = new AbortController();
    const promise = createWebFetchTool({ keylessClient }).execute("body", { url, provider: "firecrawl", timeout: 1 }, controller.signal, undefined, {} as never);
    const failure = expect(promise).rejects.toThrow(reason === "stop" ? "cancelled" : /timed out|timeout/i);
    await entered.promise;
    if (reason === "stop") controller.abort();
    else await vi.advanceTimersByTimeAsync(1001);
    await failure;
    expect(cancelled).toBe(true);
  });

  it("enforces the existing five-MiB limit through the shared client", async () => {
    let cancelled = false;
    const keylessClient = createKeylessWebClient({ fetch: (async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(MAX_RESPONSE_SIZE + 1)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }))) as unknown as typeof fetch });
    await expect(execute("firecrawl", keylessClient)).rejects.toThrow(/large|limit|size/i);
    expect(cancelled).toBe(true);
  });
});
