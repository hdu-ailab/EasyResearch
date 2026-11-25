import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_UPDATE_OPEN_CHANNEL, DESKTOP_UPDATE_OPEN_READY_CHANNEL, DESKTOP_UPDATE_SNAPSHOT_CHANNEL } from "./contracts";
import type { DesktopReadyEvent, DesktopRestartRequestedEvent } from "./contracts";
import type { DesktopSidecarExit, DesktopSidecarHandle, startDesktopSidecar } from "./sidecar";
import type { RuntimeLease } from "../cli/runtime-lease";
import { LATEST_RELEASE_PAGE, type UpdateSnapshot } from "../runtime/update-contract";
import type { DesktopUpdateOptions } from "./update";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const hosts: Array<{ root: string; app: EventEmitter & { quit(): void } }> = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    host.app.emit("before-quit", { preventDefault() {} });
    await vi.waitFor(() => expect(host.app.quit).toHaveBeenCalled());
    rmSync(host.root, { recursive: true, force: true });
  }
  for (const name of ["electron", "./sidecar", "./environment", "./update", "./update-custodian"]) vi.doUnmock(name);
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function createHost(recovery = false) {
  const root = mkdtempSync(join(tmpdir(), "desktop-presentation-"));
  const handlers = new Map<string, (event: unknown) => unknown>();
  const ipc = Object.assign(new EventEmitter(), { handle: vi.fn((channel: string, handler) => { handlers.set(channel, handler); }) });
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    setAppUserModelId() {},
    getPath: () => join(root, "user-data"),
    getAppPath: () => join(root, "installed", "app.asar"),
    getVersion: () => "1.2.3",
    quit: vi.fn(),
  });
  const windows: Window[] = [];
  class Window extends EventEmitter {
    destroyed = false;
    url = "";
    loaded = deferred<void>();
    show = vi.fn();
    hide = vi.fn();
    focus = vi.fn();
    restore = vi.fn();
    isMinimized = () => false;
    isDestroyed = () => this.destroyed;
    readonly send = vi.fn();
    webContents: EventEmitter & {
      mainFrame: { url: string; send: ReturnType<typeof vi.fn> };
      getURL(): string;
      isDestroyed(): boolean;
      session: {
        webRequest: { onBeforeSendHeaders(): void };
        setPermissionRequestHandler(): void;
        setPermissionCheckHandler(): void;
      };
      setWindowOpenHandler(): void;
    };
    constructor(readonly options: { show: boolean; webPreferences: Record<string, unknown> }) {
      super();
      windows.push(this);
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: "", send: this.send },
        getURL: () => this.url,
        isDestroyed: () => this.destroyed,
        session: {
          webRequest: { onBeforeSendHeaders() {} },
          setPermissionRequestHandler() {},
          setPermissionCheckHandler() {},
        },
        setWindowOpenHandler() {},
      });
    }
    loadURL(url: string) {
      this.webContents.emit("did-start-navigation", {}, url, false, true);
      this.url = url;
      this.webContents.mainFrame = { url, send: this.send };
      return this.loaded.promise;
    }
    finishLoad() {
      this.webContents.emit("did-finish-load");
      this.loaded.resolve();
    }
    destroy() {
      this.destroyed = true;
      this.webContents.emit("destroyed");
      this.emit("closed");
      this.loaded.resolve();
    }
  }
  let menu: Array<{ label?: string; click?: () => void }> = [];
  class Tray extends EventEmitter {
    setToolTip() {}
    setContextMenu(items: typeof menu) { menu = items; }
    destroy() {}
  }
  const message = vi.fn(async () => ({ response: 1 }));
  const errorBox = vi.fn();
  const state: UpdateSnapshot = {
    revision: 0, operationId: null, owner: "desktop", phase: "idle",
    currentVersion: "1.2.3", latestVersion: null, canDownload: false, canInstall: false,
    canActivate: false, canCancel: false, releaseUrl: LATEST_RELEASE_PAGE,
  };
  const action = vi.fn(async () => ({ ...state }));
  const launches: Array<{
    options: Parameters<typeof startDesktopSidecar>[0];
    handle: DesktopSidecarHandle;
    complete(): void;
    fail(error: unknown): void;
    restart(): void;
    crash(): void;
  }> = [];
  vi.stubGlobal("process", {
    ...process, platform: "linux", resourcesPath: join(root, "resources"),
    env: { HOME: root, EASYRESEARCH_CODING_AGENT_DIR: join(root, "agent") },
  });
  vi.doMock("electron", () => ({
    app, BrowserWindow: Window, Tray, ipcMain: ipc,
    Menu: { buildFromTemplate: (items: unknown) => items, setApplicationMenu() {} },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    net: { fetch: vi.fn() },
    dialog: { showMessageBox: message, showErrorBox: errorBox },
    shell: { openExternal: vi.fn(async () => {}), showItemInFolder: vi.fn() },
  }));
  vi.doMock("./environment", () => ({
    resolveDesktopEnvironment: (env: NodeJS.ProcessEnv) => ({ ...env }),
    resolvePackagedSidecar: () => join(root, "resources", "sidecar", "easyresearch"),
  }));
  vi.doMock("./update", async (original) => ({
    ...await original<typeof import("./update")>(),
    createDesktopUpdateController: (options: DesktopUpdateOptions) => {
      if (options.recoveredInstallationFailure) {
        state.phase = "failed";
        state.message = "Installation failed. Open latest Release.";
      }
      return { action, snapshot: () => ({ ...state }), subscribe: () => () => {}, close: async () => {} };
    },
  }));
  vi.doMock("./update-custodian", async (original) => ({
    ...await original<typeof import("./update-custodian")>(),
    desktopUpdateRecovery: async () => recovery,
  }));
  vi.doMock("./sidecar", () => ({
    startDesktopSidecar: (options: Parameters<typeof startDesktopSidecar>[0]) => {
      const launch = deferred<DesktopSidecarHandle>();
      const exit = deferred<DesktopSidecarExit>();
      const restart = deferred<DesktopRestartRequestedEvent>();
      const number = launches.length + 1;
      const ready: DesktopReadyEvent = {
        type: "desktop.ready", owner: "desktop", pid: 4000 + number,
        origin: `http://127.0.0.1:${43000 + number}`, bootId: `boot-${number}`,
        logPath: join(root, `sidecar-${number}.log`),
      };
      let completed = false;
      let held = true;
      const transition = { get held() { return held; }, release() { held = false; return true; } } as RuntimeLease;
      const handle: DesktopSidecarHandle = {
        pid: ready.pid, ready, rendererToken: `credential-${number}`,
        exited: exit.promise, restartRequested: restart.promise,
        shutdown: vi.fn(async () => {
          exit.resolve({ code: 0, signal: null });
          if (!completed) launch.reject(new Error("Startup cancelled"));
        }),
        forceTerminate: vi.fn(),
        takeRestartTransition: () => transition,
        updateActivity: async () => ({ code: "RUNTIME_BUSY", activeSessions: 0, authFlowActive: false }),
        prepareUpdate: async () => ({ ok: true }),
      };
      launches.push({
        options, handle,
        complete() { completed = true; launch.resolve(handle); },
        fail(error) { launch.reject(error); },
        restart() {
          const event: DesktopRestartRequestedEvent = { type: "desktop.restart-requested", bootId: ready.bootId };
          restart.resolve(event);
          exit.resolve({ code: 0, signal: null, expectedRestart: event });
        },
        crash() { exit.resolve({ code: 1, signal: null }); },
      });
      options.onSpawned?.(handle);
      return launch.promise;
    },
  }));
  vi.resetModules();
  await import("./main");
  const host = {
    root, app, ipc, windows, launches, action, state, message, errorBox,
    tray(label: string) {
      const item = menu.find(item => item.label === label);
      expect(item?.click).toBeTypeOf("function");
      item!.click!();
    },
    subscribe(window: Window) {
      ipc.emit(DESKTOP_UPDATE_OPEN_READY_CHANNEL, { sender: window.webContents, senderFrame: window.webContents.mainFrame }, true);
    },
    snapshot(window: Window) {
      return handlers.get(DESKTOP_UPDATE_SNAPSHOT_CHANNEL)!({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
    },
    async load(index = launches.length - 1) {
      launches[index]!.complete();
      await vi.waitFor(() => expect(windows).toHaveLength(index + 1));
      return windows[index]!;
    },
  };
  hosts.push(host);
  await vi.waitFor(() => expect(launches).toHaveLength(1));
  return host;
}

describe("desktop normal window and shared update presentation", () => {
  it("logs setup without a popup, keeps the main window hidden until load, and queues tray intent until subscription", async () => {
    const host = await createHost();
    host.launches[0]!.options.onSetup?.("Creating the skill environment...");
    expect(host.windows).toHaveLength(0);
    expect(readFileSync(join(host.root, "user-data", "logs", "desktop.log"), "utf8"))
      .toContain("Desktop sidecar setup: Creating the skill environment...");
    host.tray("Check for Updates");
    host.tray("Check for Updates");
    host.tray("Open EasyResearch");
    const window = await host.load();
    expect(window.options.show).toBe(false);
    expect(window.options.webPreferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true });
    host.tray("Open EasyResearch");
    expect(window.show).not.toHaveBeenCalled();
    window.finishLoad();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.send).not.toHaveBeenCalled();
    host.subscribe(window);
    expect(window.send).toHaveBeenCalledExactlyOnceWith(DESKTOP_UPDATE_OPEN_CHANNEL, "check");
    expect(host.action).not.toHaveBeenCalled();
    expect(host.message).not.toHaveBeenCalled();

    host.state.phase = "installing";
    host.tray("Check for Updates");
    expect(window.send).toHaveBeenLastCalledWith(DESKTOP_UPDATE_OPEN_CHANNEL, "check");
    expect(host.action).not.toHaveBeenCalled();
  });

  it("Exit remains available during setup and settles the owned launch without showing a window", async () => {
    const host = await createHost();
    host.tray("Check for Updates");
    host.tray("Exit");
    await vi.waitFor(() => expect(host.app.quit).toHaveBeenCalledOnce());
    expect(host.launches[0]!.handle.shutdown).toHaveBeenCalled();
    expect(host.windows).toHaveLength(0);
    expect(host.message).not.toHaveBeenCalled();
    expect(host.errorBox).not.toHaveBeenCalled();
  });

  it("keeps startup failure actionable without creating a Web or loading window", async () => {
    const host = await createHost();
    host.launches[0]!.fail(new Error("Fixture startup failure"));
    await vi.waitFor(() => expect(host.message).toHaveBeenCalled());
    expect(host.windows).toHaveLength(0);
    expect(host.message).toHaveBeenCalledWith(expect.objectContaining({
      title: "EasyResearch could not start", buttons: ["Retry", "Quit"],
      detail: expect.stringContaining(join(host.root, "user-data", "logs", "desktop.log")),
    }));
  });

  it("queues recovery ahead of checks and never starts an automatic check over the notice", async () => {
    const host = await createHost(true);
    host.tray("Check for Updates");
    const window = await host.load();
    host.subscribe(window);
    expect(window.send).not.toHaveBeenCalled();
    window.finishLoad();
    expect(window.send).toHaveBeenCalledExactlyOnceWith(DESKTOP_UPDATE_OPEN_CHANNEL, "recovery");
    expect(await host.snapshot(window)).toMatchObject({ phase: "failed", message: "Installation failed. Open latest Release." });
    expect(host.action).not.toHaveBeenCalled();
    expect(host.message).not.toHaveBeenCalled();
  });

  it("revokes the old document during expected restart and delivers only to the loaded successor subscriber", async () => {
    const host = await createHost();
    const oldWindow = await host.load();
    oldWindow.finishLoad();
    host.subscribe(oldWindow);
    await vi.waitFor(() => expect(host.action).toHaveBeenCalledOnce());
    const oldFrame = oldWindow.webContents.mainFrame;
    host.launches[0]!.restart();
    await vi.waitFor(() => expect(host.launches).toHaveLength(2));
    expect(host.windows).toHaveLength(1);
    expect(oldWindow.hide).toHaveBeenCalled();
    host.tray("Check for Updates");
    const nextWindow = await host.load();
    expect(oldWindow.destroyed).toBe(true);
    expect(nextWindow.show).not.toHaveBeenCalled();
    host.ipc.emit(DESKTOP_UPDATE_OPEN_READY_CHANNEL, { sender: oldWindow.webContents, senderFrame: oldFrame }, true);
    expect(oldWindow.send).not.toHaveBeenCalled();
    host.subscribe(nextWindow);
    expect(nextWindow.send).not.toHaveBeenCalled();
    nextWindow.finishLoad();
    expect(nextWindow.send).toHaveBeenCalledExactlyOnceWith(DESKTOP_UPDATE_OPEN_CHANNEL, "check");
    expect(host.action).toHaveBeenCalledTimes(1);
    expect(host.message).not.toHaveBeenCalled();
  });

  it("retains native crash recovery when the old application surface is unavailable", async () => {
    const host = await createHost();
    const window = await host.load();
    window.finishLoad();
    host.subscribe(window);
    host.message.mockResolvedValue({ response: 2 });
    host.launches[0]!.crash();
    await vi.waitFor(() => expect(host.message).toHaveBeenCalled());
    expect(window.hide).toHaveBeenCalled();
    expect(host.message).toHaveBeenCalledWith(window, expect.objectContaining({
      title: "EasyResearch stopped", buttons: ["Restart", "Open Logs", "Quit"],
    }));
    expect(host.windows).toHaveLength(1);
  });
});
