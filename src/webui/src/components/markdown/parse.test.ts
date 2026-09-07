import { describe, expect, it } from "vitest";
import { parseMarkdownBlocks } from "./parse";

describe("parseMarkdownBlocks", () => {
  it("produces stable signed HAST for GFM and KaTeX without raw HTML", async () => {
    const source = "|a|b|\n|-|-|\n|1|2|\n\n$e^{i\\pi}+1=0$\n\n<script>alert(1)</script>";
    const first = await parseMarkdownBlocks(source);
    const second = await parseMarkdownBlocks(source);
    expect(second).toEqual(first);
    expect(first.every((block) => /^[a-f0-9]{64}$/.test(block.signature))).toBe(true);
    expect(JSON.stringify(first)).toContain("katex");
    expect(JSON.stringify(first)).not.toContain('"type":"raw"');
    expect(JSON.stringify(first)).not.toContain('"tagName":"script"');
  });

  it("keeps mermaid as a language-marked code node", async () => {
    const blocks = await parseMarkdownBlocks("```mermaid\ngraph TD; A-->B\n```");
    expect(JSON.stringify(blocks)).toContain("language-mermaid");
  });

  it("returns no blocks for empty input and strips source positions", async () => {
    expect(await parseMarkdownBlocks("")).toEqual([]);
    expect(JSON.stringify(await parseMarkdownBlocks("hello"))).not.toContain('"position"');
  });
});
