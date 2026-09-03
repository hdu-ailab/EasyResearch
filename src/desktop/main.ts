import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
  type IpcMainEvent,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
} from "electron";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { defaultAgentDir } from "../runtime/bundled-assets";
import type { RuntimeLease } from "../cli/runtime-lease";
import {
  beginDesktopExit,
  createDesktopSidecarOwnership,
  createDesktopLifecycleState,
  monitorDesktopSidecarLifecycle,
  prepareDesktopSidecarLaunch,
  type DesktopLifecycleState,
} from "./lifecycle";
import {
  captureDesktopRestartHash,
  createTrayMenuTemplate,
  DESKTOP_HOST_VERSION_CHANNEL,
  DESKTOP_PREFERENCES_READ_CHANNEL,
  DESKTOP_PREFERENCES_WRITE_CHANNEL,
  DESKTOP_SESSION_PARTITION,
  desktopWindowOptions,
  handleMainWindowClose,
  isCurrentDesktopDocument,
  renderLoadingDocument,
  TRAY_ICON_DATA_URL,
} from "./main-support";
import {
  readDesktopPreferenceBlob,
  writeDesktopPreferenceBlob,
} from "./preferences-store";
import {
  desktopRequestHeaders,
  navigationDecision,
} from "./security";
import {
  resolveDesktopEnvironment,
  resolvePackagedSidecar,
} from "./environment";
import {
  startDesktopSidecar,
  type DesktopSidecarHandle,
  type DesktopSidecarProcessHandle,
} from "./sidecar";
import { checkDesktopUpdate, type DesktopReleaseUpdate } from "./update";
import {
  desktopSmokeSidecarReadyEvent,
  desktopSmokeRestartFailureEvent,
  desktopSmokeWorkHash,
  isDesktopSmokeRestoredWorkDocument,
  prepareDesktopSmokeWork,
  requestDesktopSmokeRestart,
  verifyDesktopSmokeSuccessor,
} from "./smoke-host";
import { DESKTOP_SMOKE_USER_DATA_ENV } from "./contracts";

configureSmokeUserData();
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let mainWindow: BrowserWindow | undefined;
let loadingWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let sidecar: DesktopSidecarHandle | undefined;
const sidecarOwnership = createDesktopSidecarOwnership();
let lifecycle: DesktopLifecycleState = createDesktopLifecycleState();
let startAttempt: Promise<boolean> | undefined;
let exitAttempt: Promise<void> | undefined;
let allowQuit = false;
let smokeTimer: ReturnType<typeof setInterval> | undefined;
let smokeRestartContext: {
  bootId: string;
  rendererToken: string;
  workHash: string;
} | undefined;
let smokeSuccessorFailureInjected = false;

if (!hasSingleInstanceLock) {
  emitSmokeEvent({
    type: "desktop-smoke.failure",
    message: "Desktop smoke could not acquire the packaged host instance lock.",
  });
  app.quit();
} else {
  app.on("second-instance", () => restoreMainWindow());
  app.on("before-quit", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    void terminalExit();
  });
  app.on("window-all-closed", () => {
    // Tray/menu-bar ownership keeps the application alive.
  });
  app.on("activate", () => restoreMainWindow());
  void app.whenReady().then(async () => {
    app.setAppUserModelId("ai.easyresearch.desktop");
    installPreferenceIpc();
    createTray();
    showLoading("Preparing the local research workspace...");
    await startApplicationWithRecovery();
  }).catch((error) => {
    writeDesktopLog(`Desktop host initialization failed: ${errorMessage(error)}`);
    emitSmokeEvent({
      type: "desktop-smoke.failure",
      message: "Desktop smoke host initialization failed.",
    });
    dialog.showErrorBox(
      "EasyResearch could not start",
      `The desktop host could not initialize. Review ${desktopLogPath()}`,
    );
    allowQuit = true;
    app.quit();
  });
}

