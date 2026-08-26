import { act, fireEvent, render as renderWithTestingLibrary, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../../../package.json";
import { App } from "./App";
import * as api from "./api";
import { I18nProvider } from "./i18n/I18nProvider";
import { PreferencesProvider } from "./preferences/PreferencesProvider";
import { hydrateTranscript } from "./testing/transcriptTest";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    listStatus: vi.fn(),
    checkForUpdate: vi.fn(),
    openSession: vi.fn(),
    createSession: vi.fn(),
    stopSession: vi.fn(),
    touchSession: vi.fn(),
    getSnapshot: vi.fn(),
    getChildSnapshot: vi.fn(),
    connectSessionEvents: vi.fn(),
    sendPrompt: vi.fn(),
    abortSession: vi.fn(),
    getSessionCommands: vi.fn().mockResolvedValue([]),
    getSessionTree: vi.fn().mockResolvedValue({ tree: [], leafId: null }),
    navigateSessionTree: vi.fn().mockResolvedValue(undefined),
    listEntries: vi.fn().mockResolvedValue([]),
    readFileContent: vi.fn(),
    listConfig: vi.fn().mockResolvedValue([]),
    listConfigProjects: vi.fn().mockResolvedValue({ home: "/tmp", projects: [] }),
    readConfigFile: vi.fn(),
    writeConfigFile: vi.fn(),
    createConfigDirectory: vi.fn(),
    connectConfigurationEvents: vi.fn(),
    listAgentResources: vi.fn().mockResolvedValue([]),
    listAgents: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue([]),
    listSkillResources: vi.fn().mockResolvedValue([]),
    readAgentResource: vi.fn(),
    writeAgentResource: vi.fn(),
    createAgentResource: vi.fn(),
    readSkillResource: vi.fn(),
    writeSkillResource: vi.fn(),
    listAuthProviders: vi.fn().mockResolvedValue([]),
  };
});

const workSnapshot = {
  session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready", sessionFile: "/store/s1.jsonl" },
  messages: [
    { role: "user", content: [{ type: "text", text: "write a paper" }] },
    { role: "assistant", content: [{ type: "text", text: "starting research" }] },
  ],
} as never;

const persisted = {
  agentDir: "/tmp/agent",
  homeDir: "/tmp",
  sessions: [
    {
      id: "s1",
      path: "/store/s1.jsonl",
      cwd: "/p",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      messageCount: 2,
      firstMessage: "write a paper",
    },
  ],
  activeSessions: [],
};

let unsubscribeFn: ReturnType<typeof vi.fn>;
let disconnectConfiguration: () => void;
let configurationHandlers: Parameters<typeof api.connectConfigurationEvents>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function stubEvents() {
  unsubscribeFn = vi.fn();
  vi.mocked(api.connectSessionEvents).mockImplementation((_id, _handlers) => unsubscribeFn as unknown as () => void);
}

function render(ui: ReactElement) {
  const result = renderWithTestingLibrary(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <PreferencesProvider>
        <I18nProvider>{children}</I18nProvider>
      </PreferencesProvider>
    ),
  });
  hydrateTranscript(result.container);
  return result;
}

const workspace = () => screen.getByRole("region", { name: /research workspace/i });

/**
 * Renders the app, waits for the Work page chat tabpanel, then retries
 * transcript hydration until the virtualized rows render. The async route
 * resolve mounts WorkPage after the initial render, so the transcript's
 * ResizeObserver may not be registered yet when the tabpanel first appears.
 */
async function renderWork() {
  const result = render(<App />);
  await screen.findByRole("tabpanel", { name: /^chat$/i });
  await waitFor(() => {
    hydrateTranscript(result.container);
    expect(screen.queryByText("starting research")).toBeTruthy();
  });
  return result;
}

function simulateBrowserBackTo(hash: string): void {
  act(() => {
    window.history.replaceState(null, "", hash);
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  });
}

