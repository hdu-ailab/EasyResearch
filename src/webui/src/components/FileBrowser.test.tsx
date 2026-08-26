import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileWatcherEvent } from "../../../web/contracts";
import { listEntries, readFileContent } from "../api";
import { FileBrowser } from "./FileBrowser";

const docxLoader = vi.hoisted(() => ({ load: vi.fn(), render: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, listEntries: vi.fn(), readFileContent: vi.fn() };
});

vi.mock("./previews/pdf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./previews/pdf-runtime")>();
  return { ...actual, createPdfLoader: () => actual.fakePdfLoader({ pages: 1 }) };
});

vi.mock("./previews/docx-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./previews/docx-runtime")>();
  return { ...actual, createDocxLoader: () => docxLoader };
});

describe("FileBrowser", () => {
  beforeEach(() => {
    vi.mocked(listEntries).mockReset();
    vi.mocked(readFileContent).mockReset();
    docxLoader.load.mockReset().mockResolvedValue(new ArrayBuffer(1));
    docxLoader.render.mockReset().mockImplementation(async (_bytes, body: HTMLElement) => {
      const paragraph = body.ownerDocument.createElement("p");
      paragraph.textContent = "DOCX manuscript";
      body.append(paragraph);
    });
    vi.mocked(listEntries).mockResolvedValue([
      { kind: "file", name: "paper.pdf", path: "/p/paper.pdf" },
      { kind: "file", name: "draft.DOCX", path: "/p/draft.DOCX" },
      { kind: "file", name: "notes.md", path: "/p/notes.md" },
    ]);
  });

  it("dispatches a PDF file to the PDF preview without fetching bounded text", async () => {
    const user = userEvent.setup();
    render(<FileBrowser root="/p" />);
    await user.click(await screen.findByText("paper.pdf"));
    expect(await screen.findByRole("group", { name: "PDF controls" })).toBeVisible();
    expect(readFileContent).not.toHaveBeenCalled();
  });

  it("dispatches a DOCX file without fetching bounded UTF-8 text", async () => {
    const user = userEvent.setup();
    vi.mocked(readFileContent).mockResolvedValue({
      path: "/p/draft.DOCX",
      content: "",
      byteCount: 4,
      truncated: false,
      binary: true,
    });
    render(<FileBrowser root="/p" />);
    await user.click(await screen.findByText("draft.DOCX"));
    expect(await screen.findByRole("group", { name: "DOCX controls" })).toBeVisible();
    expect(readFileContent).not.toHaveBeenCalled();
  });

  it("reloads an active DOCX preview after a file change event", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<FileBrowser root="/p" fileEvent={null} />);
    await user.click(await screen.findByText("draft.DOCX"));
    await waitFor(() => expect(docxLoader.render).toHaveBeenCalledOnce());

    const event: FileWatcherEvent = {
      type: "file.watcher.updated",
      properties: { file: "/p/draft.DOCX", event: "change" },
    };
    rerender(<FileBrowser root="/p" fileEvent={event} />);

    await waitFor(() => expect(docxLoader.render).toHaveBeenCalledTimes(2));
    expect(docxLoader.load).toHaveBeenCalledTimes(2);
    expect(readFileContent).not.toHaveBeenCalled();
  });

  it("does not replay a DOCX change event when another tab closes", async () => {
    const user = userEvent.setup();
    vi.mocked(readFileContent).mockResolvedValue({
      path: "/p/notes.md",
      content: "# Notes",
      byteCount: 7,
      truncated: false,
      binary: false,
    });
    const { rerender } = render(<FileBrowser root="/p" fileEvent={null} />);
    await user.click(await screen.findByText("notes.md"));
    await screen.findByRole("heading", { name: "Notes" });
    await user.click(screen.getByText("draft.DOCX"));
    await waitFor(() => expect(docxLoader.render).toHaveBeenCalledOnce());

    const event: FileWatcherEvent = {
      type: "file.watcher.updated",
      properties: { file: "/p/draft.DOCX", event: "change" },
    };
    rerender(<FileBrowser root="/p" fileEvent={event} />);
    await waitFor(() => expect(docxLoader.render).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "Close notes.md" }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(docxLoader.render).toHaveBeenCalledTimes(2);
    expect(docxLoader.load).toHaveBeenCalledTimes(2);
  });

  it("fetches bounded text only for non-PDF files", async () => {
    const user = userEvent.setup();
    vi.mocked(readFileContent).mockResolvedValue({
      path: "/p/notes.md",
      content: "# Notes\n\nplan",
      byteCount: 15,
      truncated: false,
      binary: false,
    } as never);
    render(<FileBrowser root="/p" />);
    await user.click(await screen.findByText("notes.md"));
    expect(await screen.findByRole("heading", { name: "Notes" })).toBeVisible();
    expect(readFileContent).toHaveBeenCalledWith("/p/notes.md");
  });

  it("keeps an alias-backed tab active when the file API returns a canonical path", async () => {
    const user = userEvent.setup();
    vi.mocked(listEntries).mockResolvedValue([{ kind: "file", name: "notes.md", path: "/alias/notes.md" }]);
    vi.mocked(readFileContent).mockResolvedValue({
      path: "/real/notes.md",
      content: "# Alias notes",
      byteCount: 13,
      truncated: false,
      binary: false,
    });
    render(<FileBrowser root="/alias" />);

    await user.click(await screen.findByText("notes.md"));

    expect(await screen.findByRole("heading", { name: "Alias notes" })).toBeVisible();
  });

  it("uses the basename for a Windows file opened from a Markdown link", async () => {
    const user = userEvent.setup();
    const root = String.raw`D:\papers`;
    const paper = String.raw`D:\papers\paper.md`;
    const notes = String.raw`D:\papers\notes.md`;
    vi.mocked(listEntries).mockResolvedValue([{ kind: "file", name: "paper.md", path: paper }]);
    vi.mocked(readFileContent).mockImplementation(async (path) => ({
      path,
      content: path === paper ? "[notes](notes.md)" : "# Notes",
      byteCount: 18,
      truncated: false,
      binary: false,
    }));
    render(<FileBrowser root={root} />);
    await user.click(await screen.findByText("paper.md"));
    await user.click(await screen.findByRole("link", { name: "notes" }));

    expect(await screen.findByRole("tab", { name: "notes.md" })).toBeVisible();
    expect(readFileContent).toHaveBeenCalledWith(notes);
  });

  it("reloads an opened text preview after a file change event", async () => {
    const user = userEvent.setup();
    vi.mocked(readFileContent)
      .mockResolvedValueOnce({
        path: "/p/notes.md",
        content: "# Notes\n\nold content",
        byteCount: 20,
        truncated: false,
        binary: false,
      })
      .mockResolvedValueOnce({
        path: "/p/notes.md",
        content: "# Notes\n\nnew content",
        byteCount: 20,
        truncated: false,
        binary: false,
      });
    const { rerender } = render(<FileBrowser root="/p" fileEvent={null} />);
    await user.click(await screen.findByText("notes.md"));
    expect(await screen.findByText("old content")).toBeVisible();

    const event: FileWatcherEvent = {
      type: "file.watcher.updated",
      properties: { file: "/p/notes.md", event: "change" },
    };
    rerender(<FileBrowser root="/p" fileEvent={event} />);

    expect(await screen.findByText("new content")).toBeVisible();
    expect(readFileContent).toHaveBeenCalledTimes(2);
  });

  it("reloads opened previews when rename activity invalidates their directory", async () => {
    const user = userEvent.setup();
    vi.mocked(readFileContent)
      .mockResolvedValueOnce({
        path: "/p/notes.md",
        content: "# Notes\n\nold content",
        byteCount: 20,
        truncated: false,
        binary: false,
      })
      .mockResolvedValueOnce({
        path: "/p/notes.md",
        content: "# Notes\n\nreplaced content",
        byteCount: 25,
        truncated: false,
        binary: false,
      });
    const { rerender } = render(<FileBrowser root="/p" fileEvent={null} />);
    await user.click(await screen.findByText("notes.md"));
    expect(await screen.findByText("old content")).toBeVisible();

    rerender(
      <FileBrowser
        root="/p"
        fileEvent={{ type: "file.watcher.updated", properties: { file: "/p", event: "change" } }}
      />,
    );

    expect(await screen.findByText("replaced content")).toBeVisible();
    expect(readFileContent).toHaveBeenCalledTimes(2);
  });

  it("keeps the tree toggle outside the open-file tablist", async () => {
    render(<FileBrowser root="/p" />);
    const button = await screen.findByRole("button", { name: "Toggle file tree" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    const tablist = screen.getByRole("tablist", { name: "Open files" });
    expect(tablist).not.toContainElement(button);
  });

  it("colors the toggle when the tree is open and clears it when collapsed", async () => {
    const user = userEvent.setup();
    render(<FileBrowser root="/p" />);
    const button = await screen.findByRole("button", { name: "Toggle file tree" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveClass("bg-v2-background-bg-layer-2");

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).not.toHaveClass("bg-v2-background-bg-layer-2");
  });

  it("collapses the tree on click while keeping the preview visible, and expands again", async () => {
    const user = userEvent.setup();
    render(<FileBrowser root="/p" />);
    const button = await screen.findByRole("button", { name: "Toggle file tree" });
    const tree = await screen.findByRole("tree", { name: "Project files tree" });
    const container = tree.closest("[class*='w-[240px]']");
    expect(container).not.toBeNull();
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("paper.pdf")).toBeVisible();

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(container).toHaveClass("hidden");
    expect(screen.getByText("Open a file")).toBeVisible();

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(container).not.toHaveClass("hidden");
    expect(screen.getByText("paper.pdf")).toBeVisible();
  });
});
