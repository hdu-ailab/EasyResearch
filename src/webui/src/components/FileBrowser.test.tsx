import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
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
    const { rerender } = render(<FileBrowser root="/p" />);
    await user.click(await screen.findByText("draft.DOCX"));
    await waitFor(() => expect(docxLoader.render).toHaveBeenCalledOnce());

    const event: FileWatcherEvent = {
      type: "file.watcher.updated",
      properties: { file: "/p/draft.DOCX", event: "change" },
    };
    rerender(<FileBrowser root="/p" fileEvents={[{ sequence: 1, event }]} />);

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
    const { rerender } = render(<FileBrowser root="/p" />);
    await user.click(await screen.findByText("notes.md"));
    await screen.findByRole("heading", { name: "Notes" });
    await user.click(screen.getByText("draft.DOCX"));
    await waitFor(() => expect(docxLoader.render).toHaveBeenCalledOnce());

    const event: FileWatcherEvent = {
      type: "file.watcher.updated",
      properties: { file: "/p/draft.DOCX", event: "change" },
    };
    rerender(<FileBrowser root="/p" fileEvents={[{ sequence: 1, event }]} />);
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
    const { rerender } = render(<FileBrowser root="/p" />);
    await user.click(await screen.findByText("notes.md"));
    expect(await screen.findByText("old content")).toBeVisible();

    const event: FileWatcherEvent = {
      type: "file.watcher.updated",
      properties: { file: "/p/notes.md", event: "change" },
    };
    rerender(<FileBrowser root="/p" fileEvents={[{ sequence: 1, event }]} />);

    expect(await screen.findByText("new content")).toBeVisible();
    expect(readFileContent).toHaveBeenCalledTimes(2);
  });

  it("consumes each queued event once across preview and listing consumers, including appended bursts", async () => {
    const user = userEvent.setup();
    let revision = 0;
    vi.mocked(listEntries).mockResolvedValue(
      ["a", "b"].map((name) => ({ kind: "file", name: `${name}.txt`, path: `/p/${name}.txt` })),
    );
    vi.mocked(readFileContent).mockImplementation(async (path) => ({
      path,
      content: `${path} version ${revision}`,
      byteCount: 20,
      truncated: false,
      binary: false,
    }));
    const consumed = vi.fn();
    const view = render(<FileBrowser root="/p" onFileEventsConsumed={consumed} />);
    await user.click(await screen.findByText("a.txt"));
    await screen.findByText("/p/a.txt version 0");
    await user.click(screen.getByText("b.txt"));
    await screen.findByText("/p/b.txt version 0");
    vi.mocked(readFileContent).mockClear();
    vi.mocked(listEntries).mockClear();
    const events = ["/p/a.txt", "/p/b.txt", "/p"].map((file, index) => ({
      sequence: index + 1,
      event: { type: "file.watcher.updated" as const, properties: { file, event: "change" as const } },
    }));
    revision = 1;
    view.rerender(<FileBrowser root="/p" fileEvents={events} onFileEventsConsumed={consumed} />);
    await screen.findByText("/p/b.txt version 1");
    await user.click(screen.getByRole("tab", { name: "a.txt" }));
    await screen.findByText("/p/a.txt version 1");
    expect(consumed.mock.calls).toEqual([[3]]);
    expect(listEntries).toHaveBeenCalledOnce();
    expect(readFileContent).toHaveBeenCalledTimes(2);

    revision = 2;
    view.rerender(
      <FileBrowser
        root="/p"
        fileEvents={[...events, { sequence: 4, event: events[0]!.event }]}
        onFileEventsConsumed={consumed}
      />,
    );
    await screen.findByText("/p/a.txt version 2");
    await user.click(screen.getByRole("tab", { name: "b.txt" }));
    expect(screen.getByText("/p/b.txt version 1")).toBeVisible();
    expect(consumed.mock.calls).toEqual([[3], [4]]);
    expect(readFileContent).toHaveBeenCalledTimes(3);
    expect(listEntries).toHaveBeenCalledOnce();
  });

  it("defers both file-event consumers until parent hydration enables loading", async () => {
    const events = [
      {
        sequence: 1,
        event: { type: "file.watcher.updated" as const, properties: { file: "/p", event: "change" as const } },
      },
    ];
    const consumed = vi.fn();
    const view = render(
      <FileBrowser root="/p" loadEnabled={false} fileEvents={events} onFileEventsConsumed={consumed} />,
    );
    expect(listEntries).not.toHaveBeenCalled();
    expect(readFileContent).not.toHaveBeenCalled();
    expect(consumed).not.toHaveBeenCalled();
    view.rerender(<FileBrowser root="/p" loadEnabled fileEvents={events} onFileEventsConsumed={consumed} />);
    await screen.findByText("notes.md");
    expect(consumed.mock.calls).toEqual([[1]]);
  });

  it("does not let a preview response completing at invalidation acknowledgement restore stale bytes", async () => {
    const user = userEvent.setup();
    const old = Promise.withResolvers<Awaited<ReturnType<typeof readFileContent>>>();
    vi.mocked(readFileContent).mockReturnValueOnce(old.promise).mockResolvedValue({
      path: "/p/notes.md",
      content: "Fresh bytes",
      byteCount: 11,
      truncated: false,
      binary: false,
    });
    const view = render(<FileBrowser root="/p" />);
    await user.click(await screen.findByText("notes.md"));
    await act(async () => {
      view.rerender(
        <FileBrowser
          root="/p"
          fileEvents={[
            {
              sequence: 1,
              event: { type: "file.watcher.updated", properties: { file: "/p/notes.md", event: "change" } },
            },
          ]}
          onFileEventsConsumed={() =>
            old.resolve({
              path: "/p/notes.md",
              content: "Obsolete bytes",
              byteCount: 14,
              truncated: false,
              binary: false,
            })
          }
        />,
      );
    });
    expect(await screen.findByText("Fresh bytes")).toBeVisible();
    expect(screen.queryByText("Obsolete bytes")).not.toBeInTheDocument();
    expect(readFileContent).toHaveBeenCalledTimes(2);
  });

  it("releases closed text content and fetches fresh bytes on reopen after a watcher change", async () => {
    const user = userEvent.setup();
    vi.mocked(readFileContent).mockImplementation(async (path) => ({
      path,
      content: "# Old bytes",
      byteCount: 11,
      truncated: false,
      binary: false,
    }));
    const view = render(<FileBrowser root="/p" />);
    await user.click(await screen.findByText("notes.md"));
    await screen.findByRole("heading", { name: "Old bytes" });
    await user.click(screen.getByRole("button", { name: "Close notes.md" }));
    vi.mocked(readFileContent).mockResolvedValue({
      path: "/p/notes.md",
      content: "# New bytes",
      byteCount: 11,
      truncated: false,
      binary: false,
    });
    view.rerender(
      <FileBrowser
        root="/p"
        fileEvents={[
          {
            sequence: 1,
            event: { type: "file.watcher.updated", properties: { file: "/p/notes.md", event: "change" } },
          },
        ]}
      />,
    );
    await user.click(screen.getByText("notes.md"));
    expect(await screen.findByRole("heading", { name: "New bytes" })).toBeVisible();
    expect(readFileContent).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"] as const)("ignores a closed tab's late %s after reopening it", async (outcome) => {
    const user = userEvent.setup();
    const oldRead = Promise.withResolvers<Awaited<ReturnType<typeof readFileContent>>>();
    vi.mocked(readFileContent).mockReturnValueOnce(oldRead.promise).mockResolvedValue({
      path: "/p/notes.md",
      content: "# Reopened",
      byteCount: 10,
      truncated: false,
      binary: false,
    });
    render(<FileBrowser root="/p" />);
    await user.click(await screen.findByText("notes.md"));
    await user.click(screen.getByRole("button", { name: "Close notes.md" }));
    await user.click(screen.getByText("notes.md"));
    await screen.findByRole("heading", { name: "Reopened" });
    await act(async () => {
      if (outcome === "failure") oldRead.reject(new Error("Obsolete read"));
      else
        oldRead.resolve({ path: "/p/notes.md", content: "# Obsolete", byteCount: 10, truncated: false, binary: false });
    });
    expect(screen.getByRole("heading", { name: "Reopened" })).toBeVisible();
    expect(screen.queryByText(/Obsolete/)).not.toBeInTheDocument();
  });

  it("does not restart an active read when an unrelated cached tab closes", async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof readFileContent>>>();
    render(<FileBrowser root="/p" />);
    await user.click(await screen.findByText("paper.pdf"));
    await screen.findByRole("group", { name: "PDF controls" });
    vi.mocked(readFileContent).mockReturnValue(pending.promise);
    await user.click(screen.getByText("notes.md"));
    await user.click(screen.getByRole("button", { name: "Close paper.pdf" }));
    await act(async () =>
      pending.resolve({ path: "/p/notes.md", content: "# Notes", byteCount: 7, truncated: false, binary: false }),
    );
    expect(await screen.findByRole("heading", { name: "Notes" })).toBeVisible();
    expect(readFileContent).toHaveBeenCalledOnce();
  });

  it("does not repopulate the closed cache when a read completes before effect cleanup", async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof readFileContent>>>();
    vi.mocked(readFileContent).mockReturnValueOnce(pending.promise).mockResolvedValue({
      path: "/p/notes.md",
      content: "# Fresh",
      byteCount: 7,
      truncated: false,
      binary: false,
    });
    render(<FileBrowser root="/p" />);
    await user.click(await screen.findByText("notes.md"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close notes.md" }));
      pending.resolve({ path: "/p/notes.md", content: "# Obsolete", byteCount: 10, truncated: false, binary: false });
      await pending.promise;
    });
    await user.click(screen.getByText("notes.md"));
    expect(await screen.findByRole("heading", { name: "Fresh" })).toBeVisible();
    expect(readFileContent).toHaveBeenCalledTimes(2);
  });

  it("supersedes a pending read when a watcher invalidates the open file", async () => {
    const user = userEvent.setup();
    const old = Promise.withResolvers<Awaited<ReturnType<typeof readFileContent>>>();
    const fresh = Promise.withResolvers<Awaited<ReturnType<typeof readFileContent>>>();
    vi.mocked(readFileContent).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const view = render(<FileBrowser root="/p" />);
    await user.click(await screen.findByText("notes.md"));
    view.rerender(
      <FileBrowser
        root="/p"
        fileEvents={[
          {
            sequence: 1,
            event: { type: "file.watcher.updated", properties: { file: "/p/notes.md", event: "change" } },
          },
        ]}
      />,
    );
    await waitFor(() => expect(readFileContent).toHaveBeenCalledTimes(2));
    await act(async () =>
      old.resolve({ path: "/p/notes.md", content: "# Obsolete", byteCount: 10, truncated: false, binary: false }),
    );
    expect(screen.queryByRole("heading", { name: "Obsolete" })).not.toBeInTheDocument();
    await act(async () =>
      fresh.resolve({ path: "/p/notes.md", content: "# Fresh", byteCount: 7, truncated: false, binary: false }),
    );
    expect(await screen.findByRole("heading", { name: "Fresh" })).toBeVisible();
  });

  it("switches mobile tree and preview without losing tree state and restores browsing after last close", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const user = userEvent.setup();
    vi.mocked(readFileContent).mockResolvedValue({
      path: "/p/notes.md",
      content: "# Mobile notes",
      byteCount: 14,
      truncated: false,
      binary: false,
    });
    render(<FileBrowser root="/p" />);
    const tree = await screen.findByRole("tree", { name: "Project files tree" });
    const toggle = screen.getByRole("button", { name: "Toggle file tree" });
    fireEvent.change(screen.getByRole("textbox", { name: "Filter files" }), { target: { value: "notes" } });
    await user.click(screen.getByRole("treeitem", { name: /notes\.md/ }));
    const heading = await screen.findByRole("heading", { name: "Mobile notes" });
    expect(tree).not.toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(screen.getByRole("tree", { name: "Project files tree" })).toBe(tree);
    expect(tree).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Filter files" })).toHaveValue("notes");
    expect(heading).not.toBeVisible();
    expect(screen.getByRole("tab", { name: "notes.md" })).toHaveAttribute("aria-selected", "false");
    await user.click(screen.getByRole("tab", { name: "notes.md" }));
    expect(heading).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close notes.md" }));
    expect(tree).toBeVisible();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("reacts to breakpoint crossings while preserving the desktop tree preference", async () => {
    const user = userEvent.setup();
    render(<FileBrowser root="/p" />);
    await user.click(await screen.findByText("paper.pdf"));
    const controls = await screen.findByRole("group", { name: "PDF controls" });
    const tree = screen.getByRole("tree", { name: "Project files tree" });
    expect(tree).toBeVisible();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    fireEvent(window, new Event("resize"));
    expect(tree).not.toBeVisible();
    expect(controls).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Toggle file tree" }));
    expect(controls).not.toBeVisible();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
    fireEvent(window, new Event("resize"));
    expect(tree).toBeVisible();
    expect(controls).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Toggle file tree" }));
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    fireEvent(window, new Event("resize"));
    expect(tree).toBeVisible();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
    fireEvent(window, new Event("resize"));
    expect(tree).not.toBeVisible();
    expect(controls).toBeVisible();
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
    const { rerender } = render(<FileBrowser root="/p" />);
    await user.click(await screen.findByText("notes.md"));
    expect(await screen.findByText("old content")).toBeVisible();

    rerender(
      <FileBrowser
        root="/p"
        fileEvents={[
          { sequence: 1, event: { type: "file.watcher.updated", properties: { file: "/p", event: "change" } } },
        ]}
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
