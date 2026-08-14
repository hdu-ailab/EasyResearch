import { describe, expect, it } from "vitest";
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
