import { act, fireEvent, render as renderWithTestingLibrary, screen, waitFor, within } from "@testing-library/react";
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
    getApiUsageSettings: vi.fn(),
    getNetworkProxySettings: vi.fn(),
    patchNetworkProxySettings: vi.fn(),
    testNetworkProxy: vi.fn(),
    restartRuntime: vi.fn(),
    listEntries: vi.fn().mockResolvedValue([]),
    readFileContent: vi.fn(),
    listConfig: vi.fn().mockResolvedValue([]),
    listConfigProjects: vi.fn().mockResolvedValue({ home: "/tmp", projects: [] }),
    readConfigFile: vi.fn(),
    writeConfigFile: vi.fn(),
    createConfigDirectory: vi.fn(),
    connectConfigurationEvents: vi.fn(),
    replaceConfigurationProjectWatches: vi.fn(),
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
    refreshConfigurationResources: vi.fn(),
  };
});

const workSnapshot = {
  session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready", sessionFile: "/store/s1.jsonl" },
  timeline: [
    {
      kind: "message",
      entryId: "user-1",
      message: { role: "user", content: [{ type: "text", text: "write a paper" }] },
    },
    {
      kind: "message",
      entryId: "assistant-1",
      message: { role: "assistant", content: [{ type: "text", text: "starting research" }] },
    },
  ],
} as never;

