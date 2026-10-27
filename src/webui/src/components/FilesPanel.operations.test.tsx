import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_UPLOAD_LIMIT, type FileUploadResultDto } from "../../../web/contracts";
import { ApiError, listEntries, renameFile, uploadFile } from "../api";
import { FILE_UPLOAD_QUEUE_LIMIT } from "../hooks/useFileUploads";
import { FilesPanel } from "./FilesPanel";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listEntries: vi.fn(),
  uploadFile: vi.fn(),
  renameFile: vi.fn(),
  replaceFileWatchDirectories: vi.fn().mockResolvedValue(undefined),
}));

const paper = { kind: "file" as const, name: "paper.md", path: "/p/paper.md" };
const folder = { kind: "directory" as const, name: "figures", path: "/p/figures" };
type Transfer = ReturnType<typeof Promise.withResolvers<FileUploadResultDto>> & {
  options: NonNullable<Parameters<typeof uploadFile>[3]>;
  directory: string;
  file: File;
};
let transfers: Transfer[];
const files = () => [new File(["abcd"], "one.txt"), new File(["ef"], "two.txt")];
const picker = (container: HTMLElement) => container.querySelector<HTMLInputElement>('input[type="file"]')!;

async function renameWithPendingListing(user: ReturnType<typeof userEvent.setup>) {
  const opener = await screen.findByRole("button", { name: "Actions for paper.md" });
  const listing = Promise.withResolvers<Awaited<ReturnType<typeof listEntries>>>();
  const result = { oldPath: paper.path, entry: { ...paper, name: "report.md", path: "/p/report.md" } };
  vi.mocked(listEntries).mockReturnValueOnce(listing.promise);
  vi.mocked(renameFile).mockResolvedValueOnce(result);
  await user.click(opener);
  await user.keyboard("{End}{Enter}");
  const name = screen.getByRole("textbox", { name: "File name" });
  expect(name).toHaveFocus();
  await user.clear(name);
  await user.type(name, "report.md{Enter}");
  await waitFor(() => expect(listEntries).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
  return { opener, listing, result };
}

beforeEach(() => {
  transfers = [];
  vi.mocked(listEntries)
    .mockReset()
    .mockImplementation(async (path) => (path === "/p" ? [folder, paper] : []));
  vi.mocked(renameFile).mockReset();
  vi.mocked(uploadFile)
    .mockReset()
    .mockImplementation((_cwd, directory, file, options = {}) => {
      const pending = Promise.withResolvers<FileUploadResultDto>();
      transfers.push({ ...pending, directory, file, options });
      options.signal?.addEventListener("abort", () => pending.reject(new DOMException("Aborted", "AbortError")));
      return pending.promise;
    });
});

describe("file management interactions", () => {
  it("queues multiple root files, reports real progress, and refreshes only after server acceptance", async () => {
    const user = userEvent.setup();
    const view = render(<FilesPanel root="/p" onOpenFile={vi.fn()} />);
    await screen.findByText("paper.md");
    await user.upload(picker(view.container), files());
    expect(transfers.map((item) => item.directory)).toEqual(["/p", "/p"]);
    expect(screen.getAllByText("To: /p")).toHaveLength(2);
    await act(async () => transfers[0]!.options.onProgress?.(2, 4));
    expect(screen.getByRole("progressbar", { name: "Upload progress for one.txt" })).toHaveAttribute("value", "50");
    expect(screen.getByText("2 / 4 bytes")).toBeVisible();
    await act(async () => transfers[0]!.options.onProgress?.(4, 4));
    expect(screen.getByText("Bytes sent · waiting for server…")).toBeVisible();
    expect(screen.queryByText("Uploaded")).not.toBeInTheDocument();
    expect(listEntries).toHaveBeenCalledTimes(1);
    vi.mocked(listEntries).mockResolvedValue([folder, paper, { kind: "file", name: "one.txt", path: "/p/one.txt" }]);
    await act(async () => transfers[0]!.resolve({ entry: { kind: "file", name: "one.txt", path: "/p/one.txt" } }));
    expect(await screen.findByRole("treeitem", { name: /one.txt/ })).toBeVisible();
    expect(screen.getByText("Uploaded")).toBeVisible();
    expect(listEntries).toHaveBeenCalledTimes(2);
  });

  it("uploads to a directory selected from its keyboard menu without opening it", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const view = render(<FilesPanel root="/p" onOpenFile={onOpen} />);
    const action = await screen.findByRole("button", { name: "Actions for figures" });
    action.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Upload here" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.upload(picker(view.container), files());
    expect(transfers.map((item) => item.directory)).toEqual([folder.path, folder.path]);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByRole("treeitem", { name: /figures/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByText(`To: ${folder.path}`)).toHaveLength(2);
    await act(async () =>
      transfers[0]!.resolve({ entry: { kind: "file", name: "one.txt", path: `${folder.path}/one.txt` } }),
    );
    await waitFor(() => expect(listEntries).toHaveBeenCalledWith(folder.path));
    await user.click(screen.getByRole("button", { name: "Upload files" }));
    await user.upload(picker(view.container), new File([], "root.txt"));
    expect(transfers.at(-1)!.directory).toBe("/p");
  });

  it("shows no-clobber conflict feedback and retries only the failed file", async () => {
    const user = userEvent.setup();
    const view = render(<FilesPanel root="/p" onOpenFile={vi.fn()} />);
    await screen.findByText("paper.md");
    const selected = files();
    await user.upload(picker(view.container), selected);
    await act(async () => transfers[0]!.reject(new ApiError(409, { code: "FILE_EXISTS", error: "exists" })));
    expect(screen.getByRole("alert")).toHaveTextContent("The existing file was not replaced");
    expect(listEntries).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Retry one.txt" }));
    expect(transfers).toHaveLength(3);
    expect(transfers[2]!.file).toBe(selected[0]);
    expect(transfers[2]!.directory).toBe("/p");
    expect(transfers[1]!.options.signal?.aborted).toBe(false);
  });

  it("cancels a queued file without a request and an active file before admitting its retry", async () => {
    const user = userEvent.setup();
    const view = render(<FilesPanel root="/p" onOpenFile={vi.fn()} />);
    await screen.findByText("paper.md");
    await user.upload(picker(view.container), [...files(), new File(["queued"], "three.txt")]);
    expect(transfers).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Cancel upload of three.txt" }));
    expect(transfers).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Cancel upload of one.txt" }));
    expect(transfers[0]!.options.signal?.aborted).toBe(true);
    expect(screen.getAllByText("Cancelled")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Retry three.txt" }));
    expect(transfers).toHaveLength(3);
    expect(transfers[2]!.file.name).toBe("three.txt");
    expect(listEntries).toHaveBeenCalledTimes(1);
  });

  it("rejects oversize files before sending and bounds retained rows while reporting unqueued selections", async () => {
    const user = userEvent.setup();
    const view = render(<FilesPanel root="/p" onOpenFile={vi.fn()} />);
    await screen.findByText("paper.md");
    const large = new File([], "large.bin");
    Object.defineProperty(large, "size", { value: FILE_UPLOAD_LIMIT + 1 });
    await user.upload(picker(view.container), [large]);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("1 GiB");
    expect(screen.queryByRole("button", { name: "Retry large.bin" })).not.toBeInTheDocument();
    await user.upload(
      picker(view.container),
      Array.from({ length: FILE_UPLOAD_QUEUE_LIMIT }, (_, i) => new File([], `${i}.txt`)),
    );
    const region = screen.getByRole("region", { name: "File uploads" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(FILE_UPLOAD_QUEUE_LIMIT);
    expect(
      within(region)
        .getAllByRole("alert")
        .some((item) => item.textContent?.includes("list is full")),
    ).toBe(true);
    expect(transfers).toHaveLength(2);
  });

  it.each(["root", "unmount"])(
    "cancels transfers and rejects late progress/completion on %s replacement",
    async (boundary) => {
      const user = userEvent.setup();
      const view = render(<FilesPanel root="/p" onOpenFile={vi.fn()} />);
      await screen.findByText("paper.md");
      await user.upload(picker(view.container), [...files(), new File([], "queued.txt")]);
      if (boundary === "root") view.rerender(<FilesPanel root="/other" onOpenFile={vi.fn()} />);
      else view.unmount();
      await act(async () => {
        for (const transfer of transfers) {
          expect(transfer.options.signal?.aborted).toBe(true);
          transfer.options.onProgress?.(transfer.file.size, transfer.file.size);
          transfer.resolve({ entry: paper });
        }
      });
      expect(transfers).toHaveLength(2);
      expect(screen.queryByRole("region", { name: "File uploads" })).not.toBeInTheDocument();
      expect(vi.mocked(listEntries).mock.calls.filter(([path]) => path === "/p")).toHaveLength(1);
    },
  );

  it("keeps filtered file actions separate from opening/dragging and exposes attachment downloads", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<FilesPanel root="/p" onOpenFile={onOpen} />);
    await screen.findByText("paper.md");
    await user.type(screen.getByRole("textbox", { name: "Filter files" }), "paper");
    await user.click(screen.getByRole("button", { name: "Actions for paper.md" }));
    const download = screen.getByRole("menuitem", { name: "Download" });
    expect(download).toHaveAttribute("href", "/api/file/raw?path=%2Fp%2Fpaper.md&download=1");
    expect(download).toHaveAttribute("download", "paper.md");
    expect(screen.getByRole("treeitem", { name: /paper.md/ })).toHaveAttribute("draggable", "true");
    expect(screen.getByRole("button", { name: "Actions for paper.md" }).closest("[draggable=true]")).toBeNull();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByRole("dialog", { name: "Rename file" })).toBeVisible();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("retains rename values/errors, blocks duplicate/busy dismissal, and restores tree focus after success", async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof renameFile>>>();
    vi.mocked(renameFile)
      .mockRejectedValueOnce(new ApiError(409, { code: "FILE_EXISTS" }))
      .mockReturnValueOnce(pending.promise);
    const onRenamed = vi.fn();
    render(<FilesPanel root="/p" onOpenFile={vi.fn()} onFileRenamed={onRenamed} />);
    await user.click(await screen.findByRole("button", { name: "Actions for paper.md" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename file" }));
    const name = screen.getByRole("textbox", { name: "File name" });
    expect(name).toHaveFocus();
    await user.clear(name);
    await user.type(name, "report.md");
    await user.click(screen.getByRole("button", { name: "Rename file" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("existing file was not replaced");
    expect(name).toHaveValue("report.md");
    await user.click(screen.getByRole("button", { name: "Rename file" }));
    const dialog = screen.getByRole("dialog", { name: "Rename file" });
    fireEvent.submit(dialog);
    await user.keyboard("{Escape}");
    expect(dialog).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(renameFile).toHaveBeenCalledTimes(2);
    const result = { oldPath: paper.path, entry: { ...paper, name: "report.md", path: "/p/report.md" } };
    vi.mocked(listEntries).mockResolvedValue([result.entry]);
    await act(async () => pending.resolve(result));
    expect(onRenamed).toHaveBeenCalledExactlyOnceWith(result);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("treeitem", { name: /report.md/ })).toHaveFocus());
    expect(renameFile).toHaveBeenLastCalledWith("/p", paper.path, "report.md");
  });

  it.each(["", "paper"])(
    "preserves another input's focus and draft during delayed rename refresh (filter %j)",
    async (filter) => {
      const user = userEvent.setup();
      render(
        <>
          <FilesPanel root="/p" onOpenFile={vi.fn()} />
          <input aria-label="Draft" />
        </>,
      );
      await screen.findByRole("button", { name: "Actions for paper.md" });
      if (filter) await user.type(screen.getByRole("textbox", { name: "Filter files" }), filter);
      const { listing, result } = await renameWithPendingListing(user);
      await user.tab();
      const draft = screen.getByRole("textbox", { name: "Draft" });
      expect(draft).toHaveFocus();
      await user.keyboard("continue");
      expect(draft).toHaveValue("continue");
      await act(async () => listing.resolve([folder, result.entry]));
      expect(screen.queryByRole("button", { name: "Actions for paper.md" })).not.toBeInTheDocument();
      expect(draft).toHaveFocus();
      await user.keyboard("!");
      expect(draft).toHaveValue("continue!");
    },
  );

  it("keeps focus in an edited filter when the delayed renamed row arrives", async () => {
    const user = userEvent.setup();
    render(<FilesPanel root="/p" onOpenFile={vi.fn()} />);
    const { listing, result } = await renameWithPendingListing(user);
    const filter = screen.getByRole("textbox", { name: "Filter files" });
    await user.type(filter, "report");
    expect(screen.queryByRole("treeitem", { name: /report.md/ })).not.toBeInTheDocument();
    await act(async () => listing.resolve([folder, result.entry]));
    expect(screen.getByRole("treeitem", { name: /report.md/ })).toBeVisible();
    expect(filter).toHaveFocus();
    await user.keyboard(".md");
    expect(filter).toHaveValue("report.md");
  });

  it.each(["", "paper"])(
    "restores rename focus after a delayed listing when ownership is retained (filter %j)",
    async (filter) => {
      const user = userEvent.setup();
      const onOpen = vi.fn();
      render(<FilesPanel root="/p" onOpenFile={onOpen} />);
      await screen.findByRole("button", { name: "Actions for paper.md" });
      const filterInput = screen.getByRole("textbox", { name: "Filter files" });
      if (filter) await user.type(filterInput, filter);
      const { listing, result } = await renameWithPendingListing(user);
      await act(async () => listing.resolve([folder, result.entry]));
      if (filter) {
        expect(screen.queryByRole("treeitem")).not.toBeInTheDocument();
        expect(filterInput).toHaveFocus();
        expect(filterInput).toHaveValue(filter);
      } else {
        expect(screen.getByRole("treeitem", { name: /report.md/ })).toHaveFocus();
        await user.keyboard("{Enter}");
        expect(onOpen).toHaveBeenCalledExactlyOnceWith(result.entry);
      }
    },
  );

  it("does not reclaim pending rename focus after the user leaves and returns to its opener", async () => {
    const user = userEvent.setup();
    render(
      <>
        <FilesPanel root="/p" onOpenFile={vi.fn()} />
        <input aria-label="Draft" />
      </>,
    );
    const { opener, listing, result } = await renameWithPendingListing(user);
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Draft" })).toHaveFocus();
    await user.keyboard("continue");
    await user.tab({ shift: true });
    expect(opener).toHaveFocus();
    await act(async () => listing.resolve([folder, result.entry]));
    expect(screen.getByRole("treeitem", { name: /report.md/ })).not.toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("continue");
  });

  it("preserves a newer rename modal's focus and keyboard flow while the old listing resolves", async () => {
    const user = userEvent.setup();
    const notes = { ...paper, name: "notes.md", path: "/p/notes.md" };
    vi.mocked(listEntries).mockResolvedValueOnce([notes, paper]);
    render(<FilesPanel root="/p" onOpenFile={vi.fn()} />);
    const { listing, result } = await renameWithPendingListing(user);
    const opener = screen.getByRole("button", { name: "Actions for notes.md" });
    await user.click(opener);
    await user.keyboard("{End}{Enter}");
    const name = screen.getByRole("textbox", { name: "File name" });
    await user.clear(name);
    await user.type(name, "notes-draft.md");
    await user.tab();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    await act(async () => listing.resolve([notes, result.entry]));
    expect(screen.getByRole("dialog", { name: "Rename file" })).toHaveAttribute("aria-modal", "true");
    expect(cancel).toHaveFocus();
    expect(name).toHaveValue("notes-draft.md");
    await user.tab();
    expect(screen.getByRole("button", { name: "Rename file" })).toHaveFocus();
    await user.tab();
    expect(name).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it.each(["root", "unmount"])("ignores rename completion from an obsolete %s owner", async (boundary) => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof renameFile>>>();
    vi.mocked(renameFile).mockReturnValue(pending.promise);
    const onRenamed = vi.fn();
    const view = render(<FilesPanel root="/p" onOpenFile={vi.fn()} onFileRenamed={onRenamed} />);
    await user.click(await screen.findByRole("button", { name: "Actions for paper.md" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename file" }));
    await user.click(screen.getByRole("button", { name: "Rename file" }));
    if (boundary === "root") view.rerender(<FilesPanel root="/other" onOpenFile={vi.fn()} onFileRenamed={onRenamed} />);
    else view.unmount();
    await act(async () => pending.resolve({ oldPath: paper.path, entry: paper }));
    expect(onRenamed).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
