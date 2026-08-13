import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COLLAPSED_LINE_MAX_CHARS,
  compactLine,
  decodeResultUrl,
  formatResults,
  looksBlocked,
  parseResults,
  serialize,
  textContent,
  truncateOutput,
  webSearchTool,
} from "./index";

describe("search tool definition (ADR-031 as amended by ADR-038)", () => {
  it("is named web-search", () => {
    expect(webSearchTool.name).toBe("web-search");
  });

  it("declares query required and num/site/time optional", () => {
    const schema = webSearchTool.parameters as {
      type: string;
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["query"]);
    const properties = schema.properties ?? {};
    expect(properties).toHaveProperty("query");
    expect(properties).toHaveProperty("num");
    expect(properties).toHaveProperty("site");
    expect(properties).toHaveProperty("time");
  });
});

describe("parseResults", () => {
  it("extracts titles, decoded URLs and abstracts from DuckDuckGo HTML", () => {
    const html = `
      <html><body>
        <div class="links_main">
          <h2 class="result__title"><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x">Example &amp; Title</a></h2>
          <a class="result__snippet">Some  <b>abstract</b>   text</a>
        </div>
        <div class="links_main">
          <h2 class="result__title"><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb&rut=y">Second result</a></h2>
          <a class="result__snippet">Second abstract</a>
        </div>
        <div class="links_main">
          <h2 class="result__title"><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fc&rut=z">Third result</a></h2>
          <a class="result__snippet">Third abstract</a>
        </div>
      </body></html>`;

    const results = parseResults(html, 2);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Example & Title",
      url: "https://example.com/a",
      abstract: "Some abstract text",
    });
    expect(results[1]!.url).toBe("https://example.com/b");
  });

  it("returns an empty array for HTML without results", () => {
    expect(parseResults("<html><body>nothing here</body></html>", 5)).toEqual([]);
  });
});

describe("decodeResultUrl", () => {
  it("unwraps the uddg parameter", () => {
    expect(decodeResultUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=1")).toBe(
      "https://example.com",
    );
  });

  it("keeps non-uddg URLs as-is", () => {
    expect(decodeResultUrl("https://example.com/direct")).toBe("https://example.com/direct");
  });
});

describe("looksBlocked", () => {
  it("flags HTTP 202", () => {
    expect(looksBlocked(202, "anything")).toBe(true);
  });

  it("flags challenge/captcha markers", () => {
    expect(looksBlocked(200, "Please verify you are human")).toBe(true);
    expect(looksBlocked(200, "unusual traffic detected")).toBe(true);
  });

  it("passes normal responses", () => {
    expect(looksBlocked(200, "<div class='links_main'>ok</div>")).toBe(false);
    expect(looksBlocked(503, "down")).toBe(false);
  });
});

describe("compactLine", () => {
  it("keeps short lines unchanged", () => {
    expect(compactLine("  hello   world ")).toBe("hello world");
  });

  it("truncates long lines with an ellipsis", () => {
    const long = "x".repeat(COLLAPSED_LINE_MAX_CHARS + 50);
    const compact = compactLine(long);
    expect(compact).toHaveLength(COLLAPSED_LINE_MAX_CHARS);
    expect(compact.endsWith("…")).toBe(true);
  });
});

describe("textContent", () => {
  it("joins only text items", () => {
    const result = {
      content: [
        { type: "text", text: "a" },
        { type: "tool_use", text: "ignored" },
        { type: "text", text: "b" },
        { type: "text" },
      ],
    };
    expect(textContent(result)).toBe("a\nb");
  });
});

describe("serialize", () => {
  it("runs concurrent operations one at a time", async () => {
    const order: string[] = [];
    const first = serialize(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("first");
      return 1;
    });
    const second = serialize(async () => {
      order.push("second");
      return 2;
    });

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(order).toEqual(["first", "second"]);
  });
});

describe("formatResults", () => {
  it("formats results with numbering and fields", () => {
    const output = formatResults([
      { title: "T1", url: "https://u1", abstract: "A1" },
      { title: "T2", url: "https://u2", abstract: "A2" },
    ]);
    expect(output).toContain("Result 1\nTitle: T1\nURL: https://u1\nAbstract: A1");
    expect(output).toContain("Result 2");
  });
});

describe("truncateOutput", () => {
  it("keeps short output untouched", async () => {
    const result = await truncateOutput("short output");
    expect(result.text).toBe("short output");
    expect(result.fullOutputPath).toBeUndefined();
  });

  it("writes a temp file and appends a notice when truncated", async () => {
    const big = Array.from({ length: 10_000 }, (_, i) => `line ${i} ${"x".repeat(80)}`).join("\n");
    const result = await truncateOutput(big);
    expect(result.fullOutputPath).toBeDefined();
    expect(result.text).toContain("[Output truncated:");
    expect(result.text).toContain("Full output saved to:");
    const written = readFileSync(result.fullOutputPath!, "utf8");
    expect(written).toBe(big);
  });
});