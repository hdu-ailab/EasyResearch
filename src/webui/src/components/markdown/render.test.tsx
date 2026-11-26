import { fireEvent, render, screen, within } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownBlock } from "../MarkdownBlock";
import { FileReferenceBatch } from "./file-reference-batch";
import { parseMarkdownBlocks } from "./parse";
import {
  clearCompletedMarkdownCacheForTests,
  getCompletedMarkdown,
  prepareMarkdownBlocks,
  setCompletedMarkdown,
} from "./render";
import { FileReferenceResolutionContext, TranscriptFileContext } from "./TranscriptFileLink";

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
    const batch = new FileReferenceBatch(async (paths) => ({
      references: paths.map((reference) => ({ reference, paths: [`/p/${reference}`], truncated: false })),
    }));
    const { container } = render(
      <FileReferenceResolutionContext value={batch}>
        <TranscriptFileContext value={open}>
          <section data-testid="worker-kinds">{blocks.map((block) => block.node)}</section>
          <section data-testid="fallback-kinds">
            <MarkdownBlock text={source} />
          </section>
        </TranscriptFileContext>
      </FileReferenceResolutionContext>,
    );
    for (const id of ["worker-kinds", "fallback-kinds"]) {
      const section = screen.getByTestId(id);
      expect(section.querySelector('code[data-inline-kind="command"]')?.textContent).toBe(
        "python experiments/train.py",
      );
      expect(section.querySelector('code[data-inline-kind="skill"]')?.textContent).toBe("/skill:paper-search");
      expect(await within(section).findAllByRole("button")).toHaveLength(1);
      fireEvent.click(within(section).getByRole("button", { name: "results/my report.md" }));
    }
    expect(open.mock.calls).toEqual([["results/my report.md"], ["results/my report.md"]]);
    expect(container.querySelectorAll("code[data-inline-kind] svg")).toHaveLength(4);
    batch.dispose();
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

  it("renders safe GFM, KaTeX, external HTTP links, and Mermaid", async () => {
    const source =
      "|a|b|\n|-|-|\n|1|2|\n\n$e^{i\\pi}+1=0$\n\n[link](https://example.com)\n\n```mermaid\ngraph TD; A-->B\n```";
    const blocks = prepareMarkdownBlocks(await parseMarkdownBlocks(source));
    const { container } = render(<div>{blocks.map((block) => block.node)}</div>);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(container.querySelector(".katex")).toBeTruthy();
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://example.com");
    expect(container.querySelector("script")).toBeNull();
    expect(await screen.findByTestId("mermaid-svg")).toBeTruthy();
  });

  it("reuses unchanged signed block nodes", async () => {
    const first = prepareMarkdownBlocks(await parseMarkdownBlocks("first\n\nsecond"));
    const second = prepareMarkdownBlocks(await parseMarkdownBlocks("first\n\nchanged"), first);
    expect(second[0]!.node).toBe(first[0]!.node);
    expect(second.at(-1)!.node).not.toBe(first.at(-1)!.node);
  });

  it("reconciles a changed paragraph without replacing its DOM or identical sibling blocks", async () => {
    const first = prepareMarkdownBlocks(await parseMarkdownBlocks("Repeated\n\nRepeated\n\n**Tail**"));
    const view = render(<section>{first.map((block) => block.node)}</section>);
    const paragraphs = [...view.container.querySelectorAll("p")];
    const strong = view.container.querySelector("strong");
    const next = prepareMarkdownBlocks(await parseMarkdownBlocks("Repeated\n\nRepeated\n\n**Tail** grows"), first);
    view.rerender(<section>{next.map((block) => block.node)}</section>);
    [...view.container.querySelectorAll("p")].forEach((paragraph, index) => {
      expect(paragraph).toBe(paragraphs[index]);
    });
    expect(view.container.querySelector("strong")).toBe(strong);
    expect(paragraphs[2]?.textContent).toBe("Tail grows");
    expect(next[0]).toBe(first[0]);
    expect(next[2]).toBe(first[2]);
    expect(next.at(-1)?.signature).not.toBe(first.at(-1)?.signature);
  });

  it("bounds completed results at 200 entries and verifies exact raw source on reuse", () => {
    for (let index = 0; index < 200; index++) setCompletedMarkdown("bounded", String(index), `source ${index}`, []);
    expect(getCompletedMarkdown("bounded", "0", "source 0")?.source).toBe("source 0");
    setCompletedMarkdown("bounded", "new", "new", []);
    expect(getCompletedMarkdown("bounded", "1", "source 1")).toBeUndefined();
    expect(getCompletedMarkdown("bounded", "0", "source 0")?.source).toBe("source 0");
    expect(getCompletedMarkdown("bounded", "0", "another source")).toBeUndefined();
    expect(getCompletedMarkdown("foreign", "0", "source 0")).toBeUndefined();
  });
});
