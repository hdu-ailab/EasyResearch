import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { ApiError } from "../api";
import { ConfigPage } from "./ConfigPage";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    listConfigProjects: vi.fn(),
    listConfig: vi.fn(),
    readConfigFile: vi.fn(),
    writeConfigFile: vi.fn(),
    createConfigDirectory: vi.fn(),
    refreshConfigurationResources: vi.fn(),
  };
});

function renderConfigPage(onProjectInterestChange: (cwd?: string) => void = () => {}) {
  const onHome = vi.fn();
  const onBackToSettings = vi.fn();
  const view = render(
    <ConfigPage
      onHome={onHome}
      onBackToSettings={onBackToSettings}
      onProjectInterestChange={onProjectInterestChange}
    />,
  );
  return { ...view, onHome, onBackToSettings };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ConfigPage", () => {
  beforeEach(() => {
    vi.mocked(api.listConfigProjects)
      .mockReset()
      .mockResolvedValue({
        home: "/home/u",
        projects: [{ cwd: "/home/u/proj" }, { cwd: "/tmp/other" }],
      });
    vi.mocked(api.listConfig)
      .mockReset()
      .mockResolvedValue([
        { name: "settings.json", path: "settings.json", type: "file" },
        { name: "notes.md", path: "notes.md", type: "file" },
        { name: "agents", path: "agents", type: "directory" },
      ]);
    vi.mocked(api.readConfigFile).mockReset().mockResolvedValue({ path: "notes.md", content: "# Notes\n" });
    vi.mocked(api.writeConfigFile).mockReset().mockResolvedValue();
    vi.mocked(api.createConfigDirectory).mockReset().mockResolvedValue();
    vi.mocked(api.refreshConfigurationResources).mockReset().mockResolvedValue({ generation: 1, error: null });
  });

  it("keeps Home separate from Back to Settings", async () => {
    const user = userEvent.setup();
    const { onHome, onBackToSettings } = renderConfigPage();

    await user.click(screen.getByRole("button", { name: /back to home/i }));

    expect(onHome).toHaveBeenCalledOnce();
    expect(onBackToSettings).not.toHaveBeenCalled();
  });

  it("returns to Settings without invoking Home", async () => {
    const user = userEvent.setup();
    const { onHome, onBackToSettings } = renderConfigPage();

    await user.click(screen.getByRole("button", { name: "Back to Settings" }));

    expect(onBackToSettings).toHaveBeenCalledOnce();
    expect(onHome).not.toHaveBeenCalled();
  });

  it("lists the global root before project roots", async () => {
    renderConfigPage();
    const list = await screen.findByRole("list", { name: /project folder/i });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent(/Global/);
    expect(items[0]).toHaveTextContent("/home/u");
    expect(items[1]).toHaveTextContent("/home/u/proj");
  });

  it("opens a project and reads a Markdown file without JSON parsing", async () => {
    const user = userEvent.setup();
    const { onHome, onBackToSettings } = renderConfigPage();
    await user.click(await screen.findByRole("button", { name: /\/home\/u\/proj/ }));
    await user.click(screen.getByRole("button", { name: "notes.md" }));
    expect(api.readConfigFile).toHaveBeenCalledWith("project", "/home/u/proj", "notes.md");

    vi.mocked(api.listConfig).mockResolvedValueOnce([{ name: "notes.md", path: "notes.md", type: "file" }]);
    await user.click(screen.getByRole("button", { name: /back to files/i }));
    expect(await screen.findByRole("list", { name: /project folder/i })).toBeVisible();
    expect(onHome).not.toHaveBeenCalled();
    expect(onBackToSettings).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /\/home\/u\/proj/ }));
    await user.click(screen.getByRole("button", { name: "notes.md" }));
    expect(await screen.findByRole("textbox", { name: /editor/i })).toHaveValue("# Notes\n");
  });

  it("contributes only the selected exact project and clears it on scope reset and unmount", async () => {
    const user = userEvent.setup();
    const onProjectInterestChange = vi.fn();
    const view = renderConfigPage(onProjectInterestChange);

    await user.click(await screen.findByRole("button", { name: /\/home\/u\/proj/ }));
    expect(onProjectInterestChange).toHaveBeenLastCalledWith("/home/u/proj");

    await user.click(screen.getByRole("button", { name: /back to files/i }));
    expect(onProjectInterestChange).toHaveBeenLastCalledWith(undefined);

    await user.click(screen.getByRole("button", { name: /\/tmp\/other/ }));
    expect(onProjectInterestChange).toHaveBeenLastCalledWith("/tmp/other");
    view.unmount();
    expect(onProjectInterestChange).toHaveBeenLastCalledWith(undefined);
  });

  it("saves Markdown verbatim", async () => {
    const user = userEvent.setup();
    renderConfigPage();
    await user.click(await screen.findByRole("button", { name: /\/home\/u\/proj/ }));
    await user.click(screen.getByRole("button", { name: "notes.md" }));
    const editor = await screen.findByRole("textbox", { name: /editor/i });
    fireEvent.change(editor, { target: { value: "---\nname: reviewer\n---\n# Draft\n" } });
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(api.writeConfigFile).toHaveBeenCalledWith(
      "project",
      "/home/u/proj",
      "notes.md",
      "---\nname: reviewer\n---\n# Draft\n",
    );
  });

  it.each(["agents/search.md", "models.json"])("marks global %s saves as live", async (path) => {
    const user = userEvent.setup();
    vi.mocked(api.listConfig).mockResolvedValueOnce([{ name: path.split("/").at(-1)!, path, type: "file" }]);
    vi.mocked(api.readConfigFile).mockResolvedValueOnce({
      path,
      content: path.endsWith(".json") ? "{}\n" : "# Agent\n",
    });
    renderConfigPage();
    await user.click(await screen.findByRole("button", { name: /Global/ }));
    await user.click(screen.getByRole("button", { name: path.split("/").at(-1)! }));
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByText(/appl.*automatically/i)).toBeVisible();
    expect(screen.queryByText(/restart/i)).toBeNull();
  });

  it.each([
    ["global", /Global/, "skills/root-skill.md"],
    ["global", /Global/, "skills/namespace/deep/SKILL.md"],
    ["project", /\/home\/u\/proj/, "skills/root-skill.md"],
    ["project", /\/home\/u\/proj/, "skills/namespace/deep/SKILL.md"],
  ] as const)("marks %s Skill descriptor %s saves as live", async (_scope, rootName, path) => {
    const user = userEvent.setup();
    vi.mocked(api.listConfig).mockResolvedValueOnce([{ name: path.split("/").at(-1)!, path, type: "file" }]);
    vi.mocked(api.readConfigFile).mockResolvedValueOnce({ path, content: "# Skill\n" });
    renderConfigPage();
    await user.click(await screen.findByRole("button", { name: rootName }));
    await user.click(screen.getByRole("button", { name: path.split("/").at(-1)! }));
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByText(/appl.*automatically/i)).toBeVisible();
    expect(screen.queryByText(/restart/i)).toBeNull();
  });

  it.each([
    ["global Agent", /Global/, String.raw`agents\search.md`, "search.md"],
    ["global direct Skill", /Global/, String.raw`skills\root-skill.md`, "root-skill.md"],
    ["project nested Skill", /\/home\/u\/proj/, String.raw`skills\namespace\deep\SKILL.md`, "SKILL.md"],
  ] as const)("marks a Windows-native %s descriptor save as live", async (_kind, rootName, path, name) => {
    const user = userEvent.setup();
    vi.mocked(api.listConfig).mockResolvedValueOnce([{ name, path, type: "file" }]);
    vi.mocked(api.readConfigFile).mockResolvedValueOnce({ path, content: "# Descriptor\n" });
    renderConfigPage();
    await user.click(await screen.findByRole("button", { name: rootName }));
    await user.click(screen.getByRole("button", { name }));
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByText(/appl.*automatically/i)).toBeVisible();
    expect(screen.queryByText(/restart/i)).toBeNull();
  });

  it("keeps a Windows-native project Agent save neutral", async () => {
    const user = userEvent.setup();
    const path = String.raw`agents\search.md`;
    vi.mocked(api.listConfig).mockResolvedValueOnce([{ name: "search.md", path, type: "file" }]);
    vi.mocked(api.readConfigFile).mockResolvedValueOnce({ path, content: "# Inert project Agent\n" });
    renderConfigPage();
    await user.click(await screen.findByRole("button", { name: /\/home\/u\/proj/ }));
    await user.click(screen.getByRole("button", { name: "search.md" }));
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByText(/^Saved\.$/)).toBeVisible();
    expect(screen.queryByText(/restart|automatically/i)).toBeNull();
  });

  it("keeps Windows-native nested auxiliary Skill Markdown restart-bound", async () => {
    const user = userEvent.setup();
    const path = String.raw`skills\reviewer\README.md`;
    vi.mocked(api.listConfig).mockResolvedValueOnce([{ name: "README.md", path, type: "file" }]);
    vi.mocked(api.readConfigFile).mockResolvedValueOnce({ path, content: "# Notes\n" });
    renderConfigPage();
    await user.click(await screen.findByRole("button", { name: /Global/ }));
    await user.click(screen.getByRole("button", { name: "README.md" }));
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByText(/restart/i)).toBeVisible();
    expect(screen.queryByText(/automatically/i)).toBeNull();
  });

  it("does not claim that a project Agent save is live or restart-bound", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listConfig).mockResolvedValueOnce([{ name: "search.md", path: "agents/search.md", type: "file" }]);
    vi.mocked(api.readConfigFile).mockResolvedValueOnce({
      path: "agents/search.md",
      content: "# Inert project file\n",
    });
    renderConfigPage();
    await user.click(await screen.findByRole("button", { name: /\/home\/u\/proj/ }));
    await user.click(screen.getByRole("button", { name: "search.md" }));
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByText(/^Saved\.$/)).toBeVisible();
    expect(screen.queryByText(/restart|automatically/i)).toBeNull();
  });

  it("does not claim that an auxiliary Skill file is live", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listConfig).mockResolvedValueOnce([
      { name: "README.md", path: "skills/reviewer/README.md", type: "file" },
    ]);
    vi.mocked(api.readConfigFile).mockResolvedValueOnce({
      path: "skills/reviewer/README.md",
      content: "# Notes\n",
    });
    renderConfigPage();
    await user.click(await screen.findByRole("button", { name: /Global/ }));
    await user.click(screen.getByRole("button", { name: "README.md" }));
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByText(/restart/i)).toBeVisible();
    expect(screen.queryByText(/automatically/i)).toBeNull();
  });

  it("awaits selected-project synchronization before Refresh and preserves a safe refresh error", async () => {
    const user = userEvent.setup();
    const synchronization = deferred<Awaited<ReturnType<typeof api.refreshConfigurationResources>>>();
    vi.mocked(api.refreshConfigurationResources).mockReturnValue(synchronization.promise);
    renderConfigPage();
    await user.click(await screen.findByRole("button", { name: /\/home\/u\/proj/ }));
    const listCalls = vi.mocked(api.listConfig).mock.calls.length;
    vi.mocked(api.listConfig).mockResolvedValueOnce([
      { name: "fresh-skill.md", path: "skills/fresh-skill.md", type: "file" },
    ]);

    await user.click(screen.getByRole("button", { name: "Refresh listing" }));

    expect(api.refreshConfigurationResources).toHaveBeenCalledWith({ projectCwds: ["/home/u/proj"] });
    expect(api.listConfig).toHaveBeenCalledTimes(listCalls);
    expect(screen.queryByRole("button", { name: "fresh-skill.md" })).toBeNull();

    await act(async () => {
      synchronization.resolve({ generation: 2, error: "Configuration refresh failed. Retry refresh." });
      await synchronization.promise;
    });
    expect(await screen.findByRole("button", { name: "fresh-skill.md" })).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Configuration refresh failed. Retry refresh."),
    );
  });

  it("opening a file invalidates a pending listing Refresh and preserves the current file-read error", async () => {
    const user = userEvent.setup();
    const synchronization = deferred<Awaited<ReturnType<typeof api.refreshConfigurationResources>>>();
    vi.mocked(api.refreshConfigurationResources).mockReturnValue(synchronization.promise);
    vi.mocked(api.readConfigFile).mockRejectedValueOnce(new Error("current file read failed"));
    renderConfigPage();
    await user.click(await screen.findByRole("button", { name: /\/home\/u\/proj/ }));
    const listCalls = vi.mocked(api.listConfig).mock.calls.length;
    vi.mocked(api.listConfig).mockResolvedValueOnce([{ name: "stale.md", path: "stale.md", type: "file" }]);

    await user.click(screen.getByRole("button", { name: "Refresh listing" }));
    await user.click(screen.getByRole("button", { name: "notes.md" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("current file read failed");

    await act(async () => {
      synchronization.resolve({ generation: 2, error: "stale listing refresh" });
      await synchronization.promise;
      await Promise.resolve();
    });

    expect(screen.getByRole("alert")).toHaveTextContent("current file read failed");
    expect(screen.queryByText("stale listing refresh")).toBeNull();
    expect(screen.getByRole("button", { name: "notes.md" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "stale.md" })).toBeNull();
    expect(api.listConfig).toHaveBeenCalledTimes(listCalls);
  });

  it("keeps restart guidance for ordinary configuration saves", async () => {
    const user = userEvent.setup();
    vi.mocked(api.readConfigFile).mockResolvedValueOnce({ path: "settings.json", content: "{}\n" });
    renderConfigPage();
    await user.click(await screen.findByRole("button", { name: /Global/ }));
    await user.click(screen.getByRole("button", { name: "settings.json" }));
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByText(/restart/i)).toBeVisible();
  });

  it("rejects malformed JSON while allowing other text", async () => {
    const user = userEvent.setup();
    vi.mocked(api.readConfigFile).mockResolvedValue({ path: "settings.json", content: "{\n" });
    renderConfigPage();
    await user.click(await screen.findByRole("button", { name: /\/home\/u\/proj/ }));
    await user.click(screen.getByRole("button", { name: "settings.json" }));
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid json/i);
    expect(api.writeConfigFile).not.toHaveBeenCalled();
  });

  it("creates a directory under the current config path", async () => {
    const user = userEvent.setup();
    renderConfigPage();
    await user.click(await screen.findByRole("button", { name: /\/home\/u\/proj/ }));
    await user.click(screen.getByTitle("New folder"));
    const dialog = screen.getByRole("dialog", { name: "New folder" });
    const input = within(dialog).getByRole("textbox", { name: "New folder" });
    expect(input).toHaveFocus();
    await user.type(input, "skills/reviewer");
    await user.click(within(dialog).getByRole("button", { name: /confirm/i }));
    expect(api.createConfigDirectory).toHaveBeenCalledWith("project", "/home/u/proj", "skills/reviewer");
  });

  it("keeps the editor error visible when a file read fails", async () => {
    const user = userEvent.setup();
    vi.mocked(api.readConfigFile).mockRejectedValueOnce(new ApiError(500, { error: "boom" }));
    renderConfigPage();
    await user.click(await screen.findByRole("button", { name: /\/home\/u\/proj/ }));
    await user.click(screen.getByRole("button", { name: "settings.json" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});
