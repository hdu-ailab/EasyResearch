import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileWatcherEvent } from "../../../web/contracts";
import * as api from "../api";
import { FilesPanel } from "./FilesPanel";

vi.mock("../api", () => ({
  listEntries: vi.fn(),
}));

describe("FilesPanel", () => {
  beforeEach(() => {
    vi.mocked(api.listEntries).mockReset();
  });

  it("activates a failed directory retry with the keyboard without collapsing the row", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listEntries).mockImplementation(async (path) => {
      if (path === "/p") return [{ kind: "directory", name: "folder", path: "/p/folder" }];
      throw new Error("boom");
    });
    render(<FilesPanel root="/p" onOpenFile={() => {}} />);

    await user.click(await screen.findByText("folder"));
    const retry = await screen.findByRole("button", { name: "Retry folder" });
    vi.mocked(api.listEntries).mockResolvedValue([{ kind: "file", name: "nested.txt", path: "/p/folder/nested.txt" }]);

    retry.focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByText("nested.txt")).toBeVisible();
  });

  it("refreshes a loaded parent when a file is added", async () => {
    let rootEntries = [{ kind: "file" as const, name: "old.txt", path: "/p/old.txt" }];
    vi.mocked(api.listEntries).mockImplementation(async (path) => {
      if (path === "/p") return rootEntries;
      return [];
    });
    const { rerender } = render(<FilesPanel root="/p" onOpenFile={() => {}} fileEvent={null} />);
    expect(await screen.findByText("old.txt")).toBeVisible();

    rootEntries = [...rootEntries, { kind: "file", name: "new.txt", path: "/p/new.txt" }];
    const event: FileWatcherEvent = {
      type: "file.watcher.updated",
      properties: { file: "/p/new.txt", event: "add" },
    };
    rerender(<FilesPanel root="/p" onOpenFile={() => {}} fileEvent={event} />);

    expect(await screen.findByText("new.txt")).toBeVisible();
  });

  it("refreshes an expanded parent on unlink while preserving expansion", async () => {
    let folderEntries = [{ kind: "file" as const, name: "old.txt", path: "/p/folder/old.txt" }];
    vi.mocked(api.listEntries).mockImplementation(async (path) => {
      if (path === "/p") return [{ kind: "directory", name: "folder", path: "/p/folder" }];
      if (path === "/p/folder") return folderEntries;
      return [];
    });
    const { rerender } = render(<FilesPanel root="/p" onOpenFile={() => {}} fileEvent={null} />);
    await userEvent.setup().click(await screen.findByText("folder"));
    expect(await screen.findByText("old.txt")).toBeVisible();

    folderEntries = [{ kind: "file", name: "new.txt", path: "/p/folder/new.txt" }];
    rerender(
      <FilesPanel
        root="/p"
        onOpenFile={() => {}}
        fileEvent={{
          type: "file.watcher.updated",
          properties: { file: "/p/folder/old.txt", event: "unlink" },
        }}
      />,
    );

    expect(await screen.findByText("new.txt")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("treeitem", { name: /folder/ })).toHaveAttribute("aria-expanded", "true"),
    );
  });

  it("does not fetch an untouched directory for a nested event", async () => {
    vi.mocked(api.listEntries).mockResolvedValue([{ kind: "directory", name: "closed", path: "/p/closed" }]);
    const { rerender } = render(<FilesPanel root="/p" onOpenFile={() => {}} fileEvent={null} />);
    await screen.findByText("closed");
    vi.mocked(api.listEntries).mockClear();

    rerender(
      <FilesPanel
        root="/p"
        onOpenFile={() => {}}
        fileEvent={{
          type: "file.watcher.updated",
          properties: { file: "/p/closed/new.txt", event: "add" },
        }}
      />,
    );

    await waitFor(() => expect(api.listEntries).not.toHaveBeenCalledWith("/p/closed"));
  });
});
