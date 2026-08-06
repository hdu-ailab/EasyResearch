// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FilePreview } from "./FilePreview";
import { PdfPreview } from "./PdfPreview";
import { fakePdfLoader } from "./pdf-runtime";
import { resolveLocalPreviewPath } from "./preview-paths";
import { rawFileUrl } from "../../api";
import type { FileContentDto } from "../../../../web/contracts";

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

function fakeResizeObserverInstances() {
  return (globalThis as unknown as { FakeResizeObserver: { instances: { __fire(width: number): void }[] } })
    .FakeResizeObserver.instances;
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
    fakeResizeObserverInstances().length = 0;
  });

  it("loads pages and navigates, searches, and links download", async () => {
    const user = userEvent.setup();
    render(<PdfPreview path="/p/paper.pdf" loader={fakePdfLoader({ pages: 3, text: ["alpha", "beta alpha", "gamma"] })} />);
    expect(await screen.findByText("1 / 3")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByLabelText("Current page")).toHaveValue(2);
    await user.type(screen.getByRole("searchbox", { name: "Find in PDF" }), "alpha");
    expect(await screen.findByText("1 / 2 matches")).toBeVisible();
    expect(screen.getByRole("link", { name: "Download PDF" })).toHaveAttribute("href", rawFileUrl("/p/paper.pdf"));
  });

  it("zooms in and out", async () => {
    const user = userEvent.setup();
    render(<PdfPreview path="/p/paper.pdf" loader={fakePdfLoader({ pages: 1, text: ["a"] })} />);
    await screen.findByText("1 / 1");
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("125%")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByText("100%")).toBeVisible();
  });

  it("fits pages to the container width", async () => {
    const user = userEvent.setup();
    render(<PdfPreview path="/p/paper.pdf" loader={fakePdfLoader({ pages: 1, text: ["a"] })} />);
    await screen.findByText("1 / 1");
    await user.click(screen.getByRole("button", { name: "Fit width" }));
    const instances = fakeResizeObserverInstances();
    await waitFor(() => expect(instances.length).toBeGreaterThan(0));
    instances[instances.length - 1]!.__fire(800);
    await waitFor(() => expect(screen.getByLabelText("Page 1")).toHaveStyle({ width: "800px" }));
  });

  it("rotates the page", async () => {
    const user = userEvent.setup();
    render(<PdfPreview path="/p/paper.pdf" loader={fakePdfLoader({ pages: 1, text: ["a"] })} />);
    await screen.findByText("1 / 1");
    await waitFor(() => expect(screen.getByLabelText("Page 1")).toHaveStyle({ width: "100px" }));
    await user.click(screen.getByRole("button", { name: "Rotate" }));
    await waitFor(() => expect(screen.getByLabelText("Page 1")).toHaveStyle({ width: "140px" }));
  });

  it("navigates between search matches", async () => {
    const user = userEvent.setup();
    render(<PdfPreview path="/p/paper.pdf" loader={fakePdfLoader({ pages: 3, text: ["alpha", "beta alpha", "gamma"] })} />);
    await screen.findByText("1 / 3");
    await user.type(screen.getByRole("searchbox", { name: "Find in PDF" }), "alpha");
    await screen.findByText("1 / 2 matches");
    await user.click(screen.getByRole("button", { name: "Next match" }));
    expect(await screen.findByText("2 / 2 matches")).toBeVisible();
    expect(screen.getByLabelText("Current page")).toHaveValue(2);
    await user.click(screen.getByRole("button", { name: "Previous match" }));
    expect(await screen.findByText("1 / 2 matches")).toBeVisible();
    expect(screen.getByLabelText("Current page")).toHaveValue(1);
  });

  it("shows the malformed PDF error and recovers via Retry", async () => {
    const user = userEvent.setup();
    const failing = { load: vi.fn().mockRejectedValueOnce(new Error("corrupt pdf")) };
    render(<PdfPreview path="/p/bad.pdf" loader={failing} />);
    expect(await screen.findByText(/corrupt pdf/)).toBeVisible();
    failing.load.mockResolvedValueOnce(await fakePdfLoader({ pages: 1, text: ["ok"] }).load({ url: "" }));
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("1 / 1")).toBeVisible();
  });
});
