import { render, screen } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseMarkdownBlocks } from "./parse";
import { clearCompletedMarkdownCacheForTests, prepareMarkdownBlocks } from "./render";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg data-testid='mermaid-svg' />" }),
  },
}));

beforeEach(() => clearCompletedMarkdownCacheForTests());

describe("prepareMarkdownBlocks", () => {
  it.each([
    "Use <placeholder> here.",
    "<div>Important result: accuracy 92%</div>",
    "<script>alert(1)</script>",
    '<img src="x" onerror="alert(1)">',
  ])("preserves raw HTML as inert text like the synchronous renderer: %s", async (source) => {
    const blocks = prepareMarkdownBlocks(await parseMarkdownBlocks(source));
    const { container } = render(
      <>
        <section data-testid="synchronous">
          <ReactMarkdown>{source}</ReactMarkdown>
        </section>
        <section data-testid="worker">{blocks.map((block) => block.node)}</section>
      </>,
    );
    expect(screen.getByTestId("worker").textContent).toBe(source);
    expect(screen.getByTestId("worker").textContent).toBe(screen.getByTestId("synchronous").textContent);
    expect(container.querySelector("script, img, placeholder")).toBeNull();
  });

  it("renders safe GFM, KaTeX, inert links, and Mermaid", async () => {
    const source =
      "|a|b|\n|-|-|\n|1|2|\n\n$e^{i\\pi}+1=0$\n\n[link](https://example.com)\n\n```mermaid\ngraph TD; A-->B\n```";
    const blocks = prepareMarkdownBlocks(await parseMarkdownBlocks(source));
    const { container } = render(<div>{blocks.map((block) => block.node)}</div>);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(container.querySelector(".katex")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(await screen.findByTestId("mermaid-svg")).toBeTruthy();
  });

  it("reuses unchanged signed block nodes", async () => {
    const first = prepareMarkdownBlocks(await parseMarkdownBlocks("first\n\nsecond"));
    const second = prepareMarkdownBlocks(await parseMarkdownBlocks("first\n\nchanged"), first);
    expect(second[0]!.node).toBe(first[0]!.node);
    expect(second.at(-1)!.node).not.toBe(first.at(-1)!.node);
  });
});
