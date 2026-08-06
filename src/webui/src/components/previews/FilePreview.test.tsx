// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FilePreview } from "./FilePreview";
import { PdfPreview } from "./PdfPreview";
import { fakePdfLoader, type FakePdfRenderCall } from "./pdf-runtime";
import { resolveLocalPreviewPath } from "./preview-paths";
import { rawFileUrl } from "../../api";
import type { FileContentDto } from "../../../../web/contracts";

const scrollIntoViewTargets: HTMLElement[] = [];

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: function (this: Element) {
      scrollIntoViewTargets.push(this as HTMLElement);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function rect(overrides: Partial<DOMRect>): DOMRect {
  return {
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...overrides,
  } as DOMRect;
}

const markdownDto: FileContentDto = {
  path: "/p/paper.md",
  content: [
    "# Method",
    "",
    "![model](figures/model.png)",
    "",
    "The energy is $E = mc^2$.",
    "",
    "| Column A | Column B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "- [x] reviewed",
    "",
    "[open](notes/other.md)",
    "",
    "[external](https://example.com)",
  ].join("\n"),
  byteCount: 200,
  truncated: false,
  binary: false,
};

describe("resolveLocalPreviewPath", () => {
  it("resolves relative paths against the document directory", () => {
    expect(resolveLocalPreviewPath("/p/docs/paper.md", "../figures/a.png")).toBe("/p/figures/a.png");
    expect(resolveLocalPreviewPath("/p/paper.md", "figures/model.png")).toBe("/p/figures/model.png");
    expect(resolveLocalPreviewPath("/p/paper.md", "/p/abs/b.png")).toBe("/p/abs/b.png");
  });

  it("rejects external, fragment, and empty hrefs", () => {
    expect(resolveLocalPreviewPath("/p/docs/paper.md", "https://example.com/a.png")).toBeNull();
    expect(resolveLocalPreviewPath("/p/docs/paper.md", "//example.com/a.png")).toBeNull();
    expect(resolveLocalPreviewPath("/p/docs/paper.md", "mailto:a@b.c")).toBeNull();
    expect(resolveLocalPreviewPath("/p/docs/paper.md", "#anchor")).toBeNull();
    expect(resolveLocalPreviewPath("/p/docs/paper.md", "")).toBeNull();
  });

  it("strips query strings and fragments from local targets", () => {
    expect(resolveLocalPreviewPath("/p/docs/paper.md", "other.md#sec")).toBe("/p/docs/other.md");
    expect(resolveLocalPreviewPath("/p/docs/paper.md", "../figures/a.png?v=2")).toBe("/p/figures/a.png");
    expect(resolveLocalPreviewPath("/p/docs/paper.md", "other.md#sec?x")).toBe("/p/docs/other.md");
    expect(resolveLocalPreviewPath("/p/docs/paper.md", "/p/abs/b.png?raw=1")).toBe("/p/abs/b.png");
  });

  it("decodes percent-encoded characters such as spaces", () => {
    expect(resolveLocalPreviewPath("/p/docs/paper.md", "my%20file.md")).toBe("/p/docs/my file.md");
    expect(resolveLocalPreviewPath("/p/docs/paper.md", "../figures/a%20b.png")).toBe("/p/figures/a b.png");
  });
});

describe("FilePreview markdown dispatch", () => {
  it("renders markdown with GFM, math, tables, and relative resources", () => {
    render(<FilePreview path="/p/paper.md" textFile={markdownDto} onOpenFile={() => {}} />);
    expect(screen.getByRole("heading", { name: "Method" })).toBeVisible();
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByRole("img")).toHaveAttribute("src", rawFileUrl("/p/figures/model.png"));
    expect(screen.getByText("reviewed")).toBeVisible();
    expect(document.querySelector(".katex")).toBeTruthy();
  });

  it("opens internal links through onOpenFile", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    render(<FilePreview path="/p/paper.md" textFile={markdownDto} onOpenFile={onOpenFile} />);
    await user.click(screen.getByRole("link", { name: "open" }));
    expect(onOpenFile).toHaveBeenCalledWith("/p/notes/other.md");
  });

  it("opens external links in a new tab", () => {
    render(<FilePreview path="/p/paper.md" textFile={markdownDto} onOpenFile={() => {}} />);
    const link = screen.getByRole("link", { name: "external" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("keeps same-document anchors as same-tab links", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    const dto: FileContentDto = {
      path: "/p/paper.md",
      content: "[jump](#section)\n\n# Section",
      byteCount: 30,
      truncated: false,
      binary: false,
    };
    render(<FilePreview path="/p/paper.md" textFile={dto} onOpenFile={onOpenFile} />);
    const link = screen.getByRole("link", { name: "jump" });
    expect(link).toHaveAttribute("href", "#section");
    expect(link).not.toHaveAttribute("target");
    expect(link).not.toHaveAttribute("rel");
    await user.click(link);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("resolves internal links with fragments and query strings to clean paths", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    const dto: FileContentDto = {
      path: "/p/paper.md",
      content: "[other](notes/other.md#sec)",
      byteCount: 30,
      truncated: false,
      binary: false,
    };
    render(<FilePreview path="/p/paper.md" textFile={dto} onOpenFile={onOpenFile} />);
    await user.click(screen.getByRole("link", { name: "other" }));
    expect(onOpenFile).toHaveBeenCalledWith("/p/notes/other.md");
  });

  it("shows the truncation notice for truncated markdown", () => {
    render(
      <FilePreview path="/p/paper.md" textFile={{ ...markdownDto, truncated: true }} onOpenFile={() => {}} />,
    );
    expect(screen.getByText(/truncated to the first 1 MiB/i)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Method" })).toBeVisible();
  });

  it("falls back to plain text for non-markdown files", () => {
    render(
      <FilePreview
        path="/p/notes.txt"
        textFile={{ path: "/p/notes.txt", content: "hello", byteCount: 5, truncated: false, binary: false }}
        onOpenFile={() => {}}
      />,
    );
    expect(screen.getByText("hello")).toBeVisible();
  });

  it("shows the binary notice for non-UTF-8 files", () => {
    render(
      <FilePreview
        path="/p/notes.bin"
        textFile={{ path: "/p/notes.bin", content: "", byteCount: 4, truncated: false, binary: true }}
        onOpenFile={() => {}}
      />,
    );
    expect(screen.getByText(/binary file/i)).toBeVisible();
  });
});

describe("PdfPreview", () => {
  beforeEach(() => {
    scrollIntoViewTargets.length = 0;
  });

  it("loads pages, navigates, and links download", async () => {
    const user = userEvent.setup();
    render(<PdfPreview path="/p/paper.pdf" loader={fakePdfLoader({ pages: 3 })} />);
    expect(await screen.findByText("1 / 3")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByLabelText("Current page")).toHaveValue(2);
    expect(screen.getByRole("link", { name: "Download PDF" })).toHaveAttribute("href", rawFileUrl("/p/paper.pdf"));
  });

  it("keeps only page, zoom, and download controls", async () => {
    render(<PdfPreview path="/p/paper.pdf" loader={fakePdfLoader({ pages: 1 })} />);
    await screen.findByText("1 / 1");
    const toolbar = screen.getByRole("toolbar", { name: "PDF controls" });
    expect(within(toolbar).getByRole("button", { name: "Previous page" })).toBeVisible();
    expect(within(toolbar).getByRole("button", { name: "Next page" })).toBeVisible();
    expect(within(toolbar).getByRole("button", { name: "Zoom in" })).toBeVisible();
    expect(within(toolbar).getByRole("button", { name: "Zoom out" })).toBeVisible();
    expect(within(toolbar).getByRole("link", { name: "Download PDF" })).toBeVisible();
    expect(within(toolbar).queryByRole("searchbox")).toBeNull();
    expect(within(toolbar).queryByRole("button", { name: "Fit width" })).toBeNull();
    expect(within(toolbar).queryByRole("button", { name: "Rotate" })).toBeNull();
  });

  it("does not display the file name in the preview header", async () => {
    render(<PdfPreview path="/p/paper.pdf" loader={fakePdfLoader({ pages: 1 })} />);
    await screen.findByText("1 / 1");
    expect(screen.queryByText("/p/paper.pdf")).toBeNull();
  });

  it("zooms in and out", async () => {
    const user = userEvent.setup();
    render(<PdfPreview path="/p/paper.pdf" loader={fakePdfLoader({ pages: 1 })} />);
    await screen.findByText("1 / 1");
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("125%")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByText("100%")).toBeVisible();
  });

  it("keeps the canvas at the fixed zoom width in any container", async () => {
    const user = userEvent.setup();
    render(<PdfPreview path="/p/paper.pdf" loader={fakePdfLoader({ pages: 1 })} />);
    await screen.findByText("1 / 1");
    const canvas = screen.getByLabelText("Page 1");
    await waitFor(() => expect(canvas).toHaveStyle({ width: "100px" }));
    expect(canvas.className).not.toContain("max-w-full");
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(canvas).toHaveStyle({ width: "125px" }));
    expect(parseInt(canvas.style.width, 10)).toBeGreaterThan(100);
  });

  it("scrolls the viewport to the target canvas on page button navigation", async () => {
    const user = userEvent.setup();
    render(<PdfPreview path="/p/paper.pdf" loader={fakePdfLoader({ pages: 3 })} />);
    await screen.findByText("1 / 3");
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByLabelText("Current page")).toHaveValue(2);
    expect(scrollIntoViewTargets.at(-1)?.getAttribute("aria-label")).toBe("Page 2");
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(scrollIntoViewTargets.at(-1)?.getAttribute("aria-label")).toBe("Page 1");
  });

  it("scrolls to the page typed into the current page input", async () => {
    render(<PdfPreview path="/p/paper.pdf" loader={fakePdfLoader({ pages: 3 })} />);
    await screen.findByText("1 / 3");
    fireEvent.change(screen.getByLabelText("Current page"), { target: { value: "3" } });
    expect(screen.getByLabelText("Current page")).toHaveValue(3);
    expect(scrollIntoViewTargets.at(-1)?.getAttribute("aria-label")).toBe("Page 3");
  });

  it("synchronizes the current page when the viewport scrolls", async () => {
    render(<PdfPreview path="/p/paper.pdf" loader={fakePdfLoader({ pages: 3 })} />);
    await screen.findByText("1 / 3");
    const scroll = screen.getByTestId("pdf-scroll");
    const page1 = screen.getByLabelText("Page 1");
    const page2 = screen.getByLabelText("Page 2");
    const page3 = screen.getByLabelText("Page 3");
    scroll.getBoundingClientRect = vi.fn(() => rect({ top: 0, height: 600 }));
    page1.getBoundingClientRect = vi.fn(() => rect({ top: -500, height: 400 }));
    page2.getBoundingClientRect = vi.fn(() => rect({ top: 10, height: 400 }));
    page3.getBoundingClientRect = vi.fn(() => rect({ top: 500, height: 400 }));
    fireEvent.scroll(scroll);
    await waitFor(() => expect(screen.getByLabelText("Current page")).toHaveValue(2));
  });

  it("renders only a window around the current page and releases far page bitmaps", async () => {
    const renderLog: FakePdfRenderCall[] = [];
    render(<PdfPreview path="/p/paper.pdf" loader={fakePdfLoader({ pages: 8, renderLog })} />);
    await screen.findByText("1 / 8");
    await waitFor(() => expect(renderLog.length).toBeGreaterThanOrEqual(3));
    expect(renderLog.length).toBeLessThan(8);
    const page1 = screen.getByLabelText("Page 1") as HTMLCanvasElement;
    const page4 = screen.getByLabelText("Page 4") as HTMLCanvasElement;
    const page8 = screen.getByLabelText("Page 8") as HTMLCanvasElement;
    await waitFor(() => expect(page1.width).toBeGreaterThan(0));
    expect(page4.width).toBe(0);
    expect(page8.width).toBe(0);
    fireEvent.change(screen.getByLabelText("Current page"), { target: { value: "8" } });
    await waitFor(() => expect(page8.width).toBeGreaterThan(0));
    expect(page1.width).toBe(0);
    expect(renderLog.length).toBeGreaterThanOrEqual(6);
    expect(renderLog.length).toBeLessThan(16);
  });

  it("passes the devicePixelRatio transform to the page render", async () => {
    const renderLog: FakePdfRenderCall[] = [];
    vi.stubGlobal("devicePixelRatio", 2);
    render(<PdfPreview path="/p/paper.pdf" loader={fakePdfLoader({ pages: 1, renderLog })} />);
    await screen.findByText("1 / 1");
    expect(renderLog.length).toBeGreaterThan(0);
    const call = renderLog.find((entry) => entry.transform?.every((value, index) => value === (index === 0 || index === 3 ? 2 : 0)));
    expect(call).toBeTruthy();
  });

  it("wraps the toolbar on compact widths without page-level overflow", async () => {
    render(<PdfPreview path="/p/paper.pdf" loader={fakePdfLoader({ pages: 1 })} />);
    await screen.findByText("1 / 1");
    const toolbar = screen.getByRole("toolbar", { name: "PDF controls" });
    expect(toolbar.className).toContain("flex-wrap");
    expect(toolbar.className).toContain("min-w-0");
    expect(toolbar.closest(".overflow-hidden")).toBeTruthy();
    const scroll = screen.getByTestId("pdf-scroll");
    expect(scroll.className).toContain("overflow-auto");
  });

  it("shows the malformed PDF error and recovers via Retry", async () => {
    const user = userEvent.setup();
    const failing = { load: vi.fn().mockRejectedValueOnce(new Error("corrupt pdf")) };
    render(<PdfPreview path="/p/bad.pdf" loader={failing} />);
    expect(await screen.findByText(/corrupt pdf/)).toBeVisible();
    failing.load.mockResolvedValueOnce(await fakePdfLoader({ pages: 1 }).load({ url: "" }));
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("1 / 1")).toBeVisible();
  });
});