function installPreferenceIpc(): void {
  ipcMain.on(DESKTOP_PREFERENCES_READ_CHANNEL, (event) => {
    event.returnValue = isTrustedRenderer(event)
      ? readDesktopPreferenceBlob(app.getPath("userData"))
      : undefined;
  });
  ipcMain.on(DESKTOP_HOST_VERSION_CHANNEL, (event) => {
    event.returnValue = isTrustedRenderer(event) ? app.getVersion() : undefined;
  });
  ipcMain.on(DESKTOP_PREFERENCES_WRITE_CHANNEL, (event, raw: unknown) => {
    if (!isTrustedRenderer(event) || (raw !== null && typeof raw !== "string")) return;
    try {
      writeDesktopPreferenceBlob(app.getPath("userData"), raw);
    } catch (error) {
      writeDesktopLog(`Preference mirror rejected: ${errorMessage(error)}`);
    }
  });
}

function isTrustedRenderer(event: IpcMainEvent): boolean {
  return mainWindow !== undefined && event.sender === mainWindow.webContents;
}

async function startApplication(
  hash = "#/",
  transitionLease?: RuntimeLease,
): Promise<boolean> {
  if (lifecycle.exiting || !sidecarOwnership.acceptingLaunches) {
    if (transitionLease?.held && !transitionLease.release()) {
      throw new Error("Desktop host could not release cancelled successor transition custody.");
    }
    return false;
  }
  if (startAttempt) {
    if (transitionLease) throw new Error("Desktop successor launch is already active.");
    return startAttempt;
  }
  const current = (async (): Promise<boolean> => {
    let launchedSidecar: DesktopSidecarProcessHandle | undefined;
    try {
      try {
        if (!await prepareDesktopSidecarLaunch(sidecarOwnership)) return false;
      } catch (error) {
        writeDesktopLog(`Existing sidecar cleanup failed: ${errorMessage(error)}`);
        return false;
      }
      sidecar = undefined;
      if (lifecycle.exiting || !sidecarOwnership.acceptingLaunches) return false;
      showLoading("Preparing the local research workspace...");
      const environment = resolveDesktopEnvironment(process.env, process.platform, {
        warn: writeDesktopLog,
      });
      if (lifecycle.exiting || !sidecarOwnership.acceptingLaunches) return false;
      const handle = await startDesktopSidecar({
        sidecarPath: resolvePackagedSidecar(process.resourcesPath, process.platform),
        baseEnv: environment,
        agentDir: defaultAgentDir(),
        transitionLease,
        onSetup: showLoading,
        onSpawned: (handle) => {
          launchedSidecar = handle;
          sidecarOwnership.retain(handle);
        },
        onTransitionCommitted: () => {
          if (smokeRestartContext && consumeSmokeRequest("successor-start-failure-request")) {
            smokeSuccessorFailureInjected = true;
            emitSmokeEvent(desktopSmokeRestartFailureEvent("successor-start-failed", hash));
            writeDesktopLog("Desktop smoke injected one successor startup failure.");
            throw new Error("Desktop smoke injected one successor startup failure.");
          }
        },
        log: writeDesktopLog,
      });
      if (lifecycle.exiting) {
        await handle.shutdown();
        return false;
      }
      sidecar = handle;
      emitSmokeEvent(desktopSmokeSidecarReadyEvent({
        origin: handle.ready.origin,
        bootId: handle.ready.bootId,
        sidecarPid: handle.pid,
        rendererToken: handle.rendererToken,
      }, smokeRestartContext ? {
        bootId: smokeRestartContext.bootId,
        rendererToken: smokeRestartContext.rendererToken,
      } : undefined));
      monitorSidecar(handle);
      await createMainWindow(handle, hash);
      void checkForUpdates(false);
      return true;
    } catch (error) {
      writeDesktopLog(`Desktop startup failed: ${errorMessage(error)}`);
      const failedSidecar = sidecar;
      sidecar = undefined;
      const failedProcess = launchedSidecar ?? failedSidecar;
      try {
        await failedProcess?.shutdown();
      } catch (shutdownError) {
        writeDesktopLog(`Failed startup sidecar cleanup: ${errorMessage(shutdownError)}`);
      }
      if (smokeDirectory() && !smokeSuccessorFailureInjected) {
        emitSmokeEvent({
          type: "desktop-smoke.failure",
          message: "Desktop smoke sidecar startup failed.",
        });
      }
      return false;
    } finally {
      if (transitionLease?.held && !transitionLease.release()) {
        throw new Error("Desktop host could not release unused successor transition custody.");
      }
    }
  })();
  startAttempt = current;
  try {
    return await current;
  } finally {
    if (startAttempt === current) startAttempt = undefined;
  }
}

