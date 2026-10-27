import type { Session, WebContents } from "electron";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { acquireTransitionLease, adoptTransitionLease, transitionLeasePath } from "../cli/runtime-lease";
import { resolveDesktopEnvironment, resolvePackagedSidecar } from "./environment";
import { startDesktopSidecar } from "./sidecar";

it.each([200, 503])("uses the shell-resolved root for desktop custody and child environment when health returns %s", async (healthStatus) => {
  const root = mkdtempSync(join(tmpdir(), "desktop-main-launch-"));
  const hostRoot = join(root, "host-agent");
  const shellRoot = join(root, "shell-agent");
  const hostToken = "h".repeat(43);
  const lease = await acquireTransitionLease(shellRoot, "desktop");
  const handoff = lease.reserveHandoff(hostToken);
  handoff.commit(process.pid);
  handoff.relinquish();
  const child = Object.assign(new EventEmitter(), {
    pid: 4242, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null,
    kill: () => { throw new Error("Unexpected process signal"); },
  });
  child.stdin.once("finish", () => {
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  let quit = false;
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    setAppUserModelId: () => {},
    getPath: () => join(root, "user-data"),
    getVersion: () => "1.2.3",
    quit: () => { quit = true; },
  });
  let permissionRequest: NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]> | undefined;
  let permissionCheck: NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]> | undefined;
  let permissionWindow: Window | undefined;
  class Window extends EventEmitter {
    url = "";
    destroyed = false;
    rendererDestroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      session: {
        webRequest: { onBeforeSendHeaders() {} },
        setPermissionRequestHandler: (handler: Parameters<Session["setPermissionRequestHandler"]>[0]) => {
          permissionRequest = handler ?? undefined;
          permissionWindow = this;
        },
        setPermissionCheckHandler: (handler: Parameters<Session["setPermissionCheckHandler"]>[0]) => {
          permissionCheck = handler ?? undefined;
        },
      },
      setWindowOpenHandler() {},
      getURL: () => this.url,
      isDestroyed: () => this.rendererDestroyed,
    });
    loadURL = async (url: string) => { this.url = url; };
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
  let spawnedEnv: NodeJS.ProcessEnv | undefined;
  let hostAgentDir: string | undefined;
  let startupSettled = false;
  let accepted = false;
  vi.stubGlobal("process", {
    ...process,
    env: { HOME: root, EASYRESEARCH_CODING_AGENT_DIR: hostRoot },
    platform: "darwin",
    resourcesPath: join(root, "app"),
  });
  vi.doMock("electron", () => ({
    app, BrowserWindow: Window, Tray, ipcMain: new EventEmitter(),
    Menu: { buildFromTemplate: (items: unknown) => items },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, setTemplateImage() {} }) },
    dialog: { showMessageBox: async () => ({ response: 1 }), showErrorBox() {} },
    shell: { openExternal: async () => {}, showItemInFolder() {} },
  }));
  vi.doMock("./environment", () => ({
    resolvePackagedSidecar,
    resolveDesktopEnvironment: () => resolveDesktopEnvironment({ HOME: root, PATH: "/usr/bin:/bin" }, "darwin", {
      runShell: () => ({ status: 0, stdout: `EASYRESEARCH_CODING_AGENT_DIR=${shellRoot}\0PATH=/login/bin:/usr/bin:/bin\0`, stderr: "" }),
    }),
  }));
  vi.doMock("./update", () => ({ checkDesktopUpdate: async () => undefined }));
  vi.doMock("./sidecar", () => ({
    startDesktopSidecar: async (options: Parameters<typeof startDesktopSidecar>[0]) => {
      hostAgentDir = options.agentDir;
      try {
        const handle = await startDesktopSidecar({
          ...options,
          createHostTransitionToken: () => hostToken,
          spawn: (_command, _args, spawnOptions) => {
            spawnedEnv = spawnOptions.env;
            queueMicrotask(() => child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log","bootId":"fixture-boot"}\n'));
            return child as never;
          },
          fetch: async () => new Response("{}", { status: healthStatus }),
          killProcess: () => { throw new Error("Unexpected process signal"); },
          startupTimeoutMs: 1_000, shutdownTimeoutMs: 100,
        });
        accepted = true;
        return handle;
      } finally {
        startupSettled = true;
      }
    },
  }));
  vi.resetModules();
  try {
    await import("./main");
    await vi.waitFor(() => expect(startupSettled).toBe(true));
    expect(hostAgentDir).toBe(shellRoot);
    expect(spawnedEnv?.EASYRESEARCH_CODING_AGENT_DIR).toBe(hostAgentDir);
    expect(spawnedEnv?.PATH).toBe("/login/bin:/usr/bin:/bin");
    expect(accepted).toBe(healthStatus === 200);
    expect(existsSync(transitionLeasePath(shellRoot))).toBe(false);
    expect(existsSync(transitionLeasePath(hostRoot))).toBe(false);
    if (healthStatus === 200) {
      await vi.waitFor(() => {
        expect(permissionRequest).toBeTypeOf("function");
        expect(permissionCheck).toBeTypeOf("function");
        expect(permissionWindow?.url).toBe("http://127.0.0.1:43123/#/");
      });
      const window = permissionWindow!;
      const owner = window.webContents as unknown as WebContents;
      const origin = "http://127.0.0.1:43123";
      const details = { isMainFrame: true, requestingUrl: `${origin}/` };
      const request = (
        contents: WebContents,
        permission: Parameters<NonNullable<typeof permissionRequest>>[1],
        source = details,
      ) => {
        const callback = vi.fn();
        permissionRequest!(contents, permission, callback, source);
        expect(callback).toHaveBeenCalledOnce();
        return callback.mock.calls[0]![0];
      };
      for (const permission of ["fullscreen", "clipboard-sanitized-write"] as const) {
        expect(request(owner, permission)).toBe(true);
        expect(permissionCheck!(owner, permission, origin, details)).toBe(true);
        expect(request(owner, permission, { ...details, isMainFrame: false })).toBe(false);
        expect(permissionCheck!(owner, permission, origin, { ...details, isMainFrame: false })).toBe(false);
        const foreign = { getURL: () => window.url } as WebContents;
        expect(request(foreign, permission)).toBe(false);
        expect(permissionCheck!(foreign, permission, origin, details)).toBe(false);
        expect(permissionCheck!(null, permission, origin, details)).toBe(false);
        expect(permissionCheck!(owner, permission, "null", details)).toBe(false);
        expect(permissionCheck!(owner, permission, "http://127.0.0.1:43124", details)).toBe(false);
        expect(permissionCheck!(owner, permission, origin, { isMainFrame: true })).toBe(false);

        window.url = `${origin}/index.html#/work/session`;
        expect(request(owner, permission)).toBe(false);
        expect(permissionCheck!(owner, permission, origin, details)).toBe(false);
        const index = { ...details, requestingUrl: `${origin}/index.html` };
        expect(request(owner, permission, index)).toBe(true);
        expect(permissionCheck!(owner, permission, origin, index)).toBe(true);
        window.url = `${origin}/api/file/preview/scope/report.html`;
        const preview = { ...details, requestingUrl: window.url };
        expect(request(owner, permission, preview)).toBe(false);
        expect(permissionCheck!(owner, permission, origin, preview)).toBe(false);
        window.url = `${origin}/#/`;

        window.rendererDestroyed = true;
        expect(request(owner, permission)).toBe(false);
        expect(permissionCheck!(owner, permission, origin, details)).toBe(false);
        window.rendererDestroyed = false;
        window.destroyed = true;
        expect(request(owner, permission)).toBe(false);
        expect(permissionCheck!(owner, permission, origin, details)).toBe(false);
        window.destroyed = false;
      }
      for (const permission of ["clipboard-read", "media", "notifications"] as const) {
        expect(request(owner, permission)).toBe(false);
        expect(permissionCheck!(owner, permission, origin, details)).toBe(false);
      }
      expect(permissionCheck!(owner, "deprecated-sync-clipboard-read", origin, details)).toBe(false);
    }
  } finally {
    app.emit("before-quit", { preventDefault() {} });
    await vi.waitFor(() => expect(quit).toBe(true));
    if (permissionWindow && permissionCheck && permissionRequest) {
      const owner = permissionWindow.webContents as unknown as WebContents;
      const details = { isMainFrame: true, requestingUrl: "http://127.0.0.1:43123/" };
      // Terminal ownership, not only a destroyed BrowserWindow, revokes grants.
      permissionWindow.destroyed = false;
      expect(permissionCheck(owner, "fullscreen", "http://127.0.0.1:43123", details)).toBe(false);
      const callback = vi.fn();
      permissionRequest(owner, "clipboard-sanitized-write", callback, details);
      expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    }
    if (existsSync(transitionLeasePath(shellRoot))) {
      adoptTransitionLease(shellRoot, "desktop", process.pid, hostToken).release();
    }
    for (const name of ["electron", "./environment", "./update", "./sidecar"]) vi.doUnmock(name);
    vi.resetModules();
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  }
});