describe("App routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "#/");
  });

  beforeEach(() => {
    window.history.replaceState(null, "", "#/");
    vi.mocked(api.listStatus).mockReset();
    vi.mocked(api.checkForUpdate).mockReset().mockResolvedValue({ latestVersion: null });
    vi.mocked(api.openSession).mockReset();
    vi.mocked(api.getSnapshot).mockReset();
    vi.mocked(api.connectSessionEvents).mockReset();
    vi.mocked(api.connectConfigurationEvents).mockReset();
    vi.mocked(api.listAgents).mockReset().mockResolvedValue([]);
    vi.mocked(api.listModels).mockReset().mockResolvedValue([]);
    vi.mocked(api.listAgentResources).mockReset().mockResolvedValue([]);
    vi.mocked(api.readAgentResource).mockReset();
    vi.mocked(api.listStatus).mockResolvedValue({
      agentDir: "/tmp/agent",
      homeDir: "/tmp",
      sessions: [],
      activeSessions: [],
    });
    vi.mocked(api.openSession).mockResolvedValue({
      id: "s1",
      cwd: "/p",
      isStreaming: false,
      status: "ready",
      sessionFile: "/store/s1.jsonl",
    });
    vi.mocked(api.getSnapshot).mockResolvedValue(workSnapshot);
    disconnectConfiguration = vi.fn();
    vi.mocked(api.connectConfigurationEvents).mockImplementation((handlers) => {
      configurationHandlers = handlers;
      return disconnectConfiguration;
    });
    stubEvents();
  });

  it("renders Home on an empty hash", async () => {
    render(<App />);
    expect(await screen.findByRole("region", { name: /research workspace/i })).toBeTruthy();
  });

  it("keeps the Home version and context mounted behind Settings", async () => {
    const user = userEvent.setup();
    render(<App />);
    await workspace();
    const version = `v${packageJson.version}`;
    const versionNode = screen.getByText(version);
    expect(versionNode).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(versionNode).toBeInTheDocument();
    const baseSurface = versionNode.closest("[data-app-surface]");
    expect(baseSurface).not.toBeNull();
    expect(baseSurface!).toHaveAttribute("inert");
    expect(baseSurface!).toHaveAttribute("aria-hidden", "true");
  });

  it("shows a non-interactive update notice in the Home topbar", async () => {
    vi.mocked(api.checkForUpdate).mockResolvedValue({ latestVersion: "0.0.62" });
    render(<App />);
    await workspace();

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("New version available v0.0.62");
    expect(notice.querySelector("a, button")).toBeNull();
    expect(screen.queryByText(/npm install/i)).toBeNull();
  });

  it("falls back to Home for unknown hashes", async () => {
    window.location.hash = "#/bogus";
    render(<App />);
    expect(await screen.findByRole("region", { name: /research workspace/i })).toBeTruthy();
  });

  it("opens Settings over Home with the canonical marked overlay route", async () => {
    const user = userEvent.setup();
    render(<App />);
    await workspace();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(window.location.hash).toBe("#/?settings=1");
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "General" })).toHaveFocus();
  });

  it("owns one configuration EventSource across page navigation and closes it on unmount", async () => {
    const user = userEvent.setup();
    const view = render(<App />);
    await workspace();
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog", { name: "Settings" });
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();

    view.unmount();
    expect(disconnectConfiguration).toHaveBeenCalledOnce();
  });

  it("forwards one accepted configuration generation to open Settings and the mounted Work surface", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listAgents).mockResolvedValue([
      {
        name: "search",
        description: "Initial Agent",
        enabled: true,
        builtin: false,
        source: "global",
        filePath: "/agent/agents/search.md",
        effectiveTools: [],
        effectiveSkills: [],
        missingSkills: [],
      },
    ]);
    vi.mocked(api.listStatus).mockResolvedValue(persisted);
    window.location.hash = "#/work/s1?cwd=%2Fp";
    await renderWork();
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();
    expect(api.connectSessionEvents).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Agents" }));
    expect(await screen.findByRole("button", { name: "Configure Search" })).toBeVisible();
    vi.mocked(api.listAgents).mockResolvedValue([
      {
        name: "reviewer",
        description: "Updated Agent",
        enabled: true,
        builtin: false,
        source: "global",
        filePath: "/agent/agents/reviewer.md",
        effectiveTools: [],
        effectiveSkills: [],
        missingSkills: [],
      },
    ]);

    act(() =>
      configurationHandlers.onEvent({
        type: "config.updated",
        generation: 2,
        agentsChanged: true,
        modelsChanged: false,
      }),
    );

    expect(await screen.findByRole("button", { name: "Configure reviewer" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Configure Search" })).toBeNull();
    await waitFor(() => expect(screen.getAllByText("Updated Agent")).toHaveLength(2));
    const workSessionContent = screen.getByText("starting research");
    expect(workSessionContent).toBeInTheDocument();
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();
    expect(api.connectSessionEvents).toHaveBeenCalledOnce();
  });

  it("restores a work route by opening the persisted session on refresh", async () => {
    vi.mocked(api.listStatus).mockResolvedValue(persisted);
    window.location.hash = "#/work/s1?cwd=%2Fp";
    await renderWork();

    expect(await screen.findByText("starting research")).toBeTruthy();
    expect(vi.mocked(api.openSession)).toHaveBeenCalledWith("/store/s1.jsonl");
    expect(vi.mocked(api.getSnapshot)).toHaveBeenCalledWith("s1");
  });

  it("mounts an unpersisted work session directly from the URL identity", async () => {
    window.location.hash = "#/work/fresh-1?cwd=%2Fp";
    await renderWork();

    expect(await screen.findByText("starting research")).toBeTruthy();
    expect(api.openSession).not.toHaveBeenCalled();
    expect(vi.mocked(api.getSnapshot)).toHaveBeenCalledWith("fresh-1");
  });

  it("opens Settings over Work without resolving, remounting, or disconnecting Work", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listStatus).mockResolvedValue(persisted);
    window.location.hash = "#/work/s1?cwd=%2Fp";
    await renderWork();
    const workSessionContent = await screen.findByText("starting research");
    expect(api.getSnapshot).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(window.location.hash).toBe("#/work/s1?cwd=%2Fp&settings=1");
    expect(api.getSnapshot).toHaveBeenCalledTimes(1);
    expect(unsubscribeFn).not.toHaveBeenCalled();
    expect(workSessionContent).toBeInTheDocument();
    const baseSurface = workSessionContent.closest("[data-app-surface]");
    expect(baseSurface).not.toBeNull();
    expect(baseSurface!).toHaveAttribute("inert");
    expect(baseSurface!).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
  });

  it("round-trips Home through Config using the matching marked Settings history entry", async () => {
    const user = userEvent.setup();
    render(<App />);
    await workspace();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: /open config browser/i }));

    expect(window.location.hash).toBe("#/config?returnTo=%23%2F%3Fsettings%3D1");
    expect(await screen.findByText("Config browser")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Back to Settings" }));

    await waitFor(() => expect(window.location.hash).toBe("#/?settings=1"));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(window.history.state.easyresearchNavigation).toEqual({ kind: "settings", baseHash: "#/" });
  });

  it("keeps an invalid direct Config route mounted until it synthesizes Home Settings on request", async () => {
    const user = userEvent.setup();
    const invalidConfigHash = "#/config?returnTo=%23%2Fsettings";
    window.history.replaceState({ preserved: "yes" }, "", invalidConfigHash);
    render(<App />);

    expect(await screen.findByText("Config browser")).toBeVisible();
    expect(window.location.hash).toBe(invalidConfigHash);
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Back to Settings" }));

    expect(window.location.hash).toBe("#/?settings=1");
    expect(window.history.state).toEqual({
      preserved: "yes",
      easyresearchNavigation: { kind: "settings", baseHash: "#/" },
    });
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    expect(screen.queryByText("Config browser")).toBeNull();
  });

  it("round-trips Work through Config without reopening or reconnecting the session", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listStatus).mockResolvedValue(persisted);
    window.location.hash = "#/work/s1?cwd=%2Fp";
    await renderWork();
    const workSessionContent = screen.getByText("starting research");

    expect(api.openSession).toHaveBeenCalledOnce();
    expect(api.getSnapshot).toHaveBeenCalledOnce();
    expect(api.connectSessionEvents).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: /open config browser/i }));

    expect(window.location.hash).toBe("#/config?returnTo=%23%2Fwork%2Fs1%3Fcwd%3D%252Fp%26settings%3D1");
    expect(await screen.findByText("Config browser")).toBeVisible();
    expect(workSessionContent).toBeInTheDocument();
    expect(workSessionContent).not.toBeVisible();
    expect(unsubscribeFn).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Back to Settings" }));

    await waitFor(() => expect(window.location.hash).toBe("#/work/s1?cwd=%2Fp&settings=1"));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(screen.getByText("starting research")).toBe(workSessionContent);
    expect(api.openSession).toHaveBeenCalledOnce();
    expect(api.getSnapshot).toHaveBeenCalledOnce();
    expect(api.connectSessionEvents).toHaveBeenCalledOnce();
    expect(unsubscribeFn).not.toHaveBeenCalled();
  });

  it("restores Settings and routes browser Back through the dirty nested Markdown editor", async () => {
    const user = userEvent.setup();
    const confirmDiscard = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.mocked(api.listAgents).mockResolvedValue([
      {
        name: "search",
        description: "Searches",
        enabled: true,
        builtin: true,
        source: "global",
        filePath: "/agent/agents/search.md",
        effectiveTools: ["read"],
        effectiveSkills: ["paper-search"],
        missingSkills: [],
      },
    ]);
    vi.mocked(api.readAgentResource).mockResolvedValue({
      name: "search",
      description: "Searches",
      enabled: true,
      builtin: true,
      source: "global",
      filePath: "/agent/agents/search.md",
      effectiveTools: ["read"],
      effectiveSkills: ["paper-search"],
      missingSkills: [],
      content: "---\nname: search\n---\nPrompt\n",
    });
    vi.mocked(api.listStatus).mockResolvedValue(persisted);
    window.location.hash = "#/work/s1?cwd=%2Fp";
    await renderWork();
    const workSessionContent = screen.getByText("starting research");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Agents" }));
    await user.click(await screen.findByRole("button", { name: "Configure Search" }));
    await user.click(screen.getByRole("button", { name: "Edit Search" }));
    const editor = await screen.findByRole("textbox", { name: /agent markdown/i });
    fireEvent.change(editor, { target: { value: "---\nname: search\n---\nChanged prompt\n" } });

    simulateBrowserBackTo("#/work/s1?cwd=%2Fp");

    await waitFor(() => expect(confirmDiscard).toHaveBeenCalledOnce());
    expect(window.location.hash).toBe("#/work/s1?cwd=%2Fp&settings=1");
    expect(editor).toBeVisible();
    expect(workSessionContent).toBeInTheDocument();
    expect(unsubscribeFn).not.toHaveBeenCalled();

    confirmDiscard.mockReturnValue(true);
    simulateBrowserBackTo("#/work/s1?cwd=%2Fp");

    await waitFor(() => expect(screen.queryByRole("textbox", { name: /agent markdown/i })).toBeNull());
    expect(window.location.hash).toBe("#/work/s1?cwd=%2Fp&settings=1");
    expect(screen.getByRole("dialog", { name: "Agents" })).toBeVisible();
    expect(document.querySelector('[role="dialog"][aria-labelledby="settings-dialog-title"]')).toBeInTheDocument();
    expect(screen.getByText("starting research")).toBe(workSessionContent);
    expect(api.connectSessionEvents).toHaveBeenCalledOnce();
    expect(unsubscribeFn).not.toHaveBeenCalled();
  });

  it("restores Settings before dirty-editor Forward and retains the Config entry", async () => {
    const user = userEvent.setup();
    const confirmDiscard = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.mocked(api.listAgents).mockResolvedValue([
      {
        name: "search",
        description: "Searches",
        enabled: true,
        builtin: true,
        source: "global",
        filePath: "/agent/agents/search.md",
        effectiveTools: ["read"],
        effectiveSkills: ["paper-search"],
        missingSkills: [],
      },
    ]);
    vi.mocked(api.readAgentResource).mockResolvedValue({
      name: "search",
      description: "Searches",
      enabled: true,
      builtin: true,
      source: "global",
      filePath: "/agent/agents/search.md",
      effectiveTools: ["read"],
      effectiveSkills: ["paper-search"],
      missingSkills: [],
      content: "---\nname: search\n---\nPrompt\n",
    });
    render(<App />);
    await workspace();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: /open config browser/i }));
    await user.click(await screen.findByRole("button", { name: "Back to Settings" }));
    const settingsDialog = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(screen.getByRole("tab", { name: "Agents" }));
    await user.click(await screen.findByRole("button", { name: "Configure Search" }));
    await user.click(screen.getByRole("button", { name: "Edit Search" }));
    const editor = await screen.findByRole("textbox", { name: /agent markdown/i });
    fireEvent.change(editor, { target: { value: "---\nname: search\n---\nChanged prompt\n" } });

    act(() => window.history.forward());

    await waitFor(() => expect(confirmDiscard).toHaveBeenCalledOnce());
    expect(window.location.hash).toBe("#/?settings=1");
    expect(document.querySelector('[role="dialog"][aria-labelledby="settings-dialog-title"]')).toBe(settingsDialog);
    expect(editor).toBeVisible();
    expect(screen.queryByText("Config browser")).toBeNull();

    confirmDiscard.mockReturnValue(true);
    act(() => window.history.forward());

    await waitFor(() => expect(screen.queryByRole("textbox", { name: /agent markdown/i })).toBeNull());
    expect(window.location.hash).toBe("#/?settings=1");
    expect(document.querySelector('[role="dialog"][aria-labelledby="settings-dialog-title"]')).toBe(settingsDialog);
    expect(screen.getByRole("dialog", { name: "Agents" })).toBeVisible();

    await user.keyboard("{Escape}");
    act(() => window.history.forward());

    expect(await screen.findByText("Config browser")).toBeVisible();
    expect(window.location.hash).toBe("#/config?returnTo=%23%2F%3Fsettings%3D1");
    await user.click(screen.getByRole("button", { name: "Back to Settings" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeVisible();
  });

  it("hydrates a direct Home Settings URL and focuses the fallback gear after close", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "#/?settings=1");
    render(<App />);

    const general = await screen.findByRole("tab", { name: "General" });
    expect(general).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(window.location.hash).toBe("#/"));
    expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();
    expect(workspace()).toBeVisible();
  });

  it("waits for direct Work resolution before mounting Settings and focuses the Work gear after close", async () => {
    const user = userEvent.setup();
    const status = deferred<typeof persisted>();
    vi.mocked(api.listStatus).mockReturnValue(status.promise);
    window.history.replaceState(null, "", "#/work/s1?cwd=%2Fp&settings=1");
    const result = render(<App />);

    expect(screen.getByText("Loading session…")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();

    await act(async () => {
      status.resolve(persisted);
      await status.promise;
    });
    const general = await screen.findByRole("tab", { name: "General" });
    expect(general).toHaveFocus();
    await waitFor(() => {
      hydrateTranscript(result.container);
      expect(screen.queryByText("starting research")).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(window.location.hash).toBe("#/work/s1?cwd=%2Fp"));
    expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();
    expect(api.getSnapshot).toHaveBeenCalledTimes(1);
    expect(unsubscribeFn).not.toHaveBeenCalled();
  });

  it("navigates back Home from the Work page", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listStatus).mockResolvedValue(persisted);
    window.location.hash = "#/work/s1?cwd=%2Fp";
    await renderWork();
    await screen.findByText("starting research");

    await user.click(screen.getByRole("button", { name: /back to home/i }));
    expect(window.location.hash).toBe("#/");
    expect(workspace()).toBeTruthy();
  });

  it("follows hashchange navigation like a restored refresh", async () => {
    vi.mocked(api.listStatus).mockResolvedValue(persisted);
    const result = render(<App />);
    await workspace();

    window.location.hash = "#/work/s1?cwd=%2Fp";
    fireEvent(window, new HashChangeEvent("hashchange"));
    await screen.findByRole("tabpanel", { name: /^chat$/i });
    await waitFor(() => {
      hydrateTranscript(result.container);
      expect(screen.queryByText("starting research")).toBeTruthy();
    });
    expect(vi.mocked(api.openSession)).toHaveBeenCalledWith("/store/s1.jsonl");
  });

  it("shows a persisted-session open error with a route back to Home", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/work/s1?cwd=%2Fp";
    vi.mocked(api.listStatus).mockResolvedValue(persisted);
    vi.mocked(api.openSession).mockRejectedValue(new Error("not a directory: /missing"));
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("not a directory: /missing");
    await user.click(screen.getByRole("button", { name: /back to home/i }));
    expect(await workspace()).toBeVisible();
  });
});
