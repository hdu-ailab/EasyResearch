import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg data-testid='mermaid-svg' />" }),
  },
}));

describe("MarkdownPreview", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "#/");
  });

  it("renders mermaid fences", async () => {
    render(<MarkdownPreview path="/p/paper.md" content={"```mermaid\ngraph TD; A-->B\n```"} onOpenFile={() => {}} />);
    expect(await screen.findByTestId("mermaid-svg")).toBeTruthy();
  });

  it("renders math via KaTeX", () => {
    render(<MarkdownPreview path="/p/paper.md" content={"The energy is $E = mc^2$."} onOpenFile={() => {}} />);
    expect(document.querySelector(".katex")).toBeTruthy();
  });

  it("scrolls fragment links inside their own preview without changing the Work hash", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "#/work/root?cwd=%2Fp");
    const onOpenFile = vi.fn();
    const view = render(
      <MarkdownPreview path="/p/paper.md" content={"[Methods](#methods)\n\n## Methods"} onOpenFile={onOpenFile} />,
    );
    const scroller = view.container.firstElementChild as HTMLElement;
    const heading = screen.getByRole("heading", { name: "Methods" });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ top: 50 } as DOMRect);
    vi.spyOn(heading, "getBoundingClientRect").mockReturnValue({ top: 350 } as DOMRect);
    scroller.scrollTop = 25;
    await user.click(screen.getByRole("link", { name: "Methods" }));
    expect(window.location.hash).toBe("#/work/root?cwd=%2Fp");
    expect(scroller.scrollTop).toBe(325);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("gives duplicate formatted headings unique document-local targets across previews and rerenders", () => {
    const content =
      "[first](#methods) [second](#methods-1) [third](#methods-1-1)\n\n## **Methods**\n\n## Methods\n\n## Methods-1";
    const view = render(
      <>
        <MarkdownPreview path="/p/a.md" content={content} onOpenFile={vi.fn()} />
        <MarkdownPreview path="/p/b.md" content={content} onOpenFile={vi.fn()} />
      </>,
    );
    const headings = screen.getAllByRole("heading");
    expect(headings.every((heading) => heading.id !== "")).toBe(true);
    expect(new Set(headings.map((heading) => heading.id)).size).toBe(headings.length);
    for (const preview of Array.from(view.container.children)) {
      const localHeadings = within(preview as HTMLElement).getAllByRole("heading");
      const links = within(preview as HTMLElement).getAllByRole("link");
      links.forEach((link, i) => {
        expect(decodeURIComponent(link.getAttribute("href")!.slice(1))).toBe(localHeadings[i]?.id);
      });
    }
    const ids = headings.map((heading) => heading.id);
    view.rerender(
      <>
        <MarkdownPreview path="/p/a.md" content={content} onOpenFile={vi.fn()} />
        <MarkdownPreview path="/p/b.md" content={content} onOpenFile={vi.fn()} />
      </>,
    );
    expect(screen.getAllByRole("heading").map((heading) => heading.id)).toEqual(ids);
  });

  it("keeps Unicode, self-document, empty, missing, and malformed fragments off the application router", () => {
    window.history.replaceState(null, "", "#/work/root?cwd=%2Fp");
    const onOpenFile = vi.fn();
    const view = render(
      <MarkdownPreview
        path="/p/paper.md"
        content={
          "[unicode](#%E6%96%B9%E6%B3%95) [self](paper.md#%E6%96%B9%E6%B3%95) [top](#) [missing](#absent) [malformed](#%ZZ)\n\n## \u65b9\u6cd5"
        }
        onOpenFile={onOpenFile}
      />,
    );
    const scroller = view.container.firstElementChild as HTMLElement;
    const heading = screen.getByRole("heading");
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
    vi.spyOn(heading, "getBoundingClientRect").mockReturnValue({ top: 200 } as DOMRect);
    for (const name of ["unicode", "self"]) {
      scroller.scrollTop = 0;
      expect(fireEvent.click(screen.getByRole("link", { name }))).toBe(false);
      expect(scroller.scrollTop).toBe(200);
    }
    fireEvent.click(screen.getByRole("link", { name: "top" }));
    expect(scroller.scrollTop).toBe(0);
    for (const name of ["missing", "malformed"])
      expect(fireEvent.click(screen.getByRole("link", { name }))).toBe(false);
    expect(window.location.hash).toBe("#/work/root?cwd=%2Fp");
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("keeps footnote ids and links local while preserving local files and safe external links", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    const view = render(
      <MarkdownPreview
        path="/p/paper.md"
        content={
          "A note[^one]. [Local](notes.md#methods) [External](https://example.com) [unsafe](javascript:alert%281%29)\n\n[^one]: Evidence"
        }
        onOpenFile={onOpenFile}
      />,
    );
    for (const link of view.container.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
      const id = decodeURIComponent(link.getAttribute("href")!.slice(1));
      expect(Array.from(view.container.querySelectorAll("[id]")).some((node) => node.id === id)).toBe(true);
    }
    await user.click(screen.getByRole("link", { name: "Local" }));
    expect(onOpenFile).toHaveBeenCalledWith("/p/notes.md");
    expect(screen.getByRole("link", { name: "External" })).toHaveAttribute("rel", "noreferrer noopener");
    expect(screen.getByText("unsafe").getAttribute("href")).not.toMatch(/^javascript:/);
  });

  it("does not let heading slugs capture footnote targets or their accessible label", () => {
    const view = render(
      <MarkdownPreview
        path="/p/paper.md"
        content={"## User-content-fn-one\n\n## Footnote-label\n\nNote[^one].\n\n[^one]: Evidence"}
        onOpenFile={vi.fn()}
      />,
    );
    const link = screen.getByRole("link", { name: "1" });
    const id = decodeURIComponent(link.getAttribute("href")!.slice(1));
    const target = Array.from(view.container.querySelectorAll("[id]")).find((node) => node.id === id);
    expect(target?.tagName).toBe("LI");
    expect(link).toHaveAccessibleDescription("Footnotes");
    const ids = Array.from(view.container.querySelectorAll("[id]")).map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(["plain", "\u4e2d\u6587", "some%label"])(
    "navigates both directions for footnote %s within its own preview and preserves the route",
    async (label) => {
      const user = userEvent.setup();
      window.history.replaceState(null, "", "#/work/root?cwd=%2Fp");
      const onOpenFile = vi.fn();
      const content = `Text[^${label}].\n\n[^${label}]: Evidence`;
      const view = render(
        <>
          <MarkdownPreview path="/p/other.md" content={content} onOpenFile={onOpenFile} />
          <MarkdownPreview path="/p/paper.md" content={content} onOpenFile={onOpenFile} />
        </>,
      );
      const [other, scroller] = Array.from(view.container.children) as HTMLElement[];
      const preview = within(scroller!);
      const reference = preview.getByRole("link", { name: "1" });
      const footnote = preview.getByRole("listitem");
      const backreference = preview.getByRole("link", { name: "Back to reference 1" });
      expect(reference.getAttribute("href")?.slice(1)).toBe(footnote.id);
      expect(backreference.getAttribute("href")?.slice(1)).toBe(reference.id);
      vi.spyOn(scroller!, "getBoundingClientRect").mockReturnValue({ top: 50 } as DOMRect);
      vi.spyOn(footnote, "getBoundingClientRect").mockReturnValue({ top: 300 } as DOMRect);
      vi.spyOn(reference, "getBoundingClientRect").mockReturnValue({ top: -200 } as DOMRect);
      other!.scrollTop = 40;

      await user.click(reference);
      expect.soft(scroller!.scrollTop).toBe(250);
      scroller!.scrollTop = 250;
      await user.click(backreference);
      expect.soft(scroller!.scrollTop).toBe(0);
      expect(other!.scrollTop).toBe(40);
      expect(window.location.hash).toBe("#/work/root?cwd=%2Fp");
      expect(onOpenFile).not.toHaveBeenCalled();
    },
  );

  it("prefers the exact pipeline footnote identity over an earlier decoded target in both directions", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "#/work/root?cwd=%2Fp");
    const view = render(
      <MarkdownPreview
        path="/p/paper.md"
        content={"First[^1]. Second[^%31].\n\n[^1]: Decoded target\n[^%31]: Exact target"}
        onOpenFile={vi.fn()}
      />,
    );
    const scroller = view.container.firstElementChild as HTMLElement;
    const [decoded, exact] = screen.getAllByRole("listitem");
    const reference = screen.getByRole("link", { name: "2" });
    expect(decodeURIComponent(exact!.id)).toBe(decoded!.id);
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
    vi.spyOn(decoded!, "getBoundingClientRect").mockReturnValue({ top: 50 } as DOMRect);
    vi.spyOn(exact!, "getBoundingClientRect").mockReturnValue({ top: 300 } as DOMRect);
    vi.spyOn(screen.getByRole("link", { name: "1" }), "getBoundingClientRect").mockReturnValue({ top: -50 } as DOMRect);
    vi.spyOn(reference, "getBoundingClientRect").mockReturnValue({ top: -300 } as DOMRect);

    await user.click(reference);
    expect.soft(scroller.scrollTop).toBe(300);
    scroller.scrollTop = 300;
    await user.click(screen.getByRole("link", { name: "Back to reference 2" }));
    expect.soft(scroller.scrollTop).toBe(0);
    expect(window.location.hash).toBe("#/work/root?cwd=%2Fp");
  });
});
