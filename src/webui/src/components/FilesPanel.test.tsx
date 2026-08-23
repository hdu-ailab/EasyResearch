import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileWatcherEvent } from "../../../web/contracts";
import * as api from "../api";
import { FilesPanel } from "./FilesPanel";

vi.mock("../api", () => ({
  listEntries: vi.fn(),
  replaceFileWatchDirectories: vi.fn(),
}));

describe("FilesPanel", () => {
  beforeEach(() => {
    vi.mocked(api.listEntries).mockReset();
    vi.mocked(api.replaceFileWatchDirectories).mockReset().mockResolvedValue(undefined);
  });

  it("shows loading without listing the root until parent session hydration finishes", async () => {
    vi.mocked(api.listEntries).mockResolvedValue([{ kind: "file", name: "paper.md", path: "/p/paper.md" }]);
    const { rerender } = render(
      <FilesPanel
        root="/p"
        loadEnabled={false}
        sessionId="session-1"
        fileWatchLeaseId="lease-1"
        onOpenFile={() => {}}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Loading…")).toBeVisible();
    expect(api.listEntries).not.toHaveBeenCalled();
    expect(api.replaceFileWatchDirectories).not.toHaveBeenCalled();

    rerender(
      <FilesPanel root="/p" loadEnabled sessionId="session-1" fileWatchLeaseId="lease-1" onOpenFile={() => {}} />,
    );
    expect(await screen.findByText("paper.md")).toBeVisible();
    expect(api.listEntries).toHaveBeenCalledOnce();
  });

  it("replaces the lease with only the root and currently visible expanded directories", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listEntries).mockImplementation(async (path) => {
      if (path === "/p") return [{ kind: "directory", name: "folder", path: "/p/folder" }];
      if (path === "/p/folder") return [{ kind: "directory", name: "nested", path: "/p/folder/nested" }];
      return [{ kind: "file", name: "paper.md", path: "/p/folder/nested/paper.md" }];
    });
    render(<FilesPanel root="/p" sessionId="session-1" fileWatchLeaseId="lease-1" onOpenFile={() => {}} />);

    await screen.findByText("folder");
    await waitFor(() =>
      expect(api.replaceFileWatchDirectories).toHaveBeenLastCalledWith("session-1", "lease-1", expect.any(Number), [
        "/p",
      ]),
    );

    await user.click(screen.getByText("folder"));
    await screen.findByText("nested");
    await waitFor(() =>
      expect(api.replaceFileWatchDirectories).toHaveBeenLastCalledWith("session-1", "lease-1", expect.any(Number), [
        "/p",
        "/p/folder",
      ]),
    );

    await user.click(screen.getByText("nested"));
    await screen.findByText("paper.md");
    await waitFor(() =>
      expect(api.replaceFileWatchDirectories).toHaveBeenLastCalledWith("session-1", "lease-1", expect.any(Number), [
        "/p",
        "/p/folder",
        "/p/folder/nested",
      ]),
    );

    await user.click(screen.getByText("folder"));
    await waitFor(() =>
      expect(api.replaceFileWatchDirectories).toHaveBeenLastCalledWith("session-1", "lease-1", expect.any(Number), [
        "/p",
      ]),
    );
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

  it("uses roving tree focus with arrow, Home, and hierarchy navigation", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listEntries).mockImplementation(async (path) => {
      if (path === "/p") {
        return [
          { kind: "directory", name: "folder", path: "/p/folder" },
          { kind: "file", name: "sibling.txt", path: "/p/sibling.txt" },
        ];
      }
      return [{ kind: "file", name: "nested.txt", path: "/p/folder/nested.txt" }];
    });
    render(<FilesPanel root="/p" onOpenFile={() => {}} />);
    const folder = await screen.findByRole("treeitem", { name: /folder/i });
    const sibling = screen.getByRole("treeitem", { name: /sibling.txt/i });

    expect(folder).toHaveAttribute("tabindex", "0");
    expect(sibling).toHaveAttribute("tabindex", "-1");
    folder.focus();
    await user.keyboard("{ArrowDown}");
    expect(sibling).toHaveFocus();
    await user.keyboard("{Home}{ArrowRight}");
    expect(folder).toHaveAttribute("aria-expanded", "true");
    const nested = await screen.findByRole("treeitem", { name: /nested.txt/i });
    await user.keyboard("{ArrowRight}");
    expect(nested).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(folder).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(folder).toHaveAttribute("aria-expanded", "false");
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
