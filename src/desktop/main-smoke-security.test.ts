import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { startDesktopSidecar, DesktopSidecarExit, DesktopSidecarHandle } from "./sidecar";
import * as mainSupport from "./main-support";
import * as smokeHost from "./smoke-host";

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
      session: { webRequest: { onBeforeSendHeaders(): void }; setPermissionRequestHandler(): void };
      setWindowOpenHandler(): void;
      getURL(): string;
      getOSProcessId(): number;
      executeJavaScript(): Promise<[boolean, boolean]>;
    };

    constructor(private readonly options: { webPreferences: Record<string, unknown> }) {
      super();
      this.webContents = Object.assign(new EventEmitter(), {
        session: { webRequest: { onBeforeSendHeaders() {} }, setPermissionRequestHandler() {} },
        setWindowOpenHandler() {},
        getURL: () => this.url,
        getOSProcessId: () => rendererPid,
        executeJavaScript: () => {
          uiChecks++;
          return uiReady;
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
      EASYRESEARCH_DESKTOP_SMOKE_PROJECT: join(root, "project"),
      EASYRESEARCH_DESKTOP_SMOKE_SESSION_PATH: join(root, "session.jsonl"),
      EASYRESEARCH_DESKTOP_SMOKE_AGENT: "smoke-agent",
      EASYRESEARCH_DESKTOP_SMOKE_PROXY: "http://127.0.0.1:43210",
    },
  });
  vi.doMock("electron", () => ({
    app, BrowserWindow: Window, Tray, ipcMain: new EventEmitter(),
    Menu: { buildFromTemplate: (items: unknown) => items },
    nativeImage: { createFromDataURL: () => ({ isEmpty: () => false }) },
    dialog: { showMessageBox: async () => ({ response: 1 }), showErrorBox() {} },
    shell: { openExternal: async () => {}, showItemInFolder() {} },
  }));
  vi.doMock("./update", () => ({ checkDesktopUpdate: async () => undefined }));
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
    prepareDesktopSmokeWork: async () => ({ sessionId: "smoke-session", bootId: "smoke-boot" }),
  }));
  vi.resetModules();
  try {
    await import("./main");
    await vi.waitFor(() => expect(uiChecks).toBeGreaterThan(0));
    expect(events().map((event) => event.type)).toEqual(["desktop-smoke.sidecar-ready"]);
    resolveUi([true, true]);

    if (fixture.accepted) {
      await vi.waitFor(() => expect(events()).toContainEqual({ type: "desktop-smoke.window-loaded" }));
      const observed = events();
      expect(observed).toContainEqual({
        type: "desktop-smoke.renderer-security",
        osSandboxed: true, sandbox: true, contextIsolation: true, nodeIntegration: false,
      });
      expect(observed.findIndex((event) => event.type === "desktop-smoke.renderer-security"))
        .toBeLessThan(observed.findIndex((event) => event.type === "desktop-smoke.window-loaded"));
      expect(stopped).toBe(false);
      expect(quit).toBe(false);
    } else {
      await vi.waitFor(() => expect(events()).toContainEqual(expect.objectContaining({
        type: "desktop-smoke.failure", message: expect.stringMatching(/renderer.*(?:security|sandbox)/i),
      })));
      await vi.waitFor(() => expect(quit).toBe(true));
      expect(stopped).toBe(true);
      expect(events().map((event) => event.type)).not.toContain("desktop-smoke.renderer-security");
      expect(events().map((event) => event.type)).not.toContain("desktop-smoke.window-loaded");
    }
  } finally {
    resolveUi([true, true]);
    app.emit("before-quit", { preventDefault() {} });
    await vi.waitFor(() => expect(quit).toBe(true));
    for (const name of ["electron", "./update", "./main-support", "./sidecar", "./smoke-host"]) vi.doUnmock(name);
    vi.resetModules();
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  }
});
