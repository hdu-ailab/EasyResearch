import { act, fireEvent, render as renderWithTestingLibrary, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../../../package.json";
import type { SessionSnapshotDto } from "../../web/contracts";
import { App } from "./App";
import * as api from "./api";
import { I18nProvider } from "./i18n/I18nProvider";
import { STORAGE_KEY } from "./preferences";
import { PreferencesProvider } from "./preferences/PreferencesProvider";
import { hydrateTranscript, observerFor } from "./testing/transcriptTest";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    listStatus: vi.fn(),
    checkForUpdate: vi.fn(),
    openSession: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteWorkspace: vi.fn(),
    relocateWorkspace: vi.fn(),
    resumeRelocatedSession: vi.fn(),
    listDirectories: vi.fn(),
    listDirectoryRoots: vi.fn(),
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
    getProviderTimeoutSettings: vi.fn(),
    patchProviderTimeoutSettings: vi.fn(),
    getCompactionSettings: vi.fn(),
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
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

async function hydrateResolvedWork(container: HTMLElement) {
  await waitFor(
    () => {
      const conversation = container.querySelector<HTMLElement>('[aria-label="Conversation"]');
      expect(conversation).not.toBeNull();
      expect(observerFor(conversation!)).toBeDefined();
    },
    { container },
  );
  hydrateTranscript(container);
  await within(container).findByText("starting research");
}

// Async route resolution must register its observer before the one hydration.
async function renderWork(app: ReactElement = <App />) {
  const result = render(app);
  await screen.findByRole("tabpanel", { name: /^chat$/i });
  await hydrateResolvedWork(result.container);
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
    window.localStorage.clear();
    window.history.replaceState(null, "", "#/");
  });

  beforeEach(() => {
    window.history.replaceState(null, "", "#/");
    vi.mocked(api.listStatus).mockReset();
    vi.mocked(api.checkForUpdate).mockReset().mockResolvedValue({ latestVersion: null });
    vi.mocked(api.openSession).mockReset();
    vi.mocked(api.createSession).mockReset();
    vi.mocked(api.deleteSession).mockReset();
    vi.mocked(api.deleteWorkspace).mockReset();
    vi.mocked(api.relocateWorkspace).mockReset();
    vi.mocked(api.resumeRelocatedSession).mockReset();
    vi.mocked(api.listDirectories)
      .mockReset()
      .mockImplementation(async (path) => ({ path: path ?? "/tmp", entries: [] }));
    vi.mocked(api.listDirectoryRoots)
      .mockReset()
      .mockResolvedValue([{ name: "/", path: "/" }]);
    vi.mocked(api.getSnapshot).mockReset();
    vi.mocked(api.getChildSnapshot).mockReset();
    vi.mocked(api.sendPrompt).mockClear();
    vi.mocked(api.stopSession).mockClear();
    vi.mocked(api.abortSession).mockClear();
    vi.mocked(api.getApiUsageSettings).mockReset().mockResolvedValue({ showApiUsageDetails: false });
    vi.mocked(api.getProviderTimeoutSettings)
      .mockReset()
      .mockResolvedValue({ timeoutMs: 3_600_000, source: "default" });
    vi.mocked(api.getCompactionSettings).mockReset().mockResolvedValue({ triggerPercent: 70, globalEnabled: true });
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

  const tabButton = (id: string) =>
    document.querySelector<HTMLButtonElement>(`[role="tab"][data-session-tab-id="${id}"]`)!;
  const sessionSurface = (id: string) => document.querySelector<HTMLElement>(`[data-session-surface="${id}"]`)!;

  function multipleSessions() {
    const sessions = ["s1", "s2", "s3"].map((id) => ({
      ...persisted.sessions[0]!,
      id,
      name: "Same title",
      path: `/store/${id}.jsonl`,
      cwd: id === "s3" ? "/other" : "/p",
    }));
    vi.mocked(api.listStatus).mockResolvedValue({ ...persisted, sessions });
    vi.mocked(api.openSession).mockImplementation(async (path) => {
      const session = sessions.find((session) => session.path === path)!;
      return { id: session.id, cwd: session.cwd, sessionName: session.name, status: "ready", isStreaming: false };
    });
    vi.mocked(api.getSnapshot).mockImplementation(async (id) => ({
      ...(workSnapshot as SessionSnapshotDto),
      session: {
        id,
        cwd: id === "s3" ? "/other" : "/p",
        sessionName: "Same title",
        status: "ready",
        isStreaming: false,
      },
    }));
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ language: "en", sessionTabs: sessions.map(({ id, cwd, name }) => ({ id, cwd, name })) }),
    );
    return sessions;
  }

  const createdRoot = {
    id: "c5475ad3-92e3-4d37-96db-ebcf66a425b7",
    cwd: "/p",
    status: "ready" as const,
    isStreaming: false,
  };
  const emptySnapshot: SessionSnapshotDto = {
    session: createdRoot,
    timeline: [],
    subagents: [],
    runtimeConfigurationGeneration: 0,
    compactionPolicy: { triggerPercent: 70, enabled: true },
  };
  const plus = () => screen.getByRole("button", { name: "New session in this workspace" });

  function creationFixture() {
    multipleSessions();
    const request = deferred<Awaited<ReturnType<typeof api.createSession>>>();
    vi.mocked(api.createSession).mockReturnValue(request.promise);
    const originalSnapshot = vi.mocked(api.getSnapshot).getMockImplementation()!;
    vi.mocked(api.getSnapshot).mockImplementation((id) =>
      id === createdRoot.id ? Promise.resolve(emptySnapshot) : originalSnapshot(id),
    );
    const handlers = new Map<string, Parameters<typeof api.connectSessionEvents>[1]>();
    const releases = new Map<string, ReturnType<typeof vi.fn>>();
    vi.mocked(api.connectSessionEvents).mockImplementation((id, value) => {
      handlers.set(id, value);
      const release = vi.fn();
      releases.set(id, release);
      return release;
    });
    window.history.replaceState(null, "", "#/work/s1?cwd=%2Fp");
    return { request, handlers, releases };
  }

  function expectNoAgentMutation() {
    expect(api.sendPrompt).not.toHaveBeenCalled();
    expect(api.stopSession).not.toHaveBeenCalled();
    expect(api.abortSession).not.toHaveBeenCalled();
    expect(api.deleteSession).not.toHaveBeenCalled();
  }

  it("creates one empty independent root in the resolved Work cwd, retaining the source view and draft", async () => {
    const { request, releases } = creationFixture();
    // The address bar carries an obsolete hint; the root's accepted cwd wins.
    window.history.replaceState(null, "", "#/work/s1?cwd=%2Fstale-hash");
    await renderWork();
    const original = sessionSurface("s1");
    const draft = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(draft, { target: { value: "Source draft with @reference" } });
    const create = plus();
    act(() => {
      create.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      create.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(api.createSession).toHaveBeenCalledExactlyOnceWith("/p");
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute("aria-busy", "true");
    expect(tabButton("s2")).toBeEnabled();
    expect(sessionSurface("s1")).toBe(original);
    expect(window.location.hash).toBe("#/work/s1?cwd=%2Fp");
    await act(async () => request.resolve(createdRoot));
    await waitFor(() => expect(sessionSurface(createdRoot.id)).not.toBeNull());
    expect(window.location.hash).toBe(`#/work/${createdRoot.id}?cwd=%2Fp`);
    expect(tabButton(createdRoot.id)).toHaveAttribute("aria-selected", "true");
    expect(createdRoot.id).not.toBe("s1");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    expect(sessionSurface(createdRoot.id).querySelector("[data-work-layout]")).toHaveAttribute(
      "data-panel-open",
      "false",
    );
    expect(within(sessionSurface(createdRoot.id)).queryByText("starting research")).toBeNull();
    expect(api.openSession).toHaveBeenCalledTimes(1);
    expect(releases.get("s1")).not.toHaveBeenCalled();
    fireEvent.click(tabButton("s1"));
    expect(sessionSurface("s1")).toBe(original);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(draft);
    expect(draft).toHaveValue("Source draft with @reference");
    fireEvent.keyDown(tabButton(createdRoot.id), { key: "Delete" });
    expect(releases.get(createdRoot.id)).toHaveBeenCalledOnce();
    expect(releases.get("s1")).not.toHaveBeenCalled();
    expectNoAgentMutation();
  });

  it("uses the root workspace even while the source displays a read-only child", async () => {
    const { request, handlers } = creationFixture();
    vi.mocked(api.getChildSnapshot).mockResolvedValue({
      session: { id: "child", cwd: "/foreign-child-scope", sessionName: "easyresearch:search" },
      timeline: [],
      subagents: [],
    });
    await renderWork();
    act(() => {
      handlers.get("s1")!.onEvent({
        type: "tool_execution_start",
        toolCallId: "child-tool",
        toolName: "subagent",
        args: { agent: "search" },
      });
      handlers.get("s1")!.onEvent({
        type: "subagent_supervisor",
        ownerSessionId: "s1",
        toolCallId: "child-tool",
        agent: "search",
        agentId: "search_0",
        childSessionId: "child",
        launchId: "launch-child",
        status: "working",
      });
    });
    await userEvent.click(await screen.findByRole("button", { name: /agent search/i }));
    await waitFor(() => expect(api.getChildSnapshot).toHaveBeenCalledWith("s1", "child"));
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    fireEvent.click(plus());
    expect(api.createSession).toHaveBeenCalledExactlyOnceWith("/p");
    await act(async () => request.resolve(createdRoot));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled());
    fireEvent.click(tabButton("s1"));
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    expectNoAgentMutation();
  });

  it.each([false, true])(
    "creates in an active-only root's authoritative cwd with a stale bookmark: %s",
    async (bookmarked) => {
      const activeRoot = { id: "active-empty", cwd: "/authoritative", status: "ready" as const, isStreaming: false };
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          language: "en",
          sessionTabs: bookmarked
            ? [
                { id: activeRoot.id, cwd: "/stale-bookmark" },
                { id: "unvisited", cwd: "/other" },
              ]
            : [],
        }),
      );
      window.history.replaceState(null, "", "#/work/active-empty?cwd=%2Fstale-hash");
      vi.mocked(api.listStatus).mockResolvedValue({ ...persisted, sessions: [], activeSessions: [activeRoot] });
      vi.mocked(api.getSnapshot).mockImplementation(async (id) => ({
        ...emptySnapshot,
        session: id === activeRoot.id ? activeRoot : { ...createdRoot, cwd: activeRoot.cwd },
      }));
      const request = deferred<Awaited<ReturnType<typeof api.createSession>>>();
      vi.mocked(api.createSession).mockReturnValue(request.promise);
      render(<App />);
      await waitFor(() => expect(plus()).toBeEnabled());
      await waitFor(() => expect(api.getSnapshot).toHaveBeenCalledWith(activeRoot.id));
      expect(window.location.hash).toBe("#/work/active-empty?cwd=%2Fauthoritative");
      expect(api.openSession).not.toHaveBeenCalled();
      const original = sessionSurface(activeRoot.id);
      fireEvent.click(plus());
      expect(api.createSession).toHaveBeenCalledExactlyOnceWith(activeRoot.cwd);
      await act(async () => request.resolve({ ...createdRoot, cwd: activeRoot.cwd }));
      await waitFor(() => expect(sessionSurface(createdRoot.id)).not.toBeNull());
      expect(window.location.hash).toBe(`#/work/${createdRoot.id}?cwd=%2Fauthoritative`);
      expect(sessionSurface(activeRoot.id)).toBe(original);
      expect(sessionSurface("unvisited")).toBeNull();
      expect(api.getSnapshot).not.toHaveBeenCalledWith("unvisited");
      expectNoAgentMutation();
    },
  );

  it.each(["unknown", "listing-failure"] as const)(
    "allows fallback attachment for %s but never creates from its unresolved cwd hint",
    async (failure) => {
      window.history.replaceState(null, "", "#/work/active-empty?cwd=%2Fstale-hash");
      if (failure === "listing-failure") vi.mocked(api.listStatus).mockRejectedValue(new Error("Status unavailable"));
      if (failure === "unknown")
        vi.mocked(api.getSnapshot).mockRejectedValue(new api.ApiError(404, { error: "Unknown session" }));
      else
        vi.mocked(api.getSnapshot).mockResolvedValue({
          ...emptySnapshot,
          session: { ...createdRoot, id: "active-empty", cwd: "/authoritative" },
        });
      render(<App />);
      await waitFor(() => expect(api.getSnapshot).toHaveBeenCalledWith("active-empty"));
      await screen.findByRole("textbox", { name: "Message" });
      expect(plus()).toBeDisabled();
      fireEvent.click(plus());
      expect(api.createSession).not.toHaveBeenCalled();
      expect(api.openSession).not.toHaveBeenCalled();
      if (failure === "unknown") expect(await screen.findByText("Unknown session")).toBeVisible();
    },
  );

  it.each([undefined, "Named by server"])(
    "retries an owned failure and admits optional server metadata (%s)",
    async (name) => {
      const { request } = creationFixture();
      await renderWork();
      fireEvent.click(plus());
      await act(async () => request.reject(new Error("Request failed")));
      expect(screen.getByRole("alert")).toHaveTextContent("Could not create session.");
      expect(plus()).toBeEnabled();
      expect(plus()).not.toHaveAttribute("aria-busy");
      const retry = deferred<Awaited<ReturnType<typeof api.createSession>>>();
      vi.mocked(api.createSession).mockReturnValueOnce(retry.promise);
      // Inspect the admitted metadata before the first live snapshot arrives.
      vi.mocked(api.getSnapshot).mockReturnValueOnce(new Promise(() => {}));
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(api.createSession).toHaveBeenCalledTimes(2);
      await act(async () => retry.resolve({ ...createdRoot, sessionName: name }));
      expect(tabButton(createdRoot.id)).toHaveAccessibleName(name ?? "Untitled session");
      const bookmark = JSON.parse(localStorage.getItem(STORAGE_KEY)!).sessionTabs.find(
        (tab: { id: string }) => tab.id === createdRoot.id,
      );
      if (name) expect(bookmark.name).toBe(name);
      else expect(bookmark).not.toHaveProperty("name");
      expectNoAgentMutation();
    },
  );

  it("routes missing-folder creation failure through the source root's recovery dialog", async () => {
    const { request } = creationFixture();
    await renderWork();
    fireEvent.click(plus());
    await act(async () =>
      request.reject(new api.ApiError(404, { code: "WORKSPACE_MISSING", cwd: "/p", error: "Missing" })),
    );
    expect(await screen.findByRole("dialog", { name: "Workspace folder not found" })).toHaveTextContent("/p");
    expect(window.location.hash).toBe("#/work/s1?cwd=%2Fp");
    expectNoAgentMutation();
  });

  it.each(["success", "failure"] as const)(
    "fences a late %s after same-batch A→B→A, without clearing a new creation",
    async (outcome) => {
      const { request } = creationFixture();
      await renderWork();
      // Previsit B, so navigation itself does not require a deferred lookup.
      fireEvent.click(tabButton("s2"));
      await waitFor(() => expect(sessionSurface("s2")).not.toBeNull());
      fireEvent.click(tabButton("s1"));
      fireEvent.click(plus());
      act(() => {
        tabButton("s2").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        tabButton("s1").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(plus()).toBeEnabled();
      const next = deferred<Awaited<ReturnType<typeof api.createSession>>>();
      vi.mocked(api.createSession).mockReturnValueOnce(next.promise);
      fireEvent.click(plus());
      await act(async () =>
        outcome === "success" ? request.resolve(createdRoot) : request.reject(new Error("Stale failure")),
      );
      expect(window.location.hash).toBe("#/work/s1?cwd=%2Fp");
      expect(tabButton(createdRoot.id)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(plus()).toBeDisabled();
      expect(plus()).toHaveAttribute("aria-busy", "true");
      fireEvent.click(plus());
      expect(api.createSession).toHaveBeenCalledTimes(2);
      await act(async () => next.reject(new Error("Current failure")));
      expect(screen.getByRole("alert")).toHaveTextContent("Could not create session.");
      expect(plus()).toBeEnabled();
      expectNoAgentMutation();
    },
  );

  it.each(
    (
      ["settings", "settings-return", "config", "close-reopen", "relocate", "delete", "unmount", "replacement"] as const
    ).flatMap((transition) => (["success", "failure"] as const).map((outcome) => ({ transition, outcome }))),
  )("expires Work creation on $transition without publishing late $outcome", async ({ transition, outcome }) => {
    const { request, handlers } = creationFixture();
    const reload = vi.fn();
    const app = await renderWork(
      <App runtimeReplacementBrowser={{ history: window.history, location: window.location, reload }} />,
    );
    fireEvent.click(plus());
    let settingsDraft: HTMLElement | undefined;
    if (transition.startsWith("settings") || transition === "config") {
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(document.querySelector(".er-session-tabs-new")).toBeDisabled();
      if (transition === "settings-return") {
        await userEvent.click(screen.getByRole("button", { name: "Close" }));
        await waitFor(() => expect(window.location.hash).toBe("#/work/s1?cwd=%2Fp"));
      } else if (transition === "config") {
        await userEvent.click(screen.getByRole("button", { name: /open config browser/i }));
        expect(await screen.findByText("Config browser")).toBeVisible();
      } else {
        await userEvent.click(screen.getByRole("tab", { name: "Network" }));
        settingsDraft = await screen.findByRole("textbox", { name: "All traffic proxy" });
        fireEvent.change(settingsDraft, { target: { value: "http://unsaved.example" } });
      }
    } else if (transition === "close-reopen") {
      fireEvent.keyDown(tabButton("s1"), { key: "Delete" });
      simulateBrowserBackTo("#/work/s1?cwd=%2Fp");
      await waitFor(() => expect(sessionSurface("s1")).not.toBeNull());
    } else if (transition === "relocate") {
      vi.mocked(api.resumeRelocatedSession).mockResolvedValue({
        id: "s1",
        cwd: "/moved",
        status: "ready",
        isStreaming: false,
      });
      vi.mocked(api.getSnapshot).mockResolvedValue({
        ...emptySnapshot,
        session: { id: "s1", cwd: "/moved", status: "ready", isStreaming: false },
      });
      act(() => handlers.get("s1")!.onEvent({ type: "session_relocated", sessionId: "s1", cwd: "/moved" }));
      await waitFor(() => expect(window.location.hash).toBe("#/work/s1?cwd=%2Fmoved"));
    } else if (transition === "delete") {
      act(() => handlers.get("s1")!.onEvent({ type: "session_deleted", sessionId: "s1" }));
      await waitFor(() => expect(sessionSurface("s2")).not.toBeNull());
    } else if (transition === "unmount") app.unmount();
    else {
      for (const bootId of ["boot-a", "boot-b"])
        act(() =>
          configurationHandlers.onEvent({
            type: "config.updated",
            bootId,
            generation: 0,
            agentsChanged: false,
            modelsChanged: false,
            skillsChanged: false,
            runtimeChanged: false,
          }),
        );
      expect(reload).toHaveBeenCalledOnce();
    }
    const hash = window.location.hash;
    const snapshotCount = vi.mocked(api.getSnapshot).mock.calls.length;
    await act(async () =>
      outcome === "success"
        ? request.resolve(createdRoot)
        : request.reject(new api.ApiError(404, { code: "WORKSPACE_MISSING", cwd: "/p", error: "Missing" })),
    );
    expect(window.location.hash).toBe(hash);
    expect(tabButton(createdRoot.id)).toBeNull();
    expect(api.getSnapshot).toHaveBeenCalledTimes(snapshotCount);
    expect(screen.queryByText("Could not create session.")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Workspace folder not found" })).toBeNull();
    if (settingsDraft) expect(settingsDraft).toHaveValue("http://unsaved.example");
    expectNoAgentMutation();
  });

  it("fences creation across an accepted restart after Settings closes back onto the source", async () => {
    const { request } = creationFixture();
    vi.mocked(api.getNetworkProxySettings).mockResolvedValue({
      configured: { all: "http://saved.example" },
      appliedConfigured: {},
      sources: { all: "configured", llm: "all", search: "all" },
      errors: [],
      restartRequired: true,
    });
    vi.mocked(api.restartRuntime).mockResolvedValue({ accepted: true, bootId: "boot-a" });
    await renderWork(<App runtimeReplacementPoller={() => new Promise(() => {})} />);
    fireEvent.click(plus());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Network" }));
    await user.click(await screen.findByRole("button", { name: "Restart required" }));
    await user.click(screen.getByRole("button", { name: "Restart now" }));
    expect(await screen.findByRole("dialog", { name: "Restarting EasyResearch" })).toBeVisible();
    expect(document.querySelector(".er-session-tabs-new")).toBeDisabled();
    await act(async () => request.resolve(createdRoot));
    expect(window.location.hash).toBe("#/work/s1?cwd=%2Fp");
    expect(tabButton(createdRoot.id)).toBeNull();
    expectNoAgentMutation();
  });

  it("disables only plus while Work resolves or fails; Home plus retains the existing chooser surface", async () => {
    creationFixture();
    const opening = deferred<Awaited<ReturnType<typeof api.openSession>>>();
    vi.mocked(api.openSession).mockReturnValueOnce(opening.promise);
    render(<App />);
    await waitFor(() => expect(api.openSession).toHaveBeenCalledOnce());
    expect(plus()).toBeDisabled();
    expect(tabButton("s2")).toBeEnabled();
    await act(async () => opening.reject(new Error("Cannot open root")));
    expect(plus()).toBeDisabled();
    expect(tabButton("s2")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Back to home" }));
    await workspace();
    fireEvent.click(screen.getByRole("button", { name: "New or open session" }));
    expect(window.location.hash).toBe("#/");
    expect(workspace()).toBeVisible();
    expect(screen.getByRole("button", { name: "New workspace" })).toBeEnabled();
    expect(api.createSession).not.toHaveBeenCalled();
  });

  async function chooseRecoveryFolder() {
    const user = userEvent.setup();
    const recovery = await screen.findByRole("dialog", { name: "Workspace folder not found" });
    await user.click(within(recovery).getByRole("button", { name: "Choose new folder" }));
    const picker = screen.getByRole("dialog", { name: "Choose new folder" });
    await user.clear(within(picker).getByRole("combobox"));
    await user.type(within(picker).getByRole("combobox"), "/moved{Enter}");
    await waitFor(() => expect(within(picker).getByRole("button", { name: "Migrate and open" })).toBeEnabled());
    await user.click(within(picker).getByRole("button", { name: "Migrate and open" }));
  }

  it.each(["work", "home"] as const)(
    "mounts the accepted new UUID from real empty-root recovery via %s and replaces its bookmark",
    async (surface) => {
      const realApi = await vi.importActual<typeof import("./api")>("./api");
      vi.mocked(api.resumeRelocatedSession).mockImplementation(realApi.resumeRelocatedSession);
      vi.mocked(api.listStatus).mockResolvedValue({
        ...persisted,
        sessions: [],
        activeSessions:
          surface === "home"
            ? [{ id: "s1", cwd: "/p", sessionName: "Empty root", status: "ready", isStreaming: false }]
            : [],
      });
      if (surface === "home")
        vi.mocked(api.touchSession).mockRejectedValueOnce(
          new api.ApiError(404, { code: "WORKSPACE_MISSING", cwd: "/p", error: "Folder missing" }),
        );
      vi.mocked(api.getSnapshot).mockImplementation(async (id) => ({
        ...(workSnapshot as SessionSnapshotDto),
        session: { id, cwd: "/moved", status: "ready", isStreaming: false },
      }));
      if (surface === "work")
        vi.mocked(api.getSnapshot).mockRejectedValueOnce(
          new api.ApiError(404, { code: "WORKSPACE_MISSING", cwd: "/p", error: "Folder missing" }),
        );
      vi.mocked(api.relocateWorkspace).mockImplementation(async () => {
        vi.mocked(api.listStatus).mockResolvedValue({ ...persisted, sessions: [], activeSessions: [] });
        return { cwd: "/moved", sessionIds: ["s1"] };
      });
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === "/api/status") return Response.json({ ...persisted, sessions: [], activeSessions: [] });
        if (path === "/api/sessions" && init?.method === "POST")
          return Response.json({ id: "recovered", cwd: "/moved", status: "ready", isStreaming: false });
        throw new Error(`Unexpected request ${path}`);
      });
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ language: "en", sessionTabs: [{ id: "s1", cwd: "/p" }] }));
        window.history.replaceState(null, "", surface === "work" ? "#/work/s1?cwd=%2Fp" : "#/");
        render(<App />);
        if (surface === "home") await userEvent.setup().click(await within(workspace()).findByText("Empty root"));
        await chooseRecoveryFolder();
        await waitFor(() => expect(window.location.hash).toBe("#/work/recovered?cwd=%2Fmoved"));
        await waitFor(() => expect(sessionSurface("recovered")).not.toBeNull());
        expect(tabButton("s1")).toBeNull();
        expect(tabButton("recovered")).toHaveAttribute("aria-selected", "true");
        expect(api.getSnapshot).toHaveBeenLastCalledWith("recovered");
        expect(api.resumeRelocatedSession).toHaveBeenCalledOnce();
      } finally {
        fetch.mockRestore();
      }
    },
  );

  it.each(["delete", "relocate"] as const)(
    "applies workspace %s results to dormant siblings after the initiating terminal SSE",
    async (operation) => {
      multipleSessions();
      const mutation = deferred<Awaited<ReturnType<typeof api.deleteWorkspace>>>();
      vi.mocked(api.deleteWorkspace).mockReturnValue(mutation.promise);
      vi.mocked(api.relocateWorkspace).mockReturnValue(mutation.promise);
      vi.mocked(api.resumeRelocatedSession).mockResolvedValue({
        id: "s1",
        cwd: "/moved",
        status: "ready",
        isStreaming: false,
      });
      vi.mocked(api.getSnapshot)
        .mockRejectedValueOnce(new api.ApiError(404, { code: "WORKSPACE_MISSING", cwd: "/p", error: "Folder missing" }))
        .mockImplementation(async (id) => ({
          ...(workSnapshot as SessionSnapshotDto),
          session: {
            id,
            cwd: id === "s1" ? "/moved" : id === "s3" ? "/other" : "/p",
            status: "ready",
            isStreaming: false,
          },
        }));
      const handlers = new Map<string, Parameters<typeof api.connectSessionEvents>[1]>();
      vi.mocked(api.connectSessionEvents).mockImplementation((id, value) => {
        handlers.set(id, value);
        return vi.fn();
      });
      window.history.replaceState(null, "", "#/work/s1?cwd=%2Fp");
      render(<App />);
      const user = userEvent.setup();
      if (operation === "delete") {
        const recovery = await screen.findByRole("dialog", { name: "Workspace folder not found" });
        await user.click(within(recovery).getByRole("button", { name: "Delete workspace" }));
        await user.click(
          within(screen.getByRole("dialog", { name: "Delete workspace" })).getByRole("button", {
            name: "Delete workspace",
          }),
        );
        act(() => handlers.get("s1")!.onEvent({ type: "session_deleted", sessionId: "s1" }));
        await waitFor(() => expect(window.location.hash).toBe("#/work/s2?cwd=%2Fp"));
        await act(async () => mutation.resolve({ cwd: "/p", sessionIds: ["s1", "s2"] }));
        await waitFor(() => expect(window.location.hash).toBe("#/work/s3?cwd=%2Fother"));
        expect(tabButton("s1")).toBeNull();
        expect(tabButton("s2")).toBeNull();
        expect(api.resumeRelocatedSession).not.toHaveBeenCalled();
      } else {
        await chooseRecoveryFolder();
        act(() => handlers.get("s1")!.onEvent({ type: "session_relocated", sessionId: "s1", cwd: "/moved" }));
        await waitFor(() => expect(window.location.hash).toBe("#/work/s1?cwd=%2Fmoved"));
        await act(async () => mutation.resolve({ cwd: "/moved", sessionIds: ["s1", "s2"] }));
        expect(
          JSON.parse(localStorage.getItem(STORAGE_KEY)!).sessionTabs.find((tab: { id: string }) => tab.id === "s2").cwd,
        ).toBe("/moved");
        expect(sessionSurface("s2")).toBeNull();
        expect(api.resumeRelocatedSession).toHaveBeenCalledOnce();
        expect(window.location.hash).toBe("#/work/s1?cwd=%2Fmoved");
      }
    },
  );

  it("suspends the whole retained recovery layer when browser navigation activates Home", async () => {
    vi.mocked(api.listStatus).mockResolvedValue(persisted);
    vi.mocked(api.openSession).mockRejectedValueOnce(
      new api.ApiError(404, { code: "WORKSPACE_MISSING", cwd: "/p", error: "Folder missing" }),
    );
    window.history.replaceState(null, "", "#/work/s1?cwd=%2Fp");
    render(<App />);
    const form = await screen.findByRole("dialog", { name: "Workspace folder not found" });
    const backdrop = form.parentElement!;
    simulateBrowserBackTo("#/");
    expect(form).toBeInTheDocument();
    expect(backdrop).not.toBeVisible();
    expect(backdrop).toHaveAttribute("inert");
    simulateBrowserBackTo("#/work/s1?cwd=%2Fp");
    expect(screen.getByRole("dialog", { name: "Workspace folder not found" })).toBe(form);
  });

  it.each(["active", "background"] as const)(
    "keeps only the surviving root when %s recovery SSE and HTTP deletion settle in one React batch",
    async (selection) => {
      const sessions = multipleSessions();
      const mutation = deferred<Awaited<ReturnType<typeof api.deleteWorkspace>>>();
      vi.mocked(api.deleteWorkspace).mockReturnValue(mutation.promise);
      const handlers = new Map<string, Parameters<typeof api.connectSessionEvents>[1]>();
      vi.mocked(api.connectSessionEvents).mockImplementation((id, value) => {
        handlers.set(id, value);
        return vi.fn();
      });
      vi.mocked(api.getSnapshot)
        .mockRejectedValueOnce(new api.ApiError(404, { code: "WORKSPACE_MISSING", cwd: "/p", error: "Folder missing" }))
        .mockImplementation(async (id) => {
          if (id !== "s3") throw new api.ApiError(404, { error: "Unknown session" });
          return {
            ...(workSnapshot as SessionSnapshotDto),
            session: { id, cwd: "/other", status: "ready", isStreaming: false },
          };
        });
      window.history.replaceState(null, "", "#/work/s1?cwd=%2Fp");
      render(<App />);
      const user = userEvent.setup();
      const recovery = await screen.findByRole("dialog", { name: "Workspace folder not found" });
      await user.click(within(recovery).getByRole("button", { name: "Delete workspace" }));
      await user.click(
        within(screen.getByRole("dialog", { name: "Delete workspace" })).getByRole("button", {
          name: "Delete workspace",
        }),
      );
      if (selection === "background") {
        simulateBrowserBackTo("#/work/s3?cwd=%2Fother");
        await waitFor(() => expect(handlers.has("s3")).toBe(true));
      }
      vi.mocked(api.listStatus).mockResolvedValue({
        ...persisted,
        sessions: sessions.filter((session) => session.id === "s3"),
      });
      await act(async () => {
        handlers.get("s1")!.onEvent({ type: "session_deleted", sessionId: "s1" });
        mutation.resolve({ cwd: "/p", sessionIds: ["s1", "s2"] });
        await mutation.promise;
      });
      await waitFor(() => expect(window.location.hash).toBe("#/work/s3?cwd=%2Fother"));
      expect(
        [...document.querySelectorAll("[data-session-tab-id]")].map((tab) => tab.getAttribute("data-session-tab-id")),
      ).toEqual(["s3"]);
      expect(tabButton("s3")).toHaveAttribute("aria-selected", "true");
      expect(api.openSession).not.toHaveBeenCalledWith("/store/s2.jsonl");
      expect(api.getSnapshot).not.toHaveBeenCalledWith("s2");
      expect(screen.queryByText("Unknown session")).toBeNull();
    },
  );

  it.each(["work", "settings", "config"] as const)(
    "advances through consecutive visited-root deletion SSEs before rendering the %s host",
    async (surface) => {
      multipleSessions();
      const handlers = new Map<string, Parameters<typeof api.connectSessionEvents>[1]>();
      vi.mocked(api.connectSessionEvents).mockImplementation((id, value) => {
        handlers.set(id, value);
        return vi.fn();
      });
      window.history.replaceState(null, "", "#/work/s1?cwd=%2Fp");
      const user = userEvent.setup();
      await renderWork();
      await user.click(tabButton("s2"));
      await waitFor(() => expect(handlers.has("s2")).toBe(true));
      await user.click(tabButton("s1"));
      let draft: HTMLElement | undefined;
      if (surface !== "work") {
        await user.click(screen.getByRole("button", { name: "Settings" }));
      }
      if (surface === "settings") {
        await user.click(screen.getByRole("tab", { name: "Network" }));
        draft = await screen.findByRole("textbox", { name: "All traffic proxy" });
        fireEvent.change(draft, { target: { value: "http://draft.example" } });
      }
      if (surface === "config") {
        await user.click(screen.getByRole("button", { name: /open config browser/i }));
        expect(await screen.findByText("Config browser")).toBeVisible();
      }
      act(() => {
        handlers.get("s1")!.onEvent({ type: "session_deleted", sessionId: "s1" });
        handlers.get("s2")!.onEvent({ type: "session_deleted", sessionId: "s2" });
      });
      const expected =
        surface === "config"
          ? `#/config?returnTo=${encodeURIComponent("#/work/s3?cwd=%2Fother&settings=1")}`
          : `#/work/s3?cwd=%2Fother${surface === "settings" ? "&settings=1" : ""}`;
      await waitFor(() => expect(window.location.hash).toBe(expected));
      expect(tabButton("s1")).toBeNull();
      expect(tabButton("s2")).toBeNull();
      expect(api.getSnapshot).toHaveBeenCalledTimes(3);
      if (draft) {
        expect(screen.getByRole("textbox", { name: "All traffic proxy" })).toBe(draft);
        expect(draft).toHaveValue("http://draft.example");
        simulateBrowserBackTo("#/work/s3?cwd=%2Fother");
        expect(await screen.findByRole("dialog", { name: "Discard network changes?" })).toBeVisible();
      }
      if (surface === "config") {
        expect(screen.getByText("Config browser")).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Back to Settings" }));
        await waitFor(() => expect(window.location.hash).toBe("#/work/s3?cwd=%2Fother&settings=1"));
        await user.click(screen.getByRole("button", { name: "Close" }));
        await waitFor(() => expect(window.location.hash).toBe("#/work/s3?cwd=%2Fother"));
      }
    },
  );

  it("honors a root selection published immediately before background deletion events in the same batch", async () => {
    multipleSessions();
    const handlers = new Map<string, Parameters<typeof api.connectSessionEvents>[1]>();
    vi.mocked(api.connectSessionEvents).mockImplementation((id, value) => {
      handlers.set(id, value);
      return vi.fn();
    });
    window.history.replaceState(null, "", "#/work/s1?cwd=%2Fp");
    const user = userEvent.setup();
    await renderWork();
    await user.click(tabButton("s2"));
    await waitFor(() => expect(handlers.has("s2")).toBe(true));
    await user.click(tabButton("s3"));
    await waitFor(() => expect(handlers.has("s3")).toBe(true));
    const survivingView = sessionSurface("s3");
    await user.click(tabButton("s1"));
    act(() => {
      tabButton("s3").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      handlers.get("s1")!.onEvent({ type: "session_deleted", sessionId: "s1" });
      handlers.get("s2")!.onEvent({ type: "session_deleted", sessionId: "s2" });
    });
    expect(window.location.hash).toBe("#/work/s3?cwd=%2Fother");
    expect(sessionSurface("s3")).toBe(survivingView);
    expect(tabButton("s1")).toBeNull();
    expect(tabButton("s2")).toBeNull();
    expect(api.getSnapshot).toHaveBeenCalledTimes(3);
  });

  it.each(["create", "history", "active"] as const)(
    "does not let a pending Home %s discard a dirty Settings draft",
    async (source) => {
      const request = deferred<Awaited<ReturnType<typeof api.createSession>>>();
      vi.mocked(api.listStatus).mockResolvedValue({
        ...persisted,
        sessions: [{ ...persisted.sessions[0]!, name: "Home root" }],
        activeSessions: [{ id: "active", cwd: "/p", sessionName: "Active root", status: "ready", isStreaming: false }],
      });
      vi.mocked(api.createSession).mockReturnValue(request.promise);
      vi.mocked(api.openSession).mockReturnValue(request.promise);
      if (source === "active") vi.mocked(api.touchSession).mockReturnValue(request.promise.then(() => undefined));
      const user = userEvent.setup();
      render(<App />);
      await screen.findByText("Home root");
      if (source === "create") await user.click(screen.getByRole("button", { name: "New session /p" }));
      else await user.click(screen.getByText(source === "history" ? "Home root" : "Active root"));
      await user.click(screen.getByRole("button", { name: "Settings" }));
      const settings = screen.getByRole("dialog", { name: "Settings" });
      await user.click(screen.getByRole("tab", { name: "Network" }));
      const draft = await screen.findByRole("textbox", { name: "All traffic proxy" });
      fireEvent.change(draft, { target: { value: "http://draft.example" } });
      await act(async () => request.resolve({ id: "s1", cwd: "/p", status: "ready", isStreaming: false }));
      expect(window.location.hash).toBe("#/?settings=1");
      expect(screen.getByRole("dialog", { name: "Settings" })).toBe(settings);
      expect(draft).toHaveValue("http://draft.example");
      expect(api.getSnapshot).not.toHaveBeenCalled();
      simulateBrowserBackTo("#/");
      expect(await screen.findByRole("dialog", { name: "Discard network changes?" })).toBeVisible();
    },
  );

  it("pairs root tab and panel IDs per App, including lazy, loading and error panels", async () => {
    multipleSessions();
    const first = render(<App />);
    const second = render(<App />);
    const firstTabs = [...first.container.querySelectorAll<HTMLElement>("[data-session-tab-id]")];
    const secondTabs = [...second.container.querySelectorAll<HTMLElement>("[data-session-tab-id]")];
    expect(new Set([...firstTabs, ...secondTabs].map((tab) => tab.id)).size).toBe(6);
    for (const tab of [...firstTabs, ...secondTabs]) {
      const panel = document.getElementById(tab.getAttribute("aria-controls")!);
      expect(panel).toHaveAttribute("role", "tabpanel");
      expect(panel).toHaveAttribute("aria-labelledby", tab.id);
      expect(panel).not.toHaveAttribute("data-session-surface");
      expect(panel).toBeEmptyDOMElement();
    }
    expect(api.getSnapshot).not.toHaveBeenCalled();
    const pending = deferred<Awaited<ReturnType<typeof api.openSession>>>();
    vi.mocked(api.openSession).mockReturnValueOnce(pending.promise);
    fireEvent.click(firstTabs[0]!);
    await waitFor(() => expect(api.openSession).toHaveBeenCalledOnce());
    const tab = first.container.querySelector<HTMLElement>('[data-session-tab-id="s1"]')!;
    const panel = document.getElementById(tab.getAttribute("aria-controls")!)!;
    expect(panel).toBeVisible();
    expect(within(panel).getByText("Loading session…")).toBeVisible();
    await act(async () => pending.reject(new Error("Cannot open this root")));
    expect(document.getElementById(tab.getAttribute("aria-controls")!)).toBe(panel);
    expect(within(panel).getByRole("alert")).toHaveTextContent("Cannot open this root");
    expect(panel).toHaveAttribute("aria-labelledby", tab.id);
  });

  it("keeps real Work drafts, node identity and leases across root tabs and Home; close only disposes its view", async () => {
    multipleSessions();
    const releases = new Map<string, ReturnType<typeof vi.fn>>();
    vi.mocked(api.connectSessionEvents).mockImplementation((id) => {
      const release = vi.fn();
      releases.set(id, release);
      return release;
    });
    window.history.replaceState(null, "", "#/work/s1?cwd=%2Fp");
    const user = userEvent.setup();
    await renderWork();
    const first = sessionSurface("s1");
    const draft = within(first).getByRole("textbox", { name: "Message" });
    await user.type(draft, "first draft");
    const header = document.querySelector(".er-topbar");
    const settings = screen.getByRole("button", { name: "Settings" });
    await user.click(tabButton("s2"));
    await waitFor(() => expect(sessionSurface("s2")).not.toBeNull());
    const second = sessionSurface("s2");
    await user.type(within(second).getByRole("textbox", { name: "Message" }), "second draft");
    expect(first).toHaveAttribute("inert");
    expect(first).toHaveAttribute("aria-hidden", "true");
    expect(first).toHaveStyle({ visibility: "hidden" });
    expect(first).not.toHaveAttribute("hidden");
    expect(releases.get("s1")).not.toHaveBeenCalled();
    await user.click(tabButton("s1"));
    expect(sessionSurface("s1")).toBe(first);
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(draft);
    expect(draft).toHaveValue("first draft");
    expect(api.openSession).toHaveBeenCalledTimes(2);
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".er-topbar")).toBe(header);
    expect(screen.getByRole("button", { name: "Settings" })).toBe(settings);
    await user.click(screen.getByRole("button", { name: /back to home/i }));
    expect(await workspace()).toBeVisible();
    await user.type(screen.getByRole("searchbox"), "Same");
    await user.click(tabButton("s1"));
    expect(draft).toHaveValue("first draft");
    await user.click(screen.getByRole("button", { name: /back to home/i }));
    expect(screen.getByRole("searchbox")).toHaveValue("Same");
    fireEvent.keyDown(tabButton("s2"), { key: "Delete" });
    expect(window.location.hash).toBe("#/");
    expect(releases.get("s2")).toHaveBeenCalledOnce();
    expect(releases.get("s1")).not.toHaveBeenCalled();
    expect(second).not.toBeInTheDocument();
    fireEvent.keyDown(tabButton("s3"), { key: "Delete" });
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);
    expect(api.stopSession).not.toHaveBeenCalled();
    expect(api.abortSession).not.toHaveBeenCalled();
    expect(api.deleteSession).not.toHaveBeenCalled();
  });

  it("restores only URL-selected views, keeps Home explicit and ignores external live tab changes", async () => {
    multipleSessions();
    const user = userEvent.setup();
    render(<App />);
    await workspace();
    await waitFor(() => expect(tabButton("s1")).not.toBeNull());
    expect(window.location.hash).toBe("#/");
    expect(api.openSession).not.toHaveBeenCalled();
    expect(api.getSnapshot).not.toHaveBeenCalled();
    await user.click(tabButton("s2"));
    await waitFor(() => expect(sessionSurface("s2")).not.toBeNull());
    const surface = sessionSurface("s2");
    await act(async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ language: "en", studioTheme: "dark", sessionTabs: [] }));
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    });
    expect(tabButton("s1")).toBeInTheDocument();
    expect(sessionSurface("s2")).toBe(surface);
    expect(window.location.hash).toBe("#/work/s2?cwd=%2Fp");
    expect(document.documentElement.dataset.uiTheme).toBe("dark");
    simulateBrowserBackTo("#/");
    expect(workspace()).toBeVisible();
    simulateBrowserBackTo("#/work/s2?cwd=%2Fp");
    expect(sessionSurface("s2")).toBe(surface);
    expect(api.openSession).toHaveBeenCalledOnce();
  });

  it("keeps the strip usable while resolving, and ignores a closed tab's late open", async () => {
    multipleSessions();
    const pending = deferred<Awaited<ReturnType<typeof api.openSession>>>();
    vi.mocked(api.openSession).mockReturnValueOnce(pending.promise);
    window.history.replaceState(null, "", "#/work/s1?cwd=%2Fp");
    render(<App />);
    await waitFor(() => expect(api.openSession).toHaveBeenCalledOnce());
    expect(tabButton("s1")).toHaveAttribute("data-loading", "true");
    fireEvent.keyDown(tabButton("s1"), { key: "Delete" });
    await waitFor(() => expect(sessionSurface("s2")).not.toBeNull());
    expect(window.location.hash).toBe("#/work/s2?cwd=%2Fp");
    await act(async () => pending.resolve({ id: "s1", cwd: "/obsolete", status: "ready", isStreaming: false }));
    expect(tabButton("s1")).toBeNull();
    expect(sessionSurface("s1")).toBeNull();
    expect(window.location.hash).toBe("#/work/s2?cwd=%2Fp");
  });

  it("updates background live titles and deletes that tab without stealing the selected root", async () => {
    multipleSessions();
    const handlers = new Map<string, Parameters<typeof api.connectSessionEvents>[1]>();
    vi.mocked(api.connectSessionEvents).mockImplementation((id, next) => {
      handlers.set(id, next);
      return vi.fn();
    });
    window.history.replaceState(null, "", "#/work/s1?cwd=%2Fp");
    const user = userEvent.setup();
    await renderWork();
    await user.click(tabButton("s2"));
    await waitFor(() => expect(handlers.has("s2")).toBe(true));
    act(() => handlers.get("s1")!.onEvent({ type: "session_info_changed", name: "Background title" }));
    await waitFor(() => expect(tabButton("s1")).toHaveAccessibleName("Background title"));
    expect(tabButton("s2")).toHaveAttribute("aria-selected", "true");
    act(() => handlers.get("s1")!.onEvent({ type: "session_deleted", sessionId: "s1" }));
    await waitFor(() => expect(tabButton("s1")).toBeNull());
    expect(window.location.hash).toBe("#/work/s2?cwd=%2Fp");
    expect(api.deleteSession).not.toHaveBeenCalled();
  });

  it("retains many bookmarks but gives the App work lease only the selected resolved cwd", async () => {
    multipleSessions();
    window.history.replaceState(null, "", "#/work/s1?cwd=%2Fp");
    const user = userEvent.setup();
    await renderWork();
    act(() =>
      configurationHandlers.onEvent({
        type: "config.updated",
        bootId: "boot-a",
        generation: 1,
        agentsChanged: true,
        modelsChanged: false,
        skillsChanged: false,
        runtimeChanged: false,
        projectWatchLeaseId: "tabs/lease",
      }),
    );
    await user.click(tabButton("s3"));
    await waitFor(() => expect(sessionSurface("s3")).not.toBeNull());
    await waitFor(() =>
      expect(configurationApi.replaceConfigurationProjectWatches).toHaveBeenLastCalledWith(
        "tabs/lease",
        expect.objectContaining({ cwds: ["/other"] }),
      ),
    );
    expect(sessionSurface("s1")).toBeInTheDocument();
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();
  });

  it("preserves the Settings draft and close guard when its host is deleted and the next root is loading", async () => {
    multipleSessions();
    let events: Parameters<typeof api.connectSessionEvents>[1] | undefined;
    vi.mocked(api.connectSessionEvents).mockImplementation((_id, handlers) => {
      events = handlers;
      return vi.fn();
    });
    window.history.replaceState(null, "", "#/work/s1?cwd=%2Fp");
    const user = userEvent.setup();
    await renderWork();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Network" }));
    const draft = await screen.findByRole("textbox", { name: "All traffic proxy" });
    fireEvent.change(draft, { target: { value: "http://draft.example" } });
    vi.mocked(api.openSession).mockReturnValueOnce(new Promise(() => {}));
    act(() => events!.onEvent({ type: "session_deleted", sessionId: "s1" }));
    await waitFor(() => expect(window.location.hash).toBe("#/work/s2?cwd=%2Fp&settings=1"));
    expect(screen.getByRole("textbox", { name: "All traffic proxy" })).toBe(draft);
    expect(draft).toHaveValue("http://draft.example");
    simulateBrowserBackTo("#/work/s2?cwd=%2Fp");
    expect(await screen.findByRole("dialog", { name: "Discard network changes?" })).toBeVisible();
    expect(window.location.hash).toBe("#/work/s2?cwd=%2Fp&settings=1");
  });

  it("offers workspace recovery on a direct Work URL and allows history-only deletion", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listStatus).mockResolvedValue(persisted);
    window.history.replaceState(null, "", "#/work/s1?cwd=%2Fp");
    vi.mocked(api.openSession).mockRejectedValueOnce(
      new api.ApiError(404, { code: "WORKSPACE_MISSING", cwd: "/p", error: "Folder missing" }),
    );
    vi.mocked(api.deleteWorkspace).mockImplementation(async () => {
      vi.mocked(api.listStatus).mockResolvedValue({ ...persisted, sessions: [] });
      return { cwd: "/p", sessionIds: ["s1"] };
    });
    render(<App />);
    const recovery = await screen.findByRole("dialog", { name: "Workspace folder not found" });
    expect(recovery).toHaveTextContent("/p");
    expect(within(recovery).getByRole("button", { name: "Choose new folder" })).toBeVisible();
    await user.click(within(recovery).getByRole("button", { name: "Delete workspace" }));
    const confirmation = screen.getByRole("dialog", { name: "Delete workspace" });
    expect(confirmation).toHaveTextContent("project files are kept");
    await user.click(within(confirmation).getByRole("button", { name: "Delete workspace" }));
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    expect(api.deleteWorkspace).toHaveBeenCalledWith("/p", false);
  });

  it("renders Home on an empty hash", async () => {
    render(<App />);
    expect(await screen.findByRole("region", { name: /research workspace/i })).toBeTruthy();
  });

  it("renders the single text-first Home surface by default", async () => {
    render(<App />);
    await screen.findByRole("region", { name: /research workspace/i });
    expect(screen.getByRole("heading", { name: "Research sessions" })).toBeVisible();
    expect(screen.queryByTestId("product-logo")).toBeNull();
    expect(screen.queryByText(/studio/i)).toBeNull();
  });

  it.each(["classic", "current", "studio"])(
    "recovers an old %s preference into the single Home surface",
    async (uiVersion) => {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ uiVersion, language: "en", studioTheme: "dark" }));
      try {
        render(<App />);
        expect(await screen.findByRole("region", { name: /research workspace/i })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Research sessions" })).toBeVisible();
        expect(document.documentElement.dataset.uiTheme).toBe("dark");
        expect(screen.queryByTestId("product-logo")).toBeNull();
      } finally {
        window.localStorage.clear();
      }
    },
  );

  it("opens canonical Settings over the still-mounted, inert Home context", async () => {
    const user = userEvent.setup();
    render(<App />);
    await workspace();
    const version = `v${packageJson.version}`;
    const versionNode = screen.getByText(version);
    expect(versionNode).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(window.location.hash).toBe("#/?settings=1");
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Appearance and language" })).toHaveFocus();
    expect(versionNode).toBeInTheDocument();
    const baseSurface = versionNode.closest("[data-app-surface]");
    expect(baseSurface).not.toBeNull();
    expect(baseSurface!).toHaveAttribute("inert");
    expect(baseSurface!).toHaveAttribute("aria-hidden", "true");
  });

  async function switchHomeTheme(studioTheme: "light" | "dark", via: "local" | "storage") {
    if (via === "storage") {
      await act(async () => {
        const prefs = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...prefs, language: "en", studioTheme }));
        window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
      });
    } else {
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Settings" }));
      await user.click(screen.getByRole("button", { name: studioTheme === "light" ? "Light" : "Dark" }));
      await user.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(window.location.hash).toBe("#/"));
    }
  }

  it.each(["local", "storage"] as const)("preserves Home workspace and query across %s theme switches", async (via) => {
    vi.mocked(api.listStatus).mockResolvedValue({
      ...persisted,
      sessions: [
        ...persisted.sessions,
        {
          ...persisted.sessions[0]!,
          id: "s2",
          path: "/store/s2.jsonl",
          cwd: "/other",
          firstMessage: "write another paper",
        },
        { ...persisted.sessions[0]!, id: "s3", path: "/store/s3.jsonl", firstMessage: "unrelated topic" },
      ],
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "/p" }));
    await user.type(screen.getByRole("searchbox"), "write");
    for (const theme of ["dark", "light"] as const) {
      await switchHomeTheme(theme, via);
      expect(screen.getByRole("searchbox")).toHaveValue("write");
      expect(screen.getByRole("button", { name: "/p" })).toHaveAttribute("aria-current", "true");
      expect(screen.getByText("write a paper")).toBeVisible();
      expect(screen.queryByText("write another paper")).toBeNull();
      expect(screen.queryByText("unrelated topic")).toBeNull();
    }
    expect(api.listStatus).toHaveBeenCalledOnce();
    expect(api.checkForUpdate).toHaveBeenCalledOnce();
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();
  });

  it.each(["local", "storage"] as const)(
    "retains pending Home creation across %s theme switches and reports only the current activation's failure",
    async (via) => {
      const request = deferred<Awaited<ReturnType<typeof api.createSession>>>();
      vi.mocked(api.listStatus).mockResolvedValue(persisted);
      vi.mocked(api.createSession).mockReturnValue(request.promise);
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole("button", { name: "New session /p" }));
      for (const theme of ["dark", "light"] as const) {
        await switchHomeTheme(theme, via);
        const create = screen.getByRole("button", { name: "New session /p" });
        expect(create).toBeDisabled();
        expect(screen.getByRole("button", { name: "New workspace" })).toBeDisabled();
        await user.click(create);
        expect(api.createSession).toHaveBeenCalledOnce();
      }
      await act(async () => request.reject(new Error("Create failed")));
      if (via === "storage") expect(await screen.findByRole("alert")).toHaveTextContent("Create failed");
      else expect(screen.queryByRole("alert")).toBeNull();
      await switchHomeTheme("dark", via);
      if (via === "storage") expect(screen.getByRole("alert")).toHaveTextContent("Create failed");
      else expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("button", { name: "New session /p" })).toBeEnabled();
    },
  );

  it("retains the Home delete dialog, pending guard and retry across cross-tab theme switches", async () => {
    const request = deferred<void>();
    vi.mocked(api.listStatus).mockResolvedValue(persisted);
    vi.mocked(api.deleteSession).mockReturnValueOnce(request.promise).mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Delete session: write a paper" }));
    const dialog = screen.getByRole("dialog", { name: "Delete session" });
    await switchHomeTheme("dark", "storage");
    expect(screen.getByRole("dialog", { name: "Delete session" })).toBe(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await switchHomeTheme("light", "storage");
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.submit(dialog);
    await user.keyboard("{Escape}");
    expect(api.deleteSession).toHaveBeenCalledOnce();
    expect(dialog).toBeInTheDocument();
    await act(async () => request.reject(new Error("Delete failed")));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Delete failed");
    await switchHomeTheme("dark", "storage");
    expect(screen.getByRole("dialog", { name: "Delete session" })).toBe(dialog);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Delete failed");
    vi.mocked(api.listStatus).mockResolvedValue({ ...persisted, sessions: [] });
    await user.click(within(dialog).getByRole("button", { name: "Retry deletion" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(api.deleteSession).toHaveBeenNthCalledWith(2, "s1", false);
    expect(screen.queryByText("write a paper")).toBeNull();
  });

  it("selects dark through Settings without an interface selector or a new configuration connection", async () => {
    const user = userEvent.setup();
    render(<App />);
    await workspace();
    await user.type(screen.getByRole("searchbox"), "research draft");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(within(dialog).queryByRole("group", { name: "Interface version" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /studio|classic|current/i })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Dark" }));
    expect(document.documentElement.dataset.uiTheme).toBe("dark");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({ studioTheme: "dark" });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).not.toHaveProperty("uiVersion");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("searchbox")).toHaveValue("research draft");
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();
    await switchHomeTheme("light", "storage");
    expect(document.documentElement.dataset.uiTheme).toBe("light");
    await switchHomeTheme("dark", "storage");
    expect(document.documentElement.dataset.uiTheme).toBe("dark");
    expect(screen.getByRole("searchbox")).toHaveValue("research draft");
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

  it("restores browser Back to Settings until a dirty Network draft is discarded", async () => {
    const user = userEvent.setup();
    render(<App />);
    await workspace();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("tab", { name: "Network" }));
    const draft = await screen.findByRole("textbox", { name: "All traffic proxy" });
    expect(draft).toBeVisible();
    expect(draft).toBeEnabled();
    fireEvent.change(draft, { target: { value: "http://draft.example" } });

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

    const general = await screen.findByRole("tab", { name: "Appearance and language" });
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
    const general = await screen.findByRole("tab", { name: "Appearance and language" });
    expect(general).toHaveFocus();
    await hydrateResolvedWork(result.container);

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
    await hydrateResolvedWork(result.container);
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
