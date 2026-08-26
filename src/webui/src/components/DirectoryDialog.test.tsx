import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { DirectoryDialog } from "./DirectoryDialog";

vi.mock("../api", () => ({
  listDirectories: vi.fn(),
  listDirectoryRoots: vi.fn(),
  createDirectory: vi.fn(),
}));

const HOME = "/home/user";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mockListing(map: Record<string, string[]>) {
  vi.mocked(api.listDirectories).mockImplementation(async (p) => {
    const names = map[p];
    if (!names) throw new Error(`unexpected path ${p}`);
    return { path: p, entries: names.map((name) => ({ name, path: `${p}/${name}` })) };
  });
}

describe("DirectoryDialog", () => {
  beforeEach(() => {
    vi.mocked(api.listDirectories).mockReset();
    vi.mocked(api.listDirectoryRoots)
      .mockReset()
      .mockResolvedValue([{ name: "/", path: "/" }]);
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
    const pending = new Promise<{ path: string; entries: { name: string; path: string }[] }>(() => {});
    vi.mocked(api.listDirectories).mockImplementation(async (p) => {
      if (p === HOME) return { path: p, entries: [{ name: "folder", path: `${HOME}/folder` }] };
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
    const pending = new Promise<{ path: string; entries: { name: string; path: string }[] }>(() => {});
    vi.mocked(api.listDirectories).mockImplementation(async () => pending);
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    expect(await screen.findByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("No subdirectories.")).toBeNull();
  });

  it("shows Retry on a failed directory and recovers", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listDirectories).mockImplementation(async (p) => {
      if (p === HOME) return { path: p, entries: [{ name: "folder", path: `${HOME}/folder` }] };
      throw new Error("boom");
    });
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    await user.click(await screen.findByText("folder"));
    await user.click(screen.getByRole("button", { name: "Expand folder" }));
    expect(await screen.findByRole("button", { name: "Retry folder" })).toBeTruthy();
    vi.mocked(api.listDirectories).mockImplementation(async (p) => {
      if (p === HOME) return { path: p, entries: [{ name: "folder", path: `${HOME}/folder` }] };
      return { path: p, entries: [{ name: "nested", path: `${HOME}/folder/nested` }] };
    });
    await user.click(screen.getByRole("button", { name: "Retry folder" }));
    expect(await screen.findByText("nested")).toBeTruthy();
  });

  it("activates a failed directory retry with the keyboard without selecting the row", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listDirectories).mockImplementation(async (p) => {
      if (p === HOME) return { path: p, entries: [{ name: "folder", path: `${HOME}/folder` }] };
      throw new Error("boom");
    });
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    await user.click(await screen.findByText("folder"));
    await user.click(screen.getByRole("button", { name: "Expand folder" }));
    const retry = await screen.findByRole("button", { name: "Retry folder" });
    vi.mocked(api.listDirectories).mockResolvedValue({
      path: `${HOME}/folder`,
      entries: [{ name: "nested", path: `${HOME}/folder/nested` }],
    });

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

  it("selects the canonical directory returned by the server", async () => {
    const submitted = "/aliases/paper";
    const canonical = "/data/paper";
    const onSelect = vi.fn();
    vi.mocked(api.listDirectories).mockImplementation(async (path) => {
      if (path === HOME) return { path, entries: [] };
      if (path === submitted || path === canonical) return { path: canonical, entries: [] };
      throw new Error(`unexpected path ${path}`);
    });
    render(<DirectoryDialog homeDir={HOME} onSelect={onSelect} onClose={() => {}} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: submitted } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(input).toHaveValue(canonical));
    await userEvent.click(screen.getByRole("button", { name: /create session/i }));
    expect(onSelect).toHaveBeenCalledWith(canonical);
  });

  it("ignores an older navigation response that settles last", async () => {
    const first = deferred<{ path: string; entries: [] }>();
    const second = deferred<{ path: string; entries: [] }>();
    vi.mocked(api.listDirectories).mockImplementation(async (path) => {
      if (path === HOME || path === "/") return { path, entries: [] };
      if (path === "/first") return first.promise;
      if (path === "/second") return second.promise;
      throw new Error(`unexpected path ${path}`);
    });
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    const input = screen.getByRole("combobox", { name: /directory path/i });

    fireEvent.change(input, { target: { value: "/first" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "/second" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(() => second.resolve({ path: "/second", entries: [] }));
    await waitFor(() => expect(input).toHaveValue("/second"));
    await act(() => first.resolve({ path: "/first", entries: [] }));

    expect(input).toHaveValue("/second");
  });

  it("ignores stale path suggestions that settle after the current input", async () => {
    const first = deferred<{ path: string; entries: Array<{ name: string; path: string }> }>();
    const second = deferred<{ path: string; entries: Array<{ name: string; path: string }> }>();
    let suggestionRequest = 0;
    vi.mocked(api.listDirectories).mockImplementation(async (path) => {
      if (path === HOME) return { path, entries: [] };
      if (path === "/") return ++suggestionRequest === 1 ? first.promise : second.promise;
      throw new Error(`unexpected path ${path}`);
    });
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    const input = screen.getByRole("combobox", { name: /directory path/i });

    fireEvent.change(input, { target: { value: "/a" } });
    fireEvent.change(input, { target: { value: "/b" } });
    await act(() => second.resolve({ path: "/", entries: [{ name: "beta", path: "/beta" }] }));
    expect(await screen.findByRole("option", { name: /beta/i })).toBeVisible();
    await act(() => first.resolve({ path: "/", entries: [{ name: "alpha", path: "/alpha" }] }));

    expect(screen.queryByRole("option", { name: /alpha/i })).toBeNull();
    expect(screen.getByRole("option", { name: /beta/i })).toBeVisible();
  });

  it("does not select an old suggestion while the current query is pending", async () => {
    const current = deferred<{ path: string; entries: Array<{ name: string; path: string }> }>();
    let suggestionRequest = 0;
    vi.mocked(api.listDirectories).mockImplementation(async (path) => {
      if (path === HOME) return { path, entries: [] };
      if (path === "/") {
        suggestionRequest += 1;
        return suggestionRequest === 1 ? { path, entries: [{ name: "alpha", path: "/alpha" }] } : current.promise;
      }
      if (path === "/alpha" || path === "/beta") return { path, entries: [] };
      throw new Error(`unexpected path ${path}`);
    });
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={() => {}} />);
    const input = screen.getByRole("combobox", { name: /directory path/i });
    fireEvent.change(input, { target: { value: "/a" } });
    expect(await screen.findByRole("option", { name: /alpha/i })).toBeVisible();

    fireEvent.change(input, { target: { value: "/beta" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(api.listDirectories).toHaveBeenCalledWith("/beta"));
    expect(api.listDirectories).not.toHaveBeenCalledWith("/alpha");
  });

  it("does not reopen suggestions when a dismissed request settles", async () => {
    const current = deferred<{ path: string; entries: Array<{ name: string; path: string }> }>();
    let suggestionRequest = 0;
    vi.mocked(api.listDirectories).mockImplementation(async (path) => {
      if (path === HOME) return { path, entries: [] };
      if (path === "/") {
        suggestionRequest += 1;
        return suggestionRequest === 1 ? { path, entries: [{ name: "alpha", path: "/alpha" }] } : current.promise;
      }
      throw new Error(`unexpected path ${path}`);
    });
    const onClose = vi.fn();
    render(<DirectoryDialog homeDir={HOME} onSelect={() => {}} onClose={onClose} />);
    const input = screen.getByRole("combobox", { name: /directory path/i });
    fireEvent.change(input, { target: { value: "/a" } });
    expect(await screen.findByRole("option", { name: /alpha/i })).toBeVisible();

    fireEvent.change(input, { target: { value: "/b" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
    await act(() => current.resolve({ path: "/", entries: [{ name: "beta", path: "/beta" }] }));

    expect(screen.queryByRole("listbox")).toBeNull();
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

  it("switches to any server-reported Windows drive root", async () => {
    const home = String.raw`C:\Users\researcher`;
    const drive = "D:\\";
    vi.mocked(api.listDirectoryRoots).mockResolvedValue([
      { name: "C:\\", path: "C:\\" },
      { name: drive, path: drive },
    ]);
    vi.mocked(api.listDirectories).mockImplementation(async (path) => {
      if (path === home || path === drive) return { path, entries: [] };
      throw new Error(`unexpected path ${path}`);
    });
    const user = userEvent.setup();
    render(<DirectoryDialog homeDir={home} onSelect={() => {}} onClose={() => {}} />);

    const roots = await screen.findByRole("combobox", { name: "Root" });
    await user.selectOptions(roots, drive);

    await waitFor(() => expect(api.listDirectories).toHaveBeenCalledWith(drive));
    expect(screen.getByRole("combobox", { name: /directory path/i })).toHaveValue(drive);
  });

  it("treats a drive-absolute Windows input as independent from HOME", async () => {
    const home = String.raw`C:\Users\researcher`;
    const target = String.raw`D:\papers`;
    vi.mocked(api.listDirectories).mockImplementation(async (path) => {
      if (path === home || path === target) return { path, entries: [] };
      throw new Error(`unexpected path ${path}`);
    });
    const user = userEvent.setup();
    render(<DirectoryDialog homeDir={home} onSelect={() => {}} onClose={() => {}} />);
    const input = screen.getByRole("combobox");
    await user.clear(input);
    await user.type(input, target);
    await user.keyboard("{Enter}");

    await waitFor(() => expect(api.listDirectories).toHaveBeenCalledWith(target));
    expect(input).toHaveValue(target);
  });

  it("navigates directly to a typed UNC share", async () => {
    const home = String.raw`C:\Users\researcher`;
    const target = String.raw`\\server\share\paper`;
    vi.mocked(api.listDirectories).mockImplementation(async (path) => {
      if (path === home || path === target) return { path, entries: [] };
      throw new Error(`unexpected path ${path}`);
    });
    const user = userEvent.setup();
    render(<DirectoryDialog homeDir={home} onSelect={() => {}} onClose={() => {}} />);
    const input = screen.getByRole("combobox");
    await user.clear(input);
    await user.type(input, target);
    await user.keyboard("{Enter}");

    await waitFor(() => expect(api.listDirectories).toHaveBeenCalledWith(target));
  });

  it("moves to the native parent of a Windows directory", async () => {
    const home = String.raw`D:\papers\current`;
    const parent = String.raw`D:\papers`;
    vi.mocked(api.listDirectories).mockImplementation(async (path) => {
      if (path === home || path === parent || path === "/") return { path, entries: [] };
      throw new Error(`unexpected path ${path}`);
    });
    const user = userEvent.setup();
    render(<DirectoryDialog homeDir={home} onSelect={() => {}} onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: /parent/i }));

    await waitFor(() => expect(api.listDirectories).toHaveBeenCalledWith(parent));
  });

  it("creates nested project paths with the current Windows separator", async () => {
    const home = String.raw`D:\papers`;
    const created = String.raw`D:\papers\new folder\review`;
    vi.mocked(api.listDirectories).mockImplementation(async (path) => {
      if (path === home || path === created) return { path, entries: [] };
      throw new Error(`unexpected path ${path}`);
    });
    vi.mocked(api.createDirectory).mockResolvedValue({ path: created });
    const user = userEvent.setup();
    render(<DirectoryDialog homeDir={home} onSelect={() => {}} onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: /new project/i }));
    const createDialog = screen.getByRole("dialog", { name: "New project" });
    await user.type(createDialog.querySelector("input")!, "new folder/review");
    await user.click(within(createDialog).getByRole("button", { name: /create/i }));

    expect(api.createDirectory).toHaveBeenCalledWith(created);
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
