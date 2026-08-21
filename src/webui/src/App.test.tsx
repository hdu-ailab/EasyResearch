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

describe("App routing", () => {
  afterEach(() => {
    window.location.hash = "";
  });

  beforeEach(() => {
    vi.mocked(api.listStatus).mockReset();
    vi.mocked(api.checkForUpdate).mockReset().mockResolvedValue({ latestVersion: null });
    vi.mocked(api.openSession).mockReset();
    vi.mocked(api.getSnapshot).mockReset();
    vi.mocked(api.connectSessionEvents).mockReset();
    vi.mocked(api.connectConfigurationEvents).mockReset();
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

  it("shows the package version only on the Home topbar", async () => {
    const user = userEvent.setup();
    render(<App />);
    await workspace();
    const version = `v${packageJson.version}`;
    expect(screen.getByText(version)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByText(/chat font size/i);
    expect(screen.queryByText(version)).toBeNull();
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

  it("opens the settings page from the Home topbar and records #/settings", async () => {
    const user = userEvent.setup();
    render(<App />);
    await workspace();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(window.location.hash).toBe("#/settings");
    expect(await screen.findByText(/chat font size/i)).toBeTruthy();
  });

  it("owns one configuration EventSource across page navigation and closes it on unmount", async () => {
    const user = userEvent.setup();
    const view = render(<App />);
    await workspace();
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByText(/chat font size/i);
    expect(api.connectConfigurationEvents).toHaveBeenCalledOnce();

    view.unmount();
    expect(disconnectConfiguration).toHaveBeenCalledOnce();
  });

  it("forwards accepted configuration generations to the mounted page", async () => {
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
    render(<App />);
    await workspace();
    await user.click(screen.getByRole("button", { name: "Settings" }));
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

  it("opens settings from the Work page topbar", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listStatus).mockResolvedValue(persisted);
    window.location.hash = "#/work/s1?cwd=%2Fp";
    await renderWork();
    await screen.findByText("starting research");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(window.location.hash).toBe("#/settings");
    expect(await screen.findByText(/chat font size/i)).toBeTruthy();
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
});
