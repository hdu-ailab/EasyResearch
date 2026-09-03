import { afterEach, describe, expect, it, vi } from "vitest";
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
  abortError,
  collapsedUrl,
  compactLine,
  convertHtmlToMarkdown,
  extractTextFromHtml,
  isImageAttachment,
  textContent,
  webFetchTool,
} from "./index";

const platformFetch = globalThis.fetch;
let installedRouter: InstalledNetworkRouter | undefined;

afterEach(() => {
  installedRouter?.restore();
  installedRouter = undefined;
  globalThis.fetch = platformFetch;
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
