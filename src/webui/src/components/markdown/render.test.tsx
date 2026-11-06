import { fireEvent, render, screen, within } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownBlock } from "../MarkdownBlock";
import { parseMarkdownBlocks } from "./parse";
import { clearCompletedMarkdownCacheForTests, prepareMarkdownBlocks } from "./render";
import { TranscriptFileContext } from "./TranscriptFileLink";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg data-testid='mermaid-svg' />" }),
  },
}));

beforeEach(() => clearCompletedMarkdownCacheForTests());

describe("prepareMarkdownBlocks", () => {
  it("keeps command, Skill and file affordances equivalent in Worker and fallback output", async () => {
    const source = "`python experiments/train.py` · `/skill:paper-search` · `results/my report.md`";
    const blocks = prepareMarkdownBlocks(await parseMarkdownBlocks(source));
    const open = vi.fn();
    const { container } = render(
      <TranscriptFileContext value={open}>
        <section data-testid="worker-kinds">{blocks.map((block) => block.node)}</section>
        <section data-testid="fallback-kinds">
          <MarkdownBlock text={source} />
        </section>
      </TranscriptFileContext>,
    );
    for (const id of ["worker-kinds", "fallback-kinds"]) {
      const section = screen.getByTestId(id);
      expect(section.querySelector('code[data-inline-kind="command"]')?.textContent).toBe(
        "python experiments/train.py",
      );
      expect(section.querySelector('code[data-inline-kind="skill"]')?.textContent).toBe("/skill:paper-search");
      expect(within(section).getAllByRole("button")).toHaveLength(1);
      fireEvent.click(within(section).getByRole("button", { name: "results/my report.md" }));
    }
    expect(open.mock.calls).toEqual([["results/my report.md"], ["results/my report.md"]]);
    expect(container.querySelectorAll("code[data-inline-kind] svg")).toHaveLength(4);
  });

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
