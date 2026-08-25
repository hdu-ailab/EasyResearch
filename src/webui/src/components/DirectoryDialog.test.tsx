import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { DirectoryDialog } from "./DirectoryDialog";

vi.mock("../api", () => ({
  listDirectories: vi.fn(),
  createDirectory: vi.fn(),
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
    vi.mocked(api.createDirectory).mockReset();
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

  it("activates a failed directory retry with the keyboard without selecting the row", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listDirectories).mockImplementation(async (p) => {
      if (p === HOME) return [{ name: "folder", path: `${HOME}/folder` }];
      throw new Error("boom");
    });
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    await user.click(await screen.findByText("folder"));
    await user.click(screen.getByRole("button", { name: "Expand folder" }));
    const retry = await screen.findByRole("button", { name: "Retry folder" });
    vi.mocked(api.listDirectories).mockResolvedValue([{ name: "nested", path: `${HOME}/folder/nested` }]);

    retry.focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByText("nested")).toBeVisible();
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

  it("uses roving tree focus with arrow, Home, and hierarchy navigation", async () => {
    const user = userEvent.setup();
    mockListing({ [HOME]: ["papers", "notes"], [`${HOME}/papers`]: ["draft"] });
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    const papers = await screen.findByRole("treeitem", { name: /papers/i });
    const notes = screen.getByRole("treeitem", { name: /notes/i });

    expect(papers).toHaveAttribute("tabindex", "0");
    expect(notes).toHaveAttribute("tabindex", "-1");
    papers.focus();
    await user.keyboard("{ArrowDown}");
    expect(notes).toHaveFocus();
    await user.keyboard("{Home}{ArrowRight}");
    expect(papers).toHaveAttribute("aria-expanded", "true");
    const draft = await screen.findByRole("treeitem", { name: /draft/i });
    await user.keyboard("{ArrowRight}");
    expect(draft).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(papers).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(papers).toHaveAttribute("aria-expanded", "false");
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
    mockListing({ [HOME]: ["papers", "patches"] });
    const user = userEvent.setup();
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("papers")).toBeTruthy());
    const input = screen.getByRole("combobox");
    await user.clear(input);
    await user.type(input, "/home/user/pa");
    const suggestion = (await screen.findAllByRole("option"))[0];
    if (!suggestion) throw new Error("expected a path suggestion");
    expect(suggestion).toHaveTextContent("papers");
    expect(input).toHaveAttribute("aria-activedescendant", suggestion.id);
    await user.keyboard("{End}");
    expect(document.getElementById(input.getAttribute("aria-activedescendant") ?? "")).toHaveTextContent("patches");
    await user.keyboard("{Home}");
    await user.tab();
    await waitFor(() => expect(input).toHaveValue("/home/user/papers"));
  });

  it("closes path suggestions before Escape closes the dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mockListing({ [HOME]: ["papers"] });
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={onClose} />);
    const input = screen.getByRole("combobox", { name: /directory path/i });
    await user.clear(input);
    await user.type(input, "/home/user/pa");
    expect(await screen.findByRole("listbox")).toBeVisible();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(input).toHaveValue("/home/user/pa");
    await user.tab();
    expect(input).toHaveValue("/home/user/pa");
    expect(screen.getByRole("button", { name: "Home" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("supports home shortcut navigation", async () => {
    mockListing({ [HOME]: ["papers"] });
    const user = userEvent.setup();
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("papers")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Home" }));
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

  it("creates a nested project under the current view, enters it, and selects it", async () => {
    const user = userEvent.setup();
    mockListing({ [HOME]: ["papers"], [`${HOME}/papers`]: [], [`${HOME}/papers/new folder/review`]: [] });
    vi.mocked(api.createDirectory).mockResolvedValue({ path: `${HOME}/papers/new folder/review` });
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    await user.click(await screen.findByText("papers"));
    await user.click(screen.getByRole("button", { name: /expand papers/i }));
    const pathInput = screen.getByRole("combobox");
    await user.clear(pathInput);
    await user.type(pathInput, `${HOME}/papers`);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Create session" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /new project/i }));
    const createDialog = screen.getByRole("dialog", { name: "New project" });
    await user.type(createDialog.querySelector("input")!, "new folder/review");
    await user.click(within(createDialog).getByRole("button", { name: /create/i }));
    expect(api.createDirectory).toHaveBeenCalledWith(`${HOME}/papers/new folder/review`);
    expect(screen.getByRole("combobox")).toHaveValue(`${HOME}/papers/new folder/review`);
  });

  it("shows a folder creation error inline and rejects null bytes", async () => {
    const user = userEvent.setup();
    mockListing({ [HOME]: [] });
    vi.mocked(api.createDirectory).mockRejectedValue(new Error("cannot create"));
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: /new project/i }));
    const createDialog = screen.getByRole("dialog", { name: "New project" });
    await user.type(createDialog.querySelector("input")!, "bad\0name");
    await user.click(within(createDialog).getByRole("button", { name: /create/i }));
    expect(api.createDirectory).not.toHaveBeenCalled();
    expect(await screen.findByText(/null byte|invalid/i)).toBeTruthy();
    await user.clear(createDialog.querySelector("input")!);
    await user.type(createDialog.querySelector("input")!, "folder");
    await user.click(within(createDialog).getByRole("button", { name: /create/i }));
    expect(await screen.findByText(/cannot create/)).toBeTruthy();
  });
});
