import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileContentDto } from "../../../web/contracts";
import { listEntries, readFileContent, renameFile } from "../api";
import { FileBrowser, type FileBrowserHandle } from "./FileBrowser";
import { previewKind } from "./previews/preview-kind";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listEntries: vi.fn(),
  readFileContent: vi.fn(),
  renameFile: vi.fn(),
}));
vi.mock("./previews/preview-kind", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./previews/preview-kind")>();
  return { ...actual, previewKind: vi.fn(actual.previewKind) };
});
// Isolate the file-state owner from media engines; real renderers have their own component suites.
vi.mock("./previews/FilePreview", async () => {
  const { previewKind } = await import("./previews/preview-kind");
  return {
    FilePreview: ({
      path,
      revision,
      textFile,
    }: {
      path: string;
      revision: number;
      textFile: FileContentDto | null;
    }) => (
      <div data-testid="preview" data-path={path} data-kind={previewKind(path)} data-revision={revision}>
        {textFile?.content}
      </div>
    ),
  };
});

const content = (path: string, text: string): FileContentDto => ({
  path,
  content: text,
  byteCount: text.length,
  binary: false,
  truncated: false,
});
const original = { kind: "file" as const, name: "notes.txt", path: "/p/notes.txt" };
const renamed = { kind: "file" as const, name: "renamed.md", path: "/p/renamed.md" };

beforeEach(() => {
  vi.mocked(previewKind).mockReset();
  vi.mocked(listEntries).mockReset().mockResolvedValue([original]);
  vi.mocked(readFileContent)
    .mockReset()
    .mockImplementation(async (path) => content(path, "Current bytes"));
  vi.mocked(renameFile).mockReset().mockResolvedValue({ oldPath: original.path, entry: renamed });
});

async function renameTo(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Actions for notes.txt" }));
  await user.click(screen.getByRole("menuitem", { name: "Rename file" }));
  await user.clear(screen.getByRole("textbox", { name: "File name" }));
  await user.type(screen.getByRole("textbox", { name: "File name" }), name);
  await user.click(screen.getByRole("button", { name: "Rename file" }));
}

describe("file rename and request ownership", () => {
  it.each(["pdf", "docx", "image", "video", "html"])(
    "lets the %s viewer own byte loading and watcher revisions",
    async (kind) => {
      // Exercise the owner's contract independently of the preview agent's extension classifier.
      vi.mocked(previewKind).mockReturnValue(kind as ReturnType<typeof previewKind>);
      const user = userEvent.setup();
      const view = render(<FileBrowser root="/p" />);
      await user.click(await screen.findByText("notes.txt"));
      await waitFor(() => expect(screen.getByTestId("preview")).toHaveAttribute("data-kind", kind));
      view.rerender(
        <FileBrowser
          root="/p"
          fileEvents={[
            {
              sequence: 1,
              event: { type: "file.watcher.updated", properties: { file: original.path, event: "change" } },
            },
          ]}
        />,
      );
      await waitFor(() => expect(screen.getByTestId("preview")).toHaveAttribute("data-revision", "1"));
      expect(readFileContent).not.toHaveBeenCalled();
    },
  );

  it("rekeys the selected tab, deduplicates a former destination, reclassifies, and discards both superseded caches", async () => {
    const user = userEvent.setup();
    const browser = createRef<FileBrowserHandle>();
    const oldRead = Promise.withResolvers<FileContentDto>();
    let destinationReads = 0;
    let sourceReads = 0;
    vi.mocked(readFileContent).mockImplementation(async (path) => {
      if (path === original.path) return ++sourceReads === 1 ? oldRead.promise : content(path, "Recreated source");
      return content(path, ++destinationReads === 1 ? "Old destination bytes" : "Renamed bytes");
    });
    render(<FileBrowser ref={browser} root="/p" />);
    await screen.findByText("notes.txt");
    act(() => browser.current?.openPath(renamed.path));
    await screen.findByText("Old destination bytes");
    await user.click(screen.getByText("notes.txt"));
    vi.mocked(listEntries).mockResolvedValue([renamed]);
    await renameTo(renamed.name);
    expect(await screen.findByText("Renamed bytes")).toBeVisible();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toHaveAccessibleName(renamed.name);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("preview")).toHaveAttribute("data-kind", "markdown");
    expect(screen.getByTestId("preview")).toHaveAttribute("data-revision", "1");
    await act(async () => oldRead.resolve(content(original.path, "Late old-path bytes")));
    expect(screen.queryByText("Late old-path bytes")).not.toBeInTheDocument();
    act(() => browser.current?.openPath(original.path));
    expect(await screen.findByText("Recreated source")).toBeVisible();
    expect(sourceReads).toBe(2);
    expect(destinationReads).toBe(2);
  });

  it("changes a text file into a raw preview without issuing another bounded text request", async () => {
    const user = userEvent.setup();
    const target = { kind: "file" as const, path: "/p/report.pdf", name: "report.pdf" };
    vi.mocked(renameFile).mockResolvedValue({ oldPath: original.path, entry: target });
    render(<FileBrowser root="/p" />);
    await user.click(await screen.findByText("notes.txt"));
    await screen.findByText("Current bytes");
    vi.mocked(listEntries).mockResolvedValue([target]);
    await renameTo(target.name);
    await waitFor(() => expect(screen.getByTestId("preview")).toHaveAttribute("data-path", target.path));
    expect(screen.getByTestId("preview")).toHaveAttribute("data-kind", "pdf");
    expect(readFileContent).toHaveBeenCalledExactlyOnceWith(original.path);
    expect(screen.queryByText("Current bytes")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: target.name })).toHaveAttribute("aria-selected", "true");
  });

  it("preserves an unrelated active tab and the renamed tab's position", async () => {
    const user = userEvent.setup();
    const browser = createRef<FileBrowserHandle>();
    render(<FileBrowser ref={browser} root="/p" />);
    await user.click(await screen.findByText("notes.txt"));
    await screen.findByText("Current bytes");
    act(() => browser.current?.openPath("/shared/other.txt"));
    vi.mocked(listEntries).mockResolvedValue([renamed]);
    await renameTo(renamed.name);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([renamed.name, "other.txt"]);
    expect(screen.getByRole("tab", { name: "other.txt" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("preview")).toHaveAttribute("data-path", "/shared/other.txt");
  });

  it("drops a root's tabs and pending reads before the new root can reopen the same external path", async () => {
    const user = userEvent.setup();
    const browser = createRef<FileBrowserHandle>();
    const oldRead = Promise.withResolvers<FileContentDto>();
    vi.mocked(readFileContent)
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValue(content(original.path, "Fresh owner"));
    const view = render(<FileBrowser ref={browser} root="/p" />);
    await user.click(await screen.findByText("notes.txt"));
    view.rerender(<FileBrowser ref={browser} root="/other" />);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    await act(async () => oldRead.resolve(content(original.path, "Obsolete root")));
    act(() => browser.current?.openPath(original.path));
    expect(await screen.findByText("Fresh owner")).toBeVisible();
    expect(screen.queryByText("Obsolete root")).not.toBeInTheDocument();
    expect(readFileContent).toHaveBeenCalledTimes(2);
  });
});
