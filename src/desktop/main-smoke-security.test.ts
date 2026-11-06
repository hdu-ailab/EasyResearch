import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { startDesktopSidecar, DesktopSidecarExit, DesktopSidecarHandle } from "./sidecar";
import * as mainSupport from "./main-support";
import * as smokeHost from "./smoke-host";
import { readDesktopPreferenceBlob, writeDesktopPreferenceBlob } from "./preferences-store";
import { STORAGE_KEY } from "../webui/src/preferences";

it.each([
  { scenario: "verified renderer", noSandbox: false, sandbox: true, noNewPrivs: 1, accepted: true },
  { scenario: "no-sandbox switch", noSandbox: true, sandbox: true, noNewPrivs: 1, accepted: false },
  { scenario: "unsandboxed preferences", noSandbox: false, sandbox: false, noNewPrivs: 1, accepted: false },
  { scenario: "missing kernel enforcement", noSandbox: false, sandbox: true, noNewPrivs: 0, accepted: false },
])("checks Linux renderer security only after the authenticated UI is ready: $scenario", async (fixture) => {
  const root = mkdtempSync(join(tmpdir(), "desktop-renderer-security-"));
  const eventsPath = join(root, "events.jsonl");
  const rendererPid = 4242;
  const hostPid = process.pid;
  let quit = false;
  let stopped = false;
  let uiChecks = 0;
  let rendererPreferenceWrites = 0;
  const project = join(root, "project");
  const descriptor = { id: "smoke-session", cwd: project, name: "Security fixture" };
  const transcriptUser = "Renderer security fixture prompt.";
  const initialPreferences = JSON.stringify({
    chatFontSize: 13, filesFontSize: 12, language: "en", studioTheme: "light",
    autoExpandThinking: false, autoExpandTools: false, expandSubagentOutput: false,
    sessionTabs: [descriptor],
  });
  writeDesktopPreferenceBlob(join(root, "user-data"), initialPreferences);
  const ipcMain = new EventEmitter();
  const restartPolling = vi.spyOn(globalThis, "setInterval");
  const clearPolling = vi.spyOn(globalThis, "clearInterval");
  let resolveUi!: (value: [boolean, boolean]) => void;
  const uiReady = new Promise<[boolean, boolean]>((resolve) => { resolveUi = resolve; });
  let resolveExit!: (exit: DesktopSidecarExit) => void;
  const exited = new Promise<DesktopSidecarExit>((resolve) => { resolveExit = resolve; });
  const handle: DesktopSidecarHandle = {
    pid: 4343,
    ready: {
      type: "desktop.ready", owner: "desktop", pid: 4343,
      origin: "http://127.0.0.1:43123", bootId: "smoke-boot", logPath: join(root, "sidecar.log"),
    },
    rendererToken: "fixture-renderer-token",
    exited,
    restartRequested: new Promise(() => {}),
    async shutdown() {
      stopped = true;
      resolveExit({ code: 0, signal: null });
    },
    forceTerminate() { throw new Error("Unexpected process signal"); },
    takeRestartTransition() { throw new Error("Unexpected restart transition"); },
  };
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    setAppUserModelId() {},
    getPath: () => join(root, "user-data"),
    getVersion: () => "1.2.3",
    commandLine: { hasSwitch: (name: string) => name === "no-sandbox" && fixture.noSandbox },
    quit() { quit = true; },
  });
  class Window extends EventEmitter {
    private destroyed = false;
    private url = "";
    webContents: EventEmitter & {
      session: { webRequest: { onBeforeSendHeaders(): void }; setPermissionRequestHandler(): void; setPermissionCheckHandler(): void };
      setWindowOpenHandler(): void;
      isDestroyed(): boolean;
      getURL(): string;
      getOSProcessId(): number;
      executeJavaScript(code: string): Promise<unknown>;
    };

    constructor(private readonly options: { webPreferences: Record<string, unknown> }) {
      super();
      const storage = new Map([[STORAGE_KEY, initialPreferences]]);
      const localStorage = {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
        removeItem: (key: string) => { storage.delete(key); },
      };
      // This host-boundary test models an already hydrated fixture document.
      // Real Work/resolver/DOM hydration is covered by the Web integration suite.
      const attributes = (values: Record<string, string>) => ({
        getAttribute: (name: string) => values[name] ?? null,
        hasAttribute: (name: string) => Object.hasOwn(values, name),
      });
      const tab = attributes({
        "data-session-tab-id": descriptor.id, role: "tab", "aria-selected": "true", "aria-label": descriptor.name,
      });
      const surface = {
        ...attributes({ "data-session-surface": descriptor.id, "data-session-active": "true" }),
        querySelector: (selector: string) => selector === "[data-chat-composer] textarea" ? { disabled: false } : null,
        querySelectorAll: (selector: string) => selector === '[data-message-body="user"]' ? [{ textContent: transcriptUser }] : [],
      };
      const document = {
        querySelector: (selector: string) => selector === "#root" ? { childElementCount: 1 } : null,
        querySelectorAll: (selector: string) => selector === "[data-session-tab-id]" ? [tab]
          : selector === "[data-session-surface]" ? [surface] : [],
      };
      this.webContents = Object.assign(new EventEmitter(), {
        session: { webRequest: { onBeforeSendHeaders() {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
        setWindowOpenHandler() {},
        isDestroyed: () => this.destroyed,
        getURL: () => this.url,
        getOSProcessId: () => rendererPid,
        executeJavaScript: async (code: string) => {
          const fetch = async (path: string) => {
            if (path !== "/api/status") throw new Error("Unexpected fixture renderer request");
            uiChecks++;
            const [, authenticated] = await uiReady;
            return { ok: authenticated };
          };
          // Execute the real serialized smoke probes rather than returning one
          // readiness tuple for unrelated renderer operations or mocking them out.
          return new Function("document", "fetch", "location", "localStorage", "window", `return ${code}`)(
            document, fetch, new URL(this.url), localStorage,
            { easyresearchDesktop: { persistWebUiPreferences: (raw: string | null) => {
              rendererPreferenceWrites++;
              ipcMain.emit(mainSupport.DESKTOP_PREFERENCES_WRITE_CHANNEL, { sender: this.webContents }, raw);
            } } },
          );
        },
      });
    }

    async loadURL(url: string) {
      this.url = url;
      if (this.options.webPreferences.preload) {
        queueMicrotask(() => this.webContents.emit("did-finish-load"));
      }
    }
    show() {}
    hide() {}
    focus() {}
    destroy() { this.destroyed = true; }
    isDestroyed() { return this.destroyed; }
  }
  class Tray extends EventEmitter {
    setToolTip() {}
    setContextMenu() {}
    destroy() {}
  }
  const events = (): Array<Record<string, unknown>> => existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  vi.stubGlobal("process", {
    ...process,
    platform: "linux",
    resourcesPath: join(root, "app"),
    env: {
      HOME: root,
      EASYRESEARCH_CODING_AGENT_DIR: join(root, "agent"),
      EASYRESEARCH_DESKTOP_SMOKE_DIR: root,
      EASYRESEARCH_DESKTOP_SMOKE_PROJECT: project,
      EASYRESEARCH_DESKTOP_SMOKE_SESSION_PATH: join(root, "session.jsonl"),
      EASYRESEARCH_DESKTOP_SMOKE_AGENT: "smoke-agent",
      EASYRESEARCH_DESKTOP_SMOKE_PROXY: "http://127.0.0.1:43210",
    },
  });
  vi.doMock("electron", () => ({
    app, BrowserWindow: Window, Tray, ipcMain,
    Menu: { buildFromTemplate: (items: unknown) => items },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    dialog: { showMessageBox: async () => ({ response: 1 }), showErrorBox() {} },
    shell: { openExternal: async () => {}, showItemInFolder() {} },
  }));
  vi.doMock("./update", () => ({ checkDesktopUpdate: async () => undefined }));
  vi.doMock("./smoke-work-files", () => ({
    verifyDesktopSmokeWorkFiles: async () => ({ type: "desktop-smoke.work-files-verified" }),
  }));
  vi.doMock("./main-support", () => ({
    ...mainSupport,
    desktopWindowOptions: (...args: Parameters<typeof mainSupport.desktopWindowOptions>) => {
      const options = mainSupport.desktopWindowOptions(...args);
      return { ...options, webPreferences: { ...options.webPreferences, sandbox: fixture.sandbox } };
    },
  }));
  vi.doMock("./sidecar", () => ({
    startDesktopSidecar: async (options: Parameters<typeof startDesktopSidecar>[0]) => {
      options.onSpawned?.(handle);
      return handle;
    },
  }));
  vi.doMock("./smoke-host", () => ({
    ...smokeHost,
    desktopSmokeLinuxRendererSecurityEvent: (
      options: Parameters<typeof smokeHost.desktopSmokeLinuxRendererSecurityEvent>[0],
    ) => smokeHost.desktopSmokeLinuxRendererSecurityEvent({
      ...options,
      readFile: (path) => {
        if (path !== `/proc/${rendererPid}/status`) throw new Error("Unexpected renderer status identity");
        return `NoNewPrivs:\t${fixture.noNewPrivs}\nSeccomp:\t2\n`;
      },
      readLink: (path) => {
        if (path === `/proc/${rendererPid}/ns/pid`) return "pid:[4026533001]";
        if (path === `/proc/${hostPid}/ns/pid`) return "pid:[4026531836]";
        throw new Error("Unexpected namespace identity");
      },
    }),
    prepareDesktopSmokeWork: async (
      options: Parameters<typeof smokeHost.prepareDesktopSmokeWork>[0],
    ): Promise<Awaited<ReturnType<typeof smokeHost.prepareDesktopSmokeWork>>> => {
      options.onStateVisible?.();
      return { sessionId: descriptor.id, bootId: "smoke-boot", transcriptUser };
    },
  }));
  vi.resetModules();
  try {
    await import("./main");
    await vi.waitFor(() => expect(uiChecks).toBeGreaterThan(0));
    expect(events().map((event) => event.type)).toEqual(["desktop-smoke.sidecar-ready"]);
    resolveUi([true, true]);

    if (fixture.accepted) {
      await vi.waitFor(() => expect(events()).toContainEqual({ type: "desktop-smoke.window-loaded" }));
      // Restart polling is armed only after the real tab fixture's stable
      // renderer/IPC/disk verification finishes. Own that work before teardown.
      await vi.waitFor(() => {
        expect(events().filter((event) => event.type === "desktop-smoke.failure")).toEqual([]);
        expect(restartPolling).toHaveBeenCalled();
      }, { timeout: 3_000 });
      const observed = events();
      expect(observed.filter((event) => event.type === "desktop-smoke.failure")).toEqual([]);
      expect(observed).toContainEqual({
        type: "desktop-smoke.renderer-security",
        osSandboxed: true, sandbox: true, contextIsolation: true, nodeIntegration: false,
      });
      expect(observed.findIndex((event) => event.type === "desktop-smoke.renderer-security"))
        .toBeLessThan(observed.findIndex((event) => event.type === "desktop-smoke.window-loaded"));
      expect(stopped).toBe(false);
      expect(quit).toBe(false);
      expect(rendererPreferenceWrites).toBe(1);
      const saved = JSON.parse(readDesktopPreferenceBlob(join(root, "user-data"))!) as { sessionTabs: Array<{ id: string; cwd: string; name?: string }> };
      expect(saved.sessionTabs.at(-1)).toEqual(descriptor);
      expect(saved.sessionTabs[0]?.id).not.toBe(descriptor.id);
      expect(saved.sessionTabs[0]?.cwd).toBe(project);
    } else {
      await vi.waitFor(() => expect(events()).toContainEqual(expect.objectContaining({
        type: "desktop-smoke.failure", message: expect.stringMatching(/renderer.*(?:security|sandbox)/i),
      })));
      await vi.waitFor(() => expect(quit).toBe(true));
      expect(stopped).toBe(true);
      expect(events().map((event) => event.type)).not.toContain("desktop-smoke.renderer-security");
      expect(events().map((event) => event.type)).not.toContain("desktop-smoke.window-loaded");
      expect(rendererPreferenceWrites).toBe(0);
      expect(restartPolling).not.toHaveBeenCalled();
    }
  } finally {
    resolveUi([true, true]);
    app.emit("before-quit", { preventDefault() {} });
    await vi.waitFor(() => expect(quit).toBe(true));
    const pollingHandle = restartPolling.mock.results[0]?.value;
    if (pollingHandle !== undefined) expect(clearPolling).toHaveBeenCalledWith(pollingHandle);
    restartPolling.mockRestore();
    clearPolling.mockRestore();
    for (const name of ["electron", "./update", "./main-support", "./sidecar", "./smoke-host", "./smoke-work-files"]) vi.doUnmock(name);
    vi.resetModules();
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  }
});