async function startApplicationWithRecovery(hash = "#/"): Promise<void> {
  if (!await startApplication(hash) && !lifecycle.exiting) {
    await showStartupFailure(hash);
  }
}

function showLoading(status: string): void {
  if (!loadingWindow || loadingWindow.isDestroyed()) {
    loadingWindow = new BrowserWindow({
      width: 520,
      height: 310,
      minWidth: 420,
      minHeight: 260,
      resizable: true,
      show: true,
      backgroundColor: "#f3efe6",
      title: "EasyResearch",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    loadingWindow.on("close", (event) => {
      handleMainWindowClose(lifecycle, event, () => loadingWindow?.hide());
    });
  }
  const document = renderLoadingDocument(status);
  void loadingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`).catch(() => {
    // A newer setup message may supersede this loading-page navigation.
  });
  loadingWindow.show();
}

async function createMainWindow(handle: DesktopSidecarHandle, hash: string): Promise<void> {
  mainWindow?.destroy();
  const preload = join(__dirname, "preload.cjs");
  const window = new BrowserWindow(
    desktopWindowOptions(preload, DESKTOP_SESSION_PARTITION),
  );
  mainWindow = window;
  const networkSession = window.webContents.session;
  networkSession.webRequest.onBeforeSendHeaders(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      callback({
        requestHeaders: desktopRequestHeaders(
          details.url,
          handle.ready.origin,
          handle.rendererToken,
          details.requestHeaders,
        ),
      });
    },
  );
  networkSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = navigationDecision(url, handle.ready.origin);
    if (decision.kind === "external") openExternal(decision.url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const decision = navigationDecision(url, handle.ready.origin);
    if (decision.kind === "allow") return;
    event.preventDefault();
    if (decision.kind === "external") openExternal(decision.url);
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.on("close", (event) => {
    handleMainWindowClose(lifecycle, event, () => window.hide());
  });
  window.on("query-session-end", () => void terminalExit());
  window.on("session-end", () => void terminalExit());
  window.webContents.once("did-finish-load", () => {
    if (window.isDestroyed()) return;
    loadingWindow?.hide();
    window.show();
    window.focus();
    void installSmokeLifecycle(window, handle);
  });
  await window.loadURL(`${handle.ready.origin}/${hash}`);
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  if (icon.isEmpty()) throw new Error("EasyResearch tray icon could not be decoded.");
  if (process.platform === "darwin") icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("EasyResearch");
  tray.setContextMenu(Menu.buildFromTemplate(createTrayMenuTemplate({
    open: restoreMainWindow,
    check: () => void checkForUpdates(true),
    exit: () => void terminalExit(),
  })));
  tray.on("click", restoreMainWindow);
}

function restoreMainWindow(): void {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : loadingWindow;
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function openExternal(url: string): void {
  void shell.openExternal(url).catch((error) => {
    writeDesktopLog(`Opening external URL failed: ${errorMessage(error)}`);
  });
}

function monitorSidecar(handle: DesktopSidecarHandle): void {
  if (smokeDirectory()) {
    void handle.restartRequested.then((event) => {
      emitSmokeEvent({ type: "desktop-smoke.restart-requested", bootId: event.bootId });
    });
    void handle.exited.then((exit) => {
      if (
        exit.code === 0
        && exit.signal === null
        && !exit.protocolError
        && exit.expectedRestart?.bootId === handle.ready.bootId
      ) {
        emitSmokeEvent({
          type: "desktop-smoke.old-sidecar-exited",
          bootId: handle.ready.bootId,
          clean: true,
        });
      }
    });
  }
  void monitorDesktopSidecarLifecycle(handle, {
    isCurrent: () => sidecar === handle,
    isExiting: () => lifecycle.exiting,
    captureRoute: () => captureDesktopRestartHash(
      mainWindow?.webContents.getURL() ?? "",
      handle.ready.origin,
    ),
    showRestarting: () => {
      mainWindow?.hide();
      showLoading("Restarting the local research workspace...");
    },
    clearCurrent: () => {
      if (sidecar === handle) sidecar = undefined;
    },
    startSuccessor: (hash, transitionLease) => startApplication(hash, transitionLease),
    showStartupFailure,
    showUnexpectedExit: async (logPath) => {
      emitSmokeEvent({
        type: "desktop-smoke.unexpected-exit",
        bootId: handle.ready.bootId,
      });
      mainWindow?.hide();
      await showUnexpectedExit(logPath);
    },
    onCleanupError: (error) => {
      writeDesktopLog(`Desktop sidecar force termination failed: ${errorMessage(error)}`);
    },
  }).catch((error) => {
    writeDesktopLog(`Sidecar lifecycle recovery failed: ${errorMessage(error)}`);
    void terminalExit();
  });
}

async function showStartupFailure(hash = "#/"): Promise<void> {
  const directory = smokeDirectory();
  if (directory && smokeRestartContext && smokeSuccessorFailureInjected) {
    emitSmokeEvent(desktopSmokeRestartFailureEvent("restart-recovery-visible", hash));
    armSmokeRequest(directory, "successor-retry-request", async () => {
      smokeSuccessorFailureInjected = false;
      emitSmokeEvent(desktopSmokeRestartFailureEvent("successor-retry-requested", hash));
      if (!await startApplication(hash) && !lifecycle.exiting) {
        emitSmokeEvent({
          type: "desktop-smoke.failure",
          message: "Desktop smoke successor retry failed.",
        });
        await terminalExit();
      }
    });
    return;
  }
  const result = await showDesktopMessage(loadingWindow, {
    type: "error",
    title: "EasyResearch could not start",
    message: "The local EasyResearch service could not start.",
    detail: `Review the desktop log and retry.\n\n${desktopLogPath()}`,
    buttons: ["Retry", "Quit"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (result.response === 0 && !lifecycle.exiting) {
    await startApplicationWithRecovery(hash);
  } else {
    await terminalExit();
  }
}

async function showUnexpectedExit(sidecarLogPath: string): Promise<void> {
  while (!lifecycle.exiting) {
    const result = await showDesktopMessage(mainWindow, {
      type: "error",
      title: "EasyResearch stopped",
      message: "The local EasyResearch service exited unexpectedly.",
      detail: `The previous Agents are no longer running.\n\n${sidecarLogPath}`,
      buttons: ["Restart", "Open Logs", "Quit"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (result.response === 0) {
      showLoading("Restarting the local research workspace...");
      await startApplicationWithRecovery();
      return;
    }
    if (result.response === 1) {
      shell.showItemInFolder(sidecarLogPath);
      continue;
    }
    await terminalExit();
    return;
  }
}

async function checkForUpdates(manual: boolean): Promise<void> {
  try {
    const update = await checkDesktopUpdate(app.getVersion());
    if (update) {
      await showUpdate(update);
    } else if (manual) {
      await showDesktopMessage(mainWindow, {
        type: "info",
        title: "EasyResearch is up to date",
        message: `EasyResearch ${app.getVersion()} is the latest release.`,
        buttons: ["OK"],
      });
    }
  } catch (error) {
    if (!manual) return;
    await showDesktopMessage(mainWindow, {
      type: "warning",
      title: "Update check failed",
      message: "EasyResearch could not check GitHub Releases.",
      detail: errorMessage(error),
      buttons: ["OK"],
    });
  }
}

async function showUpdate(update: DesktopReleaseUpdate): Promise<void> {
  const result = await showDesktopMessage(mainWindow, {
    type: "info",
    title: "EasyResearch update available",
    message: `EasyResearch ${update.version} is available.`,
    detail: "Download and install it manually from GitHub Releases.",
    buttons: ["Open Release", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response === 0) await shell.openExternal(update.url);
}

function terminalExit(): Promise<void> {
  if (exitAttempt) return exitAttempt;
  lifecycle = beginDesktopExit(lifecycle);
  sidecarOwnership.closeLaunchAdmission();
  const current = (async () => {
    if (smokeTimer) clearInterval(smokeTimer);
    emitSmokeEvent({ type: "desktop-smoke.exit-started" });
    sidecar = undefined;
    try {
      await sidecarOwnership.shutdownAll();
    } catch (error) {
      writeDesktopLog(`Desktop sidecar shutdown failed: ${errorMessage(error)}`);
      dialog.showErrorBox(
        "EasyResearch could not exit",
        `A local sidecar process has not exited. Retry Exit after reviewing ${desktopLogPath()}`,
      );
      exitAttempt = undefined;
      return;
    }
    emitSmokeEvent({ type: "desktop-smoke.sidecar-stopped" });
    tray?.destroy();
    tray = undefined;
    mainWindow?.destroy();
    loadingWindow?.destroy();
    allowQuit = true;
    app.quit();
  })();
  exitAttempt = current;
  return current;
}

async function installSmokeLifecycle(
  window: BrowserWindow,
  handle: DesktopSidecarHandle,
): Promise<void> {
  const directory = smokeDirectory();
  if (!directory) return;
  const project = process.env.EASYRESEARCH_DESKTOP_SMOKE_PROJECT;
  const expectedSessionPath = process.env.EASYRESEARCH_DESKTOP_SMOKE_SESSION_PATH;
  const expectedAgent = process.env.EASYRESEARCH_DESKTOP_SMOKE_AGENT;
  const proxyUrl = process.env.EASYRESEARCH_DESKTOP_SMOKE_PROXY;
  if (!project || !isAbsolute(project) || !expectedSessionPath || !expectedAgent || !proxyUrl) {
    emitSmokeEvent({ type: "desktop-smoke.failure", message: "Desktop smoke inputs are invalid." });
    await terminalExit();
    return;
  }
  try {
    await waitForCurrentWebUi(window, handle.ready.origin);
    if (!smokeRestartContext) {
      emitSmokeEvent({ type: "desktop-smoke.window-loaded" });
      const prepared = await prepareDesktopSmokeWork({
        origin: handle.ready.origin,
        rendererToken: handle.rendererToken,
        project,
        expectedSessionPath,
        expectedAgent,
        onStateVisible: () => emitSmokeEvent({ type: "desktop-smoke.state-visible" }),
      });
      if (prepared.bootId !== handle.ready.bootId) {
        throw new Error("Desktop smoke authenticated status did not match sidecar readiness.");
      }
      emitSmokeEvent({ type: "desktop-smoke.agent-running" });

      const workHash = desktopSmokeWorkHash(prepared.sessionId, project);
      await window.loadURL(`${handle.ready.origin}/${workHash}`);
      await waitForCurrentWebUi(window, handle.ready.origin);
      if (!isDesktopSmokeRestoredWorkDocument(
        window.webContents.getURL(),
        handle.ready.origin,
        workHash,
      )) {
        throw new Error("Desktop smoke could not establish the canonical Work route before restart.");
      }
      smokeRestartContext = {
        bootId: prepared.bootId,
        rendererToken: handle.rendererToken,
        workHash,
      };
      armSmokeRequest(directory, "restart-request", async () => {
        const restarted = await requestDesktopSmokeRestart({
          origin: handle.ready.origin,
          rendererToken: handle.rendererToken,
          oldBootId: prepared.bootId,
          proxyUrl,
        });
        emitSmokeEvent({
          type: "desktop-smoke.restart-api-accepted",
          bootId: restarted.bootId,
          hash: workHash,
        });
      });
      return;
    }

    if (!isDesktopSmokeRestoredWorkDocument(
      window.webContents.getURL(),
      handle.ready.origin,
      smokeRestartContext.workHash,
    )) {
      throw new Error("Desktop smoke successor did not restore the canonical Work route.");
    }
    const successor = await verifyDesktopSmokeSuccessor({
      origin: handle.ready.origin,
      rendererToken: handle.rendererToken,
      oldBootId: smokeRestartContext.bootId,
      expectedSessionPath,
    });
    if (successor.bootId !== handle.ready.bootId) {
      throw new Error("Desktop smoke successor status did not match sidecar readiness.");
    }
    emitSmokeEvent({
      type: "desktop-smoke.successor-visible",
      bootId: successor.bootId,
      hash: smokeRestartContext.workHash,
      authenticated: true,
      persistedSessionVisible: true,
    });
  } catch (error) {
    const message = errorMessage(error);
    writeDesktopLog(`Desktop smoke preflight failed: ${message}`);
    emitSmokeEvent({ type: "desktop-smoke.failure", message });
    await terminalExit();
    return;
  }
  setTimeout(() => {
    if (window.isDestroyed() || lifecycle.exiting) return;
    window.close();
    emitSmokeEvent({
      type: "desktop-smoke.window-hidden",
      sidecarPid: handle.pid,
      hidden: !window.isVisible(),
    });
  }, 100);
  armSmokeRequest(directory, "exit-request", terminalExit);
}

function armSmokeRequest(
  directory: string,
  fileName: "restart-request" | "successor-retry-request" | "exit-request",
  action: () => Promise<unknown>,
): void {
  if (smokeTimer) clearInterval(smokeTimer);
  let started = false;
  smokeTimer = setInterval(() => {
    if (started || !existsSync(join(directory, fileName))) return;
    started = true;
    if (smokeTimer) clearInterval(smokeTimer);
    smokeTimer = undefined;
    void action().catch(async (error) => {
      const message = errorMessage(error);
      writeDesktopLog(`Desktop smoke ${fileName} failed: ${message}`);
      emitSmokeEvent({ type: "desktop-smoke.failure", message });
      await terminalExit();
    });
  }, 100);
}

function consumeSmokeRequest(fileName: "successor-start-failure-request"): boolean {
  const directory = smokeDirectory();
  if (!directory) return false;
  const path = join(directory, fileName);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

async function waitForCurrentWebUi(window: BrowserWindow, readyOrigin: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    let hasRenderedRoot = false;
    let authenticatedStatus = false;
    try {
      [hasRenderedRoot, authenticatedStatus] = await window.webContents.executeJavaScript(
        "Promise.all([Boolean(document.querySelector('#root')?.childElementCount), fetch('/api/status').then((response) => response.ok).catch(() => false)])",
        true,
      ) as [boolean, boolean];
    } catch {
      // Navigation may still be committing.
    }
    if (isCurrentDesktopDocument(
      window.webContents.getURL(),
      readyOrigin,
      hasRenderedRoot,
      authenticatedStatus,
    )) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Desktop main window did not render the authenticated EasyResearch Web UI.");
}

function configureSmokeUserData(): void {
  const value = process.env[DESKTOP_SMOKE_USER_DATA_ENV];
  if (value === undefined) return;
  if (!isAbsolute(value)) throw new Error("Desktop smoke userData path must be absolute.");
  try {
    if (!statSync(value).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new Error("Desktop smoke userData path must name an existing directory.", { cause: error });
  }
  app.setPath("userData", value);
  delete process.env[DESKTOP_SMOKE_USER_DATA_ENV];
}

function smokeDirectory(): string | undefined {
  const value = process.env.EASYRESEARCH_DESKTOP_SMOKE_DIR;
  if (!value || !isAbsolute(value)) return undefined;
  try {
    return statSync(value).isDirectory() ? value : undefined;
  } catch {
    return undefined;
  }
}

function emitSmokeEvent(event: Record<string, unknown>): void {
  const directory = smokeDirectory();
  if (!directory) return;
  appendFileSync(join(directory, "events.jsonl"), `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function desktopLogPath(): string {
  return join(app.getPath("userData"), "logs", "desktop.log");
}

function writeDesktopLog(message: string): void {
  try {
    const path = desktopLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `[${new Date().toISOString()}] ${message.replace(/[\r\n]+/gu, " ")}\n`, "utf8");
  } catch {
    // Desktop logging must not crash lifecycle cleanup.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showDesktopMessage(
  owner: BrowserWindow | undefined,
  options: MessageBoxOptions,
): Promise<MessageBoxReturnValue> {
  return owner && !owner.isDestroyed()
    ? dialog.showMessageBox(owner, options)
    : dialog.showMessageBox(options);
}