const persisted = {
  bootId: "boot-a",
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

type ReplaceConfigurationProjectWatches = (
  leaseId: string,
  request: { revision: number; cwds: string[] },
) => Promise<{ applied: boolean; revision: number }>;

const configurationApi = api as typeof api & {
  replaceConfigurationProjectWatches: ReplaceConfigurationProjectWatches;
};

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
async function renderWork(app: ReactElement = <App />) {
  const result = render(app);
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
    delete window.easyresearchDesktop;
    window.history.replaceState(null, "", "#/");
  });

  beforeEach(() => {
    window.history.replaceState(null, "", "#/");
    vi.mocked(api.listStatus).mockReset();
    vi.mocked(api.checkForUpdate).mockReset().mockResolvedValue({ latestVersion: null });
    vi.mocked(api.openSession).mockReset();
    vi.mocked(api.getSnapshot).mockReset();
    vi.mocked(api.getApiUsageSettings).mockReset().mockResolvedValue({ showApiUsageDetails: false });
    vi.mocked(api.getNetworkProxySettings)
      .mockReset()
      .mockResolvedValue({
        configured: {},
        appliedConfigured: {},
        sources: { all: "direct", llm: "direct", search: "direct" },
        errors: [],
        restartRequired: false,
      });
    vi.mocked(api.patchNetworkProxySettings).mockReset();
    vi.mocked(api.testNetworkProxy).mockReset();
    vi.mocked(api.restartRuntime).mockReset();
    vi.mocked(api.connectSessionEvents).mockReset();
    vi.mocked(api.connectConfigurationEvents).mockReset();
    vi.mocked(configurationApi.replaceConfigurationProjectWatches)
      .mockReset()
      .mockImplementation((_leaseId, request) => Promise.resolve({ applied: true, revision: request.revision }));
    vi.mocked(api.listAgents).mockReset().mockResolvedValue([]);
    vi.mocked(api.listModels).mockReset().mockResolvedValue([]);
    vi.mocked(api.listAgentResources).mockReset().mockResolvedValue([]);
    vi.mocked(api.listConfigProjects).mockReset().mockResolvedValue({ home: "/tmp", projects: [] });
    vi.mocked(api.listSkillResources).mockReset().mockResolvedValue([]);
    vi.mocked(api.readAgentResource).mockReset();
    vi.mocked(api.refreshConfigurationResources).mockReset().mockResolvedValue({ generation: 0, error: null });
    vi.mocked(api.listStatus).mockResolvedValue({
      bootId: "boot-a",
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

  it("restores browser Back to Settings until a dirty Network draft is discarded", async () => {
    const user = userEvent.setup();
    render(<App />);
    await workspace();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Network" }));
    const draft = await screen.findByRole("textbox", { name: "All traffic proxy" });
    await user.type(draft, "http://draft.example");

    simulateBrowserBackTo("#/");

    expect(await screen.findByRole("dialog", { name: "Discard network changes?" })).toBeVisible();
    expect(window.location.hash).toBe("#/?settings=1");
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(draft).toHaveValue("http://draft.example");
    expect(screen.getByRole("tab", { name: "Network" })).toHaveAttribute("aria-selected", "true");

    simulateBrowserBackTo("#/");
    await user.click(await screen.findByRole("button", { name: "Discard changes" }));

    await waitFor(() => expect(window.location.hash).toBe("#/"));
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it("owns one configuration EventSource across page navigation and closes it on unmount", async () => {
    const user = userEvent.setup();
    const view = render(<App />);
    await workspace();
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();

    act(() =>
      configurationHandlers.onEvent({
        type: "config.updated",
        bootId: "boot-a",
        generation: 1,
        agentsChanged: true,
        modelsChanged: true,
        skillsChanged: true,
        runtimeChanged: true,
        projectWatchLeaseId: "app/lease",
      }),
    );
    expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenCalledWith("app/lease", {
      revision: 0,
      cwds: [],
    });

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog", { name: "Settings" });
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();

    view.unmount();
    expect(disconnectConfiguration).toHaveBeenCalledOnce();
  });

  it("unions exact mounted Work, Settings, and Config project interests through the one App lease", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listStatus).mockResolvedValue(persisted);
    vi.mocked(api.openSession).mockResolvedValue({
      id: "s1",
      cwd: "/papers/exact-work",
      isStreaming: false,
      status: "ready",
      sessionFile: "/store/s1.jsonl",
    });
    vi.mocked(api.listConfigProjects).mockResolvedValue({
      home: "/tmp/agent",
      projects: [{ cwd: "/papers/settings" }, { cwd: "/papers/config" }],
    });
    window.location.hash = "#/work/s1?cwd=%2Fp";
    await renderWork();

    act(() =>
      configurationHandlers.onEvent({
        type: "config.updated",
        bootId: "boot-a",
        generation: 1,
        agentsChanged: true,
        modelsChanged: true,
        skillsChanged: true,
        runtimeChanged: true,
        projectWatchLeaseId: "surface/lease",
      }),
    );
    await waitFor(() =>
      expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenLastCalledWith("surface/lease", {
        revision: 0,
        cwds: ["/papers/exact-work"],
      }),
    );

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Skills and tools" }));
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Skill diagnostic scope" }),
      "/papers/settings",
    );
    await waitFor(() =>
      expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenLastCalledWith("surface/lease", {
        revision: 1,
        cwds: ["/papers/exact-work", "/papers/settings"],
      }),
    );

    await user.click(screen.getByRole("button", { name: /open config browser/i }));
    expect(await screen.findByText("Config browser")).toBeVisible();
    await waitFor(() =>
      expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenLastCalledWith("surface/lease", {
        revision: 2,
        cwds: ["/papers/exact-work"],
      }),
    );
    await user.click(await screen.findByRole("button", { name: "/papers/config" }));
    await waitFor(() =>
      expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenLastCalledWith("surface/lease", {
        revision: 3,
        cwds: ["/papers/exact-work", "/papers/config"],
      }),
    );

    await user.click(screen.getByRole("button", { name: /back to files/i }));
    await waitFor(() =>
      expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenLastCalledWith("surface/lease", {
        revision: 4,
        cwds: ["/papers/exact-work"],
      }),
    );
    await user.click(screen.getByRole("button", { name: "Back to Settings" }));
    await user.click(await screen.findByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: /back to home/i }));
    await waitFor(() =>
      expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenLastCalledWith("surface/lease", {
        revision: 5,
        cwds: [],
      }),
    );
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();
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
        bootId: "boot-a",
        generation: 2,
        agentsChanged: true,
        modelsChanged: false,
        skillsChanged: false,
        runtimeChanged: true,
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

  it("reloads a successor boot once and remounts Work with successor API-usage settings", async () => {
    const usage = {
      input: 5,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 7,
      cacheHitRate: 0,
      cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
    };
    vi.mocked(api.listStatus).mockResolvedValue(persisted);
    vi.mocked(api.getSnapshot).mockResolvedValue({
      ...(workSnapshot as unknown as Record<string, unknown>),
      inlineUsage: [
        {
          id: "assistant-1",
          sessionId: "s1",
          source: "assistant",
          timestamp: "2026-08-25T00:00:00.000Z",
          anchor: { kind: "message", messageEntryId: "assistant-1" },
          provider: "openai",
          model: "successor-model",
          usage,
        },
      ],
    } as never);
    const reload = vi.fn();
    const runtimeReplacementBrowser = {
      history: window.history,
      location: window.location,
      reload,
    };
    window.location.hash = "#/work/s1?cwd=%2Fp";
    const oldPage = await renderWork(<App runtimeReplacementBrowser={runtimeReplacementBrowser} />);
    await waitFor(() => expect(api.getApiUsageSettings).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText("API usage details")).toBeNull();

    act(() =>
      configurationHandlers.onEvent({
        type: "config.updated",
        bootId: "boot-a",
        generation: 100,
        agentsChanged: true,
        modelsChanged: true,
        skillsChanged: true,
        runtimeChanged: true,
        projectWatchLeaseId: "lease-a",
      }),
    );
    const usageReadsBeforeReplacement = vi.mocked(api.getApiUsageSettings).mock.calls.length;
    act(() =>
      configurationHandlers.onEvent({
        type: "config.updated",
        bootId: "boot-b",
        generation: 1,
        agentsChanged: true,
        modelsChanged: true,
        skillsChanged: true,
        runtimeChanged: true,
        projectWatchLeaseId: "lease-b",
      }),
    );

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(window.location.hash).toBe("#/work/s1?cwd=%2Fp");
    expect(api.getApiUsageSettings).toHaveBeenCalledTimes(usageReadsBeforeReplacement);
    expect(configurationApi.replaceConfigurationProjectWatches).not.toHaveBeenCalledWith("lease-b", expect.anything());

    act(() => {
      configurationHandlers.onEvent({
        type: "config.updated",
        bootId: "boot-b",
        generation: 100,
        agentsChanged: true,
        modelsChanged: true,
        skillsChanged: true,
        runtimeChanged: true,
      });
      configurationHandlers.onEvent({
        type: "config.updated",
        bootId: "boot-c",
        generation: 101,
        agentsChanged: true,
        modelsChanged: true,
        skillsChanged: true,
        runtimeChanged: true,
      });
    });
    expect(reload).toHaveBeenCalledOnce();

    oldPage.unmount();
    vi.mocked(api.getApiUsageSettings).mockReset().mockResolvedValue({ showApiUsageDetails: true });
    await renderWork(<App runtimeReplacementBrowser={runtimeReplacementBrowser} />);
    act(() =>
      configurationHandlers.onEvent({
        type: "config.updated",
        bootId: "boot-b",
        generation: 1,
        agentsChanged: true,
        modelsChanged: true,
        skillsChanged: true,
        runtimeChanged: true,
        projectWatchLeaseId: "lease-b-fresh",
      }),
    );

    expect(await screen.findByLabelText("API usage details")).toHaveTextContent("successor-model");
    expect(api.getApiUsageSettings).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("owns an accepted npm restart, blocks Home, and reloads after a changed status boot id", async () => {
    const user = userEvent.setup();
    const reload = vi.fn();
    const runtimeReplacementBrowser = {
      history: window.history,
      location: window.location,
      reload,
    };
    vi.mocked(api.getNetworkProxySettings).mockResolvedValue({
      configured: { all: "http://saved.example" },
      appliedConfigured: {},
      sources: { all: "configured", llm: "all", search: "all" },
      errors: [],
      restartRequired: true,
    });
    vi.mocked(api.restartRuntime).mockResolvedValue({ accepted: true, bootId: "boot-old" });
    vi.mocked(api.listStatus).mockImplementation(async (options = {}) =>
      options.signal ? { ...persisted, bootId: "boot-new" } : { ...persisted, sessions: [], activeSessions: [] },
    );
    render(<App runtimeReplacementBrowser={runtimeReplacementBrowser} />);
    const homeWorkspace = await workspace();
    const baseSurface = homeWorkspace.closest("[data-app-surface]");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Network" }));
    await user.click(await screen.findByRole("button", { name: "Restart required" }));

    await user.click(screen.getByRole("button", { name: "Restart now" }));

    const overlay = await screen.findByRole("dialog", { name: "Restarting EasyResearch" });
    expect(overlay).toHaveAttribute("aria-modal", "true");
    expect(overlay).toHaveTextContent("Waiting for the new runtime");
    expect(baseSurface).toHaveAttribute("inert");
    expect(baseSurface).toHaveAttribute("aria-hidden", "true");
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(api.restartRuntime).toHaveBeenCalledOnce();
    expect(api.restartRuntime).toHaveBeenCalledWith(false);
    expect(vi.mocked(api.listStatus).mock.calls.some(([options]) => options?.signal instanceof AbortSignal)).toBe(true);
  });

  it("retries only successor polling after timeout and never posts restart twice", async () => {
    const firstPoll = deferred<"timed-out">();
    const secondPoll = deferred<"cancelled">();
    const poller = vi.fn().mockReturnValueOnce(firstPoll.promise).mockReturnValueOnce(secondPoll.promise);
    vi.mocked(api.getNetworkProxySettings).mockResolvedValue({
      configured: { all: "http://saved.example" },
      appliedConfigured: {},
      sources: { all: "configured", llm: "all", search: "all" },
      errors: [],
      restartRequired: true,
    });
    vi.mocked(api.restartRuntime).mockResolvedValue({ accepted: true, bootId: "boot-old" });
    const user = userEvent.setup();
    render(<App runtimeReplacementPoller={poller} />);
    await workspace();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Network" }));
    await user.click(await screen.findByRole("button", { name: "Restart required" }));
    await user.click(screen.getByRole("button", { name: "Restart now" }));
    await screen.findByRole("dialog", { name: "Restarting EasyResearch" });

    await act(async () => {
      firstPoll.resolve("timed-out");
      await firstPoll.promise;
    });

    const timeout = await screen.findByRole("dialog", { name: "Restart is taking longer than expected" });
    expect(timeout).toHaveTextContent("launch EasyResearch manually");
    expect(timeout).toHaveTextContent("logs");
    await user.click(within(timeout).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(poller).toHaveBeenCalledTimes(2));
    expect(api.restartRuntime).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog", { name: "Restarting EasyResearch" })).toBeVisible();
    secondPoll.resolve("cancelled");
  });

  it("waits for Desktop replacement without starting same-origin polling", async () => {
    window.easyresearchDesktop = {
      platform: "darwin",
      version: "0.0.79",
      persistWebUiPreferences: vi.fn(),
    };
    const poller = vi.fn();
    vi.mocked(api.getNetworkProxySettings).mockResolvedValue({
      configured: { all: "http://saved.example" },
      appliedConfigured: {},
      sources: { all: "configured", llm: "all", search: "all" },
      errors: [],
      restartRequired: true,
    });
    vi.mocked(api.restartRuntime).mockResolvedValue({ accepted: true, bootId: "boot-old" });
    const user = userEvent.setup();
    render(<App runtimeReplacementPoller={poller} />);
    await workspace();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Network" }));
    await user.click(await screen.findByRole("button", { name: "Restart required" }));

    await user.click(screen.getByRole("button", { name: "Restart now" }));

    const overlay = await screen.findByRole("dialog", { name: "Restarting EasyResearch" });
    expect(overlay).toHaveTextContent("The desktop app is replacing the runtime");
    expect(poller).not.toHaveBeenCalled();
  });

  it("uses one reload boundary when Work receives SSE replacement before expected-restart polling settles", async () => {
    const user = userEvent.setup();
    const poll = deferred<"replaced">();
    let pollSignal: AbortSignal | null = null;
    const poller = vi.fn().mockImplementation((_oldBootId, dependencies) => {
      pollSignal = dependencies.signal;
      return poll.promise;
    });
    const reload = vi.fn();
    const runtimeReplacementBrowser = {
      history: window.history,
      location: window.location,
      reload,
    };
    vi.mocked(api.listStatus).mockResolvedValue(persisted);
    vi.mocked(api.getNetworkProxySettings).mockResolvedValue({
      configured: { all: "http://saved.example" },
      appliedConfigured: {},
      sources: { all: "configured", llm: "all", search: "all" },
      errors: [],
      restartRequired: true,
    });
    vi.mocked(api.restartRuntime).mockResolvedValue({ accepted: true, bootId: "boot-old" });
    window.location.hash = "#/work/s1?cwd=%2Fp";
    await renderWork(<App runtimeReplacementBrowser={runtimeReplacementBrowser} runtimeReplacementPoller={poller} />);
    act(() =>
      configurationHandlers.onEvent({
        type: "config.updated",
        bootId: "boot-old",
        generation: 1,
        agentsChanged: false,
        modelsChanged: false,
        skillsChanged: false,
        runtimeChanged: false,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Network" }));
    await user.click(await screen.findByRole("button", { name: "Restart required" }));
    await user.click(screen.getByRole("button", { name: "Restart now" }));

    await waitFor(() => expect(window.location.hash).toBe("#/work/s1?cwd=%2Fp"));
    expect(screen.getByRole("dialog", { name: "Restarting EasyResearch" })).toBeVisible();
    act(() =>
      configurationHandlers.onEvent({
        type: "config.updated",
        bootId: "boot-new",
        generation: 0,
        agentsChanged: true,
        modelsChanged: true,
        skillsChanged: true,
        runtimeChanged: true,
      }),
    );
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(pollSignal).not.toBeNull();
    expect(pollSignal!.aborted).toBe(true);
    expect(window.location.hash).toBe("#/work/s1?cwd=%2Fp");

    await act(async () => {
      poll.resolve("replaced");
      await poll.promise;
    });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("aborts expected-restart polling when App unmounts", async () => {
    let pollSignal: AbortSignal | null = null;
    const poller = vi.fn().mockImplementation((_oldBootId, dependencies) => {
      pollSignal = dependencies.signal;
      return new Promise<"cancelled">(() => {});
    });
    vi.mocked(api.getNetworkProxySettings).mockResolvedValue({
      configured: { all: "http://saved.example" },
      appliedConfigured: {},
      sources: { all: "configured", llm: "all", search: "all" },
      errors: [],
      restartRequired: true,
    });
    vi.mocked(api.restartRuntime).mockResolvedValue({ accepted: true, bootId: "boot-old" });
    const user = userEvent.setup();
    const view = render(<App runtimeReplacementPoller={poller} />);
    await workspace();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Network" }));
    await user.click(await screen.findByRole("button", { name: "Restart required" }));
    await user.click(screen.getByRole("button", { name: "Restart now" }));
    await waitFor(() => expect(poller).toHaveBeenCalledOnce());

    view.unmount();

    expect(pollSignal).not.toBeNull();
    expect(pollSignal!.aborted).toBe(true);
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
