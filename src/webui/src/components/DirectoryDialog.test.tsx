// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DirectoryDialog } from "./DirectoryDialog";
import * as api from "../api";

vi.mock("../api", () => ({
  listDirectories: vi.fn(),
}));

const HOME = "/home/user";

function mockListing(map: Record<string, string[]>) {
  vi.mocked(api.listDirectories).mockImplementation(async (p) => {
    const names = map[p];
    if (!names) throw new Error(`unexpected path ${p}`);
    return names.map((name) => ({ name, path: `${p}/${name}` }));
  });
}

describe("DirectoryDialog", () => {
  beforeEach(() => {
    vi.mocked(api.listDirectories).mockReset();
  });

  it("loads the home tree on mount", async () => {
    mockListing({ [HOME]: ["papers", "notes"] });
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    expect(await screen.findByText("papers")).toBeTruthy();
    expect(screen.getByText("notes")).toBeTruthy();
  });

  it("shows a chevron for untouched directories and a spinner only while loading", async () => {
    const user = userEvent.setup();
    const pending = new Promise<{ name: string; path: string }[]>(() => {});
    vi.mocked(api.listDirectories).mockImplementation(async (p) => {
      if (p === HOME) return [{ name: "folder", path: `${HOME}/folder` }];
      return pending;
    });
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    expect(await screen.findByText("folder")).toBeVisible();
    expect(screen.queryByLabelText("Loading folder")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand folder" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Expand folder" }));
    expect(screen.getByLabelText("Loading folder")).toBeVisible();
  });

  it("shows a loading message instead of empty content while the root is pending", async () => {
    const pending = new Promise<{ name: string; path: string }[]>(() => {});
    vi.mocked(api.listDirectories).mockImplementation(async () => pending);
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    expect(await screen.findByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("No subdirectories.")).toBeNull();
  });

  it("shows Retry on a failed directory and recovers", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listDirectories).mockImplementation(async (p) => {
      if (p === HOME) return [{ name: "folder", path: `${HOME}/folder` }];
      throw new Error("boom");
    });
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    await user.click(await screen.findByText("folder"));
    await user.click(screen.getByRole("button", { name: "Expand folder" }));
    expect(await screen.findByRole("button", { name: "Retry folder" })).toBeTruthy();
    vi.mocked(api.listDirectories).mockImplementation(async (p) => {
      if (p === HOME) return [{ name: "folder", path: `${HOME}/folder` }];
      return [{ name: "nested", path: `${HOME}/folder/nested` }];
    });
    await user.click(screen.getByRole("button", { name: "Retry folder" }));
    expect(await screen.findByText("nested")).toBeTruthy();
  });

  it("expands a directory lazily", async () => {
    mockListing({ [HOME]: ["papers"], [`${HOME}/papers`]: ["draft"] });
    const user = userEvent.setup();
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    const row = await screen.findByText("papers");
    await user.click(row);
    expect(screen.queryByText("draft")).toBeNull();
    await user.click(screen.getByRole("button", { name: /expand/i }));
    expect(await screen.findByText("draft")).toBeTruthy();
  });

  it("selects a row and enables Create", async () => {
    mockListing({ [HOME]: ["notes"] });
    const user = userEvent.setup();
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    const create = screen.getByRole("button", { name: /create session/i });
    expect(create).toBeDisabled();
    await user.click(await screen.findByText("notes"));
    expect(create).toBeEnabled();
  });

  it("emits the selected path and closes on confirm", async () => {
    mockListing({ [HOME]: ["notes"] });
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<DirectoryDialog homeDir={HOME} onSelect={onSelect} onClose={onClose} />);
    await user.click(await screen.findByText("notes"));
    await user.click(screen.getByRole("button", { name: /create session/i }));
    expect(onSelect).toHaveBeenCalledWith(`${HOME}/notes`);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("surfaces a navigation error on Enter with a bad path", async () => {
    mockListing({ [HOME]: [] });
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<DirectoryDialog homeDir={HOME} onSelect={onSelect} onClose={() => {}} />);
    const input = screen.getByRole("combobox");
    await user.clear(input);
    await user.type(input, "papers");
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/unexpected path/)).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("suggests directories while typing and completes on Tab", async () => {
    mockListing({ [HOME]: ["papers", "notes"] });
    const user = userEvent.setup();
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("papers")).toBeTruthy());
    const input = screen.getByRole("combobox");
    await user.clear(input);
    await user.type(input, "/home/user/pa");
    const suggestion = await screen.findByRole("option");
    expect(suggestion).toHaveTextContent("papers");
    await user.tab();
    await waitFor(() => expect(input).toHaveValue("/home/user/papers"));
  });

  it("supports home shortcut navigation", async () => {
    mockListing({ [HOME]: ["papers"] });
    const user = userEvent.setup();
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("papers")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "~" }));
    expect(await screen.findByText("papers")).toBeTruthy();
  });

  it("closes on Escape and Cancel", async () => {
    mockListing({ [HOME]: [] });
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("surfaces listing errors inline", async () => {
    vi.mocked(api.listDirectories).mockRejectedValueOnce(new Error("boom"));
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    expect(await screen.findByText(/boom/)).toBeTruthy();
  });
});
