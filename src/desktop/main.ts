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
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  beginDesktopExit,
  createDesktopLifecycleState,
  type DesktopLifecycleState,
} from "./lifecycle";
import {
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
} from "./sidecar";
import { checkDesktopUpdate, type DesktopReleaseUpdate } from "./update";
import { prepareDesktopSmokeWork } from "./smoke-host";
import { DESKTOP_SMOKE_USER_DATA_ENV } from "./contracts";

configureSmokeUserData();
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let mainWindow: BrowserWindow | undefined;
let loadingWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let sidecar: DesktopSidecarHandle | undefined;
let lifecycle: DesktopLifecycleState = createDesktopLifecycleState();
let startAttempt: Promise<void> | undefined;
let exitAttempt: Promise<void> | undefined;
let allowQuit = false;
let smokeTimer: ReturnType<typeof setInterval> | undefined;

if (!hasSingleInstanceLock) {
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
    await startApplication();
  }).catch((error) => {
    writeDesktopLog(`Desktop host initialization failed: ${errorMessage(error)}`);
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

async function startApplication(): Promise<void> {
  if (startAttempt) return startAttempt;
  let failed = false;
  const current = (async () => {
    try {
      showLoading("Preparing the local research workspace...");
      const environment = resolveDesktopEnvironment(process.env, process.platform, {
        warn: writeDesktopLog,
      });
      const handle = await startDesktopSidecar({
        sidecarPath: resolvePackagedSidecar(process.resourcesPath, process.platform),
        baseEnv: environment,
        onSetup: showLoading,
        log: writeDesktopLog,
      });
      if (lifecycle.exiting) {
        await handle.shutdown();
        return;
      }
      sidecar = handle;
      emitSmokeEvent({ type: "desktop-smoke.sidecar-ready", origin: handle.ready.origin });
      monitorSidecar(handle);
      await createMainWindow(handle);
      void checkForUpdates(false);
    } catch (error) {
      failed = true;
      writeDesktopLog(`Desktop startup failed: ${errorMessage(error)}`);
      const failedSidecar = sidecar;
      sidecar = undefined;
      try {
        await failedSidecar?.shutdown();
      } catch (shutdownError) {
        writeDesktopLog(`Failed startup sidecar cleanup: ${errorMessage(shutdownError)}`);
        failedSidecar?.forceTerminate();
      }
    }
  })();
  startAttempt = current;
  try {
    await current;
  } finally {
    if (startAttempt === current) startAttempt = undefined;
  }
  if (failed && !lifecycle.exiting) await showStartupFailure();
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

async function createMainWindow(handle: DesktopSidecarHandle): Promise<void> {
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
  await window.loadURL(handle.ready.origin);
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
  void handle.exited.then(() => {
    if (sidecar !== handle || lifecycle.exiting) return;
    sidecar = undefined;
    mainWindow?.hide();
    void showUnexpectedExit(handle.ready.logPath).catch((error) => {
      writeDesktopLog(`Unexpected-exit recovery failed: ${errorMessage(error)}`);
      void terminalExit();
    });
  });
}

async function showStartupFailure(): Promise<void> {
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
    await startApplication();
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
      await startApplication();
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
  const current = (async () => {
    if (smokeTimer) clearInterval(smokeTimer);
    emitSmokeEvent({ type: "desktop-smoke.exit-started" });
    const ownedSidecar = sidecar;
    sidecar = undefined;
    try {
      await ownedSidecar?.shutdown();
    } catch (error) {
      writeDesktopLog(`Desktop sidecar shutdown failed: ${errorMessage(error)}`);
      ownedSidecar?.forceTerminate();
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
  if (!project || !isAbsolute(project) || !expectedSessionPath || !expectedAgent) {
    emitSmokeEvent({ type: "desktop-smoke.failure", message: "Desktop smoke inputs are invalid." });
    await terminalExit();
    return;
  }
  try {
    await waitForCurrentWebUi(window, handle.ready.origin);
    emitSmokeEvent({ type: "desktop-smoke.window-loaded" });
    await prepareDesktopSmokeWork({
      origin: handle.ready.origin,
      rendererToken: handle.rendererToken,
      project,
      expectedSessionPath,
      expectedAgent,
      onStateVisible: () => emitSmokeEvent({ type: "desktop-smoke.state-visible" }),
    });
    emitSmokeEvent({ type: "desktop-smoke.agent-running" });
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
  smokeTimer = setInterval(() => {
    if (!existsSync(join(directory, "exit-request"))) return;
    if (smokeTimer) clearInterval(smokeTimer);
    smokeTimer = undefined;
    void terminalExit();
  }, 100);
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
