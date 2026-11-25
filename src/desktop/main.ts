import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  shell,
  Tray,
  type IpcMainEvent,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  type WebContents,
  type WebPreferences,
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
} from "./main-support";
import {
  readDesktopPreferenceBlob,
  writeDesktopPreferenceBlob,
} from "./preferences-store";
import {
  desktopPermissionAllowed,
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
import { createDesktopUpdateController } from "./update";
import { hashDesktopUpdateFile } from "./update-host-files";
import { desktopPackageKind } from "./update-download";
import { installDesktopUpdate, type DesktopUpdateCustodian } from "./update-install";
import { acceptDesktopUpdateSuccessor, consumeDesktopUpdateSuccessor, desktopUpdateRecovery, prepareDesktopUpdateCustodian } from "./update-custodian";
import { connectDesktopSuccessorChannel } from "./update-successor-channel";
import { isDesktopUpdateSender, registerDesktopUpdateIpc, registerDesktopUpdatePresentation, type DesktopUpdateOwner, type DesktopUpdatePresentation } from "./update-ipc";
import { LATEST_RELEASE_PAGE, type UpdateController } from "../runtime/update-contract";
import {
  desktopSmokeLinuxRendererSecurityEvent,
  desktopSmokeSidecarReadyEvent,
  desktopSmokeRestartFailureEvent,
  desktopSmokeWorkHash,
  isDesktopSmokeRestoredWorkDocument,
  prepareDesktopSmokeWork,
  requestDesktopSmokeRestart,
  verifyDesktopSmokeSuccessor,
} from "./smoke-host";
import { DESKTOP_SMOKE_USER_DATA_ENV, DESKTOP_UPDATE_EVENT_CHANNEL, DESKTOP_UPDATE_OPEN_CHANNEL } from "./contracts";
import { verifyDesktopSmokeWorkFiles } from "./smoke-work-files";
import {
  clearDesktopSmokeSessionTabsStorage,
  prepareDesktopSmokeSessionTabs,
  verifyDesktopSmokeSessionTabs,
  verifyDesktopSmokeSessionTabsCleared,
  verifyDesktopSmokeSessionTabsCommitted,
  type DesktopSmokeSessionTabsReceipt,
} from "./smoke-session-tabs";

configureSmokeUserData();
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let mainWindow: BrowserWindow | undefined;
let loadedMainWindow: BrowserWindow | undefined;
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
  sessionTabs: DesktopSmokeSessionTabsReceipt;
} | undefined;
let smokeSuccessorFailureInjected = false;
let updater: UpdateController | undefined;
let updatePresentation: DesktopUpdatePresentation | undefined;
let manualUpdateRequested = false;
let updateRecoveryDetected = false;
let updateRecoveryNoticePending = false;
let desktopEnvironment: NodeJS.ProcessEnv | undefined;
const updateHelpers = new Set<DesktopUpdateCustodian>();
const updateSuccessor = consumeDesktopUpdateSuccessor(process.env);
let updateSuccessorReady = false;
let updateSuccessorParent: Awaited<ReturnType<typeof connectDesktopSuccessorChannel>> | undefined;
let updateSuccessorConnected: Promise<typeof updateSuccessorParent> | undefined;
if (updateSuccessor) {
  writeDesktopLog(`Desktop update successor entered; single-instance lock ${hasSingleInstanceLock ? "acquired" : "denied"}.`);
  process.stdout.on("error", () => {});
  if (hasSingleInstanceLock) {
    updateSuccessorConnected = connectDesktopSuccessorChannel(updateSuccessor, () => {
      if (!updateSuccessorReady) { writeDesktopLog("Desktop update parent channel closed before acceptance."); void terminalExit(); }
    }).then(parent => {
      updateSuccessorParent = parent;
      if (lifecycle.exiting) parent.close();
      return parent;
    });
    void updateSuccessorConnected.catch(() => { writeDesktopLog("Desktop update successor channel could not attach."); void terminalExit(); });
  }
}

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
    if (smokeDirectory() && app.isPackaged) {
      emitSmokeEvent({ type: "desktop-smoke.archive-integrity", sha256: await hashDesktopUpdateFile(app.getAppPath()) });
    }
    if (process.platform === "win32" || process.platform === "linux") {
      // Remove the window menu for this lifetime, including recreated windows.
      Menu.setApplicationMenu(null);
    }
    installPreferenceIpc();
    registerDesktopUpdateIpc(ipcMain, getUpdater, updateRendererOwner);
    updatePresentation = registerDesktopUpdatePresentation(ipcMain, updateRendererOwner, {
      loaded: () => Boolean(mainWindow && loadedMainWindow === mainWindow),
      send: (intent) => { mainWindow!.webContents.mainFrame.send(DESKTOP_UPDATE_OPEN_CHANNEL, intent); },
    });
    createTray();
    if (updateSuccessor) {
      const parent = await updateSuccessorConnected;
      if (!parent || lifecycle.exiting) throw new Error("Desktop update successor channel is unavailable.");
      const accepted = await acceptDesktopUpdateSuccessor(updateSuccessor, {
        hostPath: process.execPath, userDataDir: app.getPath("userData"), version: app.getVersion(), hashFile: hashDesktopUpdateFile,
      });
      // The private successor carrier is already consumed; only the ordinary
      // exact-root environment is passed through the existing sidecar startup.
      process.env.EASYRESEARCH_CODING_AGENT_DIR = accepted.handoff.agentDir;
      if (accepted.recovery) requestUpdateRecovery();
      if (!await startApplication(accepted.handoff.route, accepted.lease) || !sidecar || lifecycle.exiting) throw new Error("Updated Desktop could not start.");
      await parent.ready(accepted.ready(sidecar.ready.bootId, sidecar.pid));
      updateSuccessorReady = true;
      parent.close();
      void accepted.finish().catch((error) => writeDesktopLog(`Desktop update staging cleanup failed: ${errorMessage(error)}`));
    } else {
      const recoveryFailed = await desktopUpdateRecovery(app.getPath("userData")).catch((error) => {
        writeDesktopLog(`Desktop update recovery receipt failed: ${errorMessage(error)}`);
        return true;
      });
      if (recoveryFailed) requestUpdateRecovery();
      await startApplicationWithRecovery();
    }
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
    void terminalExit();
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
    let hostReady = false;
    try {
      try {
        if (!await prepareDesktopSidecarLaunch(sidecarOwnership)) return false;
      } catch (error) {
        writeDesktopLog(`Existing sidecar cleanup failed: ${errorMessage(error)}`);
        return false;
      }
      sidecar = undefined;
      revokeMainDocument();
      if (lifecycle.exiting || !sidecarOwnership.acceptingLaunches) return false;
      writeDesktopLog("Preparing the local research workspace...");
      const environment = resolveDesktopEnvironment(process.env, process.platform, {
        warn: writeDesktopLog,
      });
      environment.EASYRESEARCH_CODING_AGENT_DIR ||= defaultAgentDir();
      desktopEnvironment = environment;
      if (lifecycle.exiting || !sidecarOwnership.acceptingLaunches) return false;
      const handle = await startDesktopSidecar({
        sidecarPath: resolvePackagedSidecar(process.resourcesPath, process.platform),
        baseEnv: environment,
        agentDir: environment.EASYRESEARCH_CODING_AGENT_DIR,
        transitionLease,
        retainTransitionUntilHostReady: Boolean(updateSuccessor && !updateSuccessorReady),
        onSetup: (message) => {
          writeDesktopLog(`Desktop sidecar setup: ${message}`);
        },
        onSpawned: (handle) => {
          launchedSidecar = handle;
          sidecarOwnership.retain(handle);
          writeDesktopLog(`Desktop sidecar spawned (pid ${handle.pid ?? "unknown"}).`);
        },
        onTransitionCommitted: () => {
          if (smokeRestartContext && consumeSmokeRequest("successor-start-failure-request")) {
            smokeSuccessorFailureInjected = true;
            emitSmokeEvent(desktopSmokeRestartFailureEvent("successor-start-failed", hash));
            writeDesktopLog("Desktop smoke injected one successor startup failure.");
            throw new Error("Desktop smoke post-commit failure injection.");
          }
        },
        log: writeDesktopLog,
      });
      if (lifecycle.exiting || !sidecarOwnership.acceptingLaunches) {
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
      hostReady = true;
      if (!updateSuccessor && !updater && !manualUpdateRequested && !updateRecoveryDetected) void checkForUpdates();
      return true;
    } catch (error) {
      writeDesktopLog(`Desktop startup failed: ${errorMessage(error)}`);
      const failedSidecar = sidecar;
      sidecar = undefined;
      revokeMainDocument();
      mainWindow?.hide();
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
      if (transitionLease?.held && !(hostReady && updateSuccessor && !updateSuccessorReady) && !transitionLease.release()) {
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

async function createMainWindow(handle: DesktopSidecarHandle, hash: string): Promise<void> {
  revokeMainDocument();
  mainWindow?.destroy();
  // Bun may bake __dirname into the host bundle as the build-machine source path.
  const preload = join(app.getAppPath(), "preload.cjs");
  const windowOptions = desktopWindowOptions(preload, DESKTOP_SESSION_PARTITION);
  const window = new BrowserWindow({ ...windowOptions, icon: join(process.resourcesPath, "icons", "icon.png") });
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
  const allowPermission = (
    requestingWebContents: WebContents | null,
    permission: string,
    details: { isMainFrame: boolean; requestingUrl?: string },
    requestingOrigin?: string,
  ): boolean => {
    if (mainWindow !== window || sidecar !== handle || lifecycle.exiting
      || window.isDestroyed() || window.webContents.isDestroyed()) return false;
    return desktopPermissionAllowed({
      requestingWebContents,
      ownerWebContents: window.webContents,
      ownerDocumentUrl: window.webContents.getURL(),
      readyOrigin: handle.ready.origin,
      permission,
      details,
      requestingOrigin,
    });
  };
  networkSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowPermission(contents, permission, details));
  });
  networkSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    return allowPermission(contents, permission, details, requestingOrigin);
  });
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
  const revoke = () => {
    if (mainWindow !== window) return;
    revokeMainDocument();
  };
  window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace || mainWindow !== window) return;
    revoke();
    window.hide();
  });
  window.webContents.on("render-process-gone", revoke);
  window.webContents.on("destroyed", revoke);
  window.on("closed", revoke);
  let smokeInstalled = false;
  window.webContents.on("did-finish-load", () => {
    if (window.isDestroyed() || mainWindow !== window || sidecar !== handle || lifecycle.exiting
      || !isDesktopUpdateSender({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, updateRendererOwner())) return;
    loadedMainWindow = window;
    window.show();
    window.focus();
    updatePresentation?.flush();
    if (!smokeInstalled) {
      smokeInstalled = true;
      void installSmokeLifecycle(window, handle, windowOptions.webPreferences);
    }
  });
  await window.loadURL(`${handle.ready.origin}/${hash}`);
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(process.resourcesPath, "icons", "tray.png"));
  if (icon.isEmpty()) throw new Error("EasyResearch tray icon could not be decoded.");
  if (process.platform === "darwin") icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("EasyResearch");
  tray.setContextMenu(Menu.buildFromTemplate(createTrayMenuTemplate({
    open: restoreMainWindow,
    check: requestUpdateCheck,
    exit: () => void terminalExit(),
  })));
  tray.on("click", restoreMainWindow);
}

function restoreMainWindow(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed() || loadedMainWindow !== window || !sidecar || lifecycle.exiting) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function revokeMainDocument(): void {
  loadedMainWindow = undefined;
  updatePresentation?.revoke();
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
    isExiting: () => lifecycle.exiting || !sidecarOwnership.acceptingLaunches,
    captureRoute: () => captureDesktopRestartHash(
      mainWindow?.webContents.getURL() ?? "",
      handle.ready.origin,
    ),
    showRestarting: () => {
      revokeMainDocument();
      mainWindow?.hide();
      writeDesktopLog("Restarting the local research workspace...");
    },
    clearCurrent: () => {
      if (sidecar === handle) {
        sidecar = undefined;
        revokeMainDocument();
      }
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
  const result = await showDesktopMessage(undefined, {
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

function requestUpdateCheck(): void {
  if (lifecycle.exiting) return;
  manualUpdateRequested = true;
  updatePresentation?.request("check");
  restoreMainWindow();
}

function requestUpdateRecovery(): void {
  if (lifecycle.exiting) return;
  updateRecoveryDetected = true;
  updateRecoveryNoticePending = true;
  presentUpdateRecovery();
}

function presentUpdateRecovery(): void {
  if (!updateRecoveryNoticePending || lifecycle.exiting || (updater && updater.snapshot().phase !== "failed")) return;
  updateRecoveryNoticePending = false;
  updatePresentation?.request("recovery");
  restoreMainWindow();
}

async function checkForUpdates(): Promise<void> {
  try {
    await getUpdater().action({ action: "check" });
  } catch {
    // The automatic check is silent; explicit requests use the shared Web dialog.
  }
}

async function showUpdateFallback(message: string): Promise<void> {
  const result = await showDesktopMessage(mainWindow, {
    type: "warning", title: "EasyResearch update", message,
    buttons: ["Open latest Release", "Close"], defaultId: 0, cancelId: 1,
  });
  if (result.response === 0) openExternal(LATEST_RELEASE_PAGE);
}

function updateRendererOwner(): DesktopUpdateOwner | undefined {
  if (!mainWindow || mainWindow.isDestroyed() || !sidecar || lifecycle.exiting) return undefined;
  return { contents: mainWindow.webContents, origin: sidecar.ready.origin };
}

function getUpdater(): UpdateController {
  if (updater) return updater;
  const kind = desktopPackageKind(process.platform, process.arch, process.env.APPIMAGE);
  updater = createDesktopUpdateController({
    currentVersion: app.getVersion(), kind, stagingRoot: join(app.getPath("userData"), "updates"),
    recoveredInstallationFailure: updateRecoveryDetected,
    fetch: (input, init) => net.fetch(input, init),
    activity: (signal) => {
      if (!sidecar || lifecycle.exiting) return Promise.reject(new Error("Desktop activity check is unavailable."));
      return sidecar.updateActivity(signal);
    },
    onError: (error) => writeDesktopLog(`Desktop update failed: ${errorMessage(error)}`),
    reveal: async (path) => { shell.showItemInFolder(path); },
    ...(app.isPackaged && kind === "windows-x64.exe" ? {
      install: async (update, signal, committed, controls) => {
        const currentSidecar = sidecar;
        if (!currentSidecar || !desktopEnvironment?.EASYRESEARCH_CODING_AGENT_DIR || lifecycle.exiting) throw new Error("Desktop runtime is not ready for installation.");
        const hash = captureDesktopRestartHash(mainWindow?.webContents.getURL() ?? "", currentSidecar.ready.origin);
        try {
          return await installDesktopUpdate({ ownership: sidecarOwnership, signal, committed, force: controls.force,
            admit: (force, signal) => currentSidecar.prepareUpdate(force, signal),
            prepare: () => prepareDesktopUpdateCustodian({ update, signal, hashFile: hashDesktopUpdateFile,
              accepted: controls.stagingAccepted, released: controls.stagingReleased,
              sidecarPath: resolvePackagedSidecar(process.resourcesPath, process.platform), hostPath: process.execPath,
              userDataDir: app.getPath("userData"), agentDir: desktopEnvironment!.EASYRESEARCH_CODING_AGENT_DIR!,
              currentVersion: app.getVersion(), oldBootId: currentSidecar.ready.bootId, route: hash,
              retain: (handle) => {
                updateHelpers.add(handle);
                void handle.exited?.then(() => { updateHelpers.delete(handle); });
              },
            }),
            shutdown: async () => {
              await sidecarOwnership.shutdownAll();
              await startAttempt;
              if (sidecarOwnership.size !== 0) throw new Error("Desktop still owns a sidecar.");
              if (!(await currentSidecar.exited).cleanShutdown) throw new Error("Desktop did not acknowledge successful terminal cleanup.");
              sidecar = undefined;
            },
            quit: () => { lifecycle = beginDesktopExit(lifecycle); finishHostExit(); },
          });
        } catch (error) {
          // Failed precommit cleanup is a real failure, never permission to quit/install.
          // If the old sidecar did stop, recover the unchanged installed application.
          if (!lifecycle.exiting && sidecarOwnership.acceptingLaunches && sidecarOwnership.size === 0) {
            sidecar = undefined;
            revokeMainDocument();
            requestUpdateRecovery();
            await startApplication(hash);
          }
          if (!lifecycle.exiting && !sidecar) {
            await showUpdateFallback("Installation failed. Open latest Release.");
          }
          throw error;
        }
      },
    } : {}),
  });
  updater.subscribe((snapshot) => {
    const owner = updateRendererOwner();
    if (owner && isDesktopUpdateSender({ sender: owner.contents, senderFrame: owner.contents.mainFrame }, owner)) {
      mainWindow!.webContents.send(DESKTOP_UPDATE_EVENT_CHANNEL, snapshot);
    }
    if (snapshot.phase === "failed") presentUpdateRecovery();
  });
  return updater;
}

function terminalExit(): Promise<void> {
  if (exitAttempt) return exitAttempt;
  lifecycle = beginDesktopExit(lifecycle);
  revokeMainDocument();
  updatePresentation?.close();
  updateSuccessorParent?.close();
  sidecarOwnership.closeLaunchAdmission();
  const current = (async () => {
    if (smokeTimer) clearInterval(smokeTimer);
    emitSmokeEvent({ type: "desktop-smoke.exit-started" });
    sidecar = undefined;
    try {
      const cleanup = await Promise.allSettled([
        updater?.close(),
        ...[...updateHelpers].map((helper) => helper.abort()),
        sidecarOwnership.shutdownAll(),
      ]);
      const errors = cleanup.filter((item): item is PromiseRejectedResult => item.status === "rejected");
      if (errors.length > 0) throw new AggregateError(errors.map((item) => item.reason), "Desktop cleanup failed.");
      await startAttempt;
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
    finishHostExit();
  })();
  exitAttempt = current;
  return current;
}

function finishHostExit(): void {
  if (smokeTimer) clearInterval(smokeTimer);
  tray?.destroy(); tray = undefined;
  mainWindow?.destroy();
  allowQuit = true;
  app.quit();
}

async function installSmokeLifecycle(
  window: BrowserWindow,
  handle: DesktopSidecarHandle,
  webPreferences: Readonly<WebPreferences>,
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
    if (process.platform === "linux") {
      emitSmokeEvent(desktopSmokeLinuxRendererSecurityEvent({
        rendererPid: window.webContents.getOSProcessId(),
        hostPid: process.pid,
        noSandbox: app.commandLine.hasSwitch("no-sandbox"),
        webPreferences,
      }));
    }
    if (process.platform === "win32" || process.platform === "linux") {
      const assertMenuRemoved = () => {
        if (Menu.getApplicationMenu() !== null || window.isMenuBarVisible()) {
          throw new Error("Desktop smoke found a native window menu before or after Alt.");
        }
      };
      assertMenuRemoved();
      for (const type of ["keyDown", "keyUp"] as const) {
        window.webContents.sendInputEvent({ type, keyCode: "Alt" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        assertMenuRemoved();
      }
    }
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
      emitSmokeEvent(await verifyDesktopSmokeWorkFiles({
        window,
        webContents: window.webContents,
        origin: handle.ready.origin,
        rendererToken: handle.rendererToken,
        project,
        directory,
      }));
      const sessionTabs = await prepareDesktopSmokeSessionTabs({
        webContents: window.webContents,
        userDataDir: app.getPath("userData"),
        origin: handle.ready.origin,
        hash: workHash,
        sessionId: prepared.sessionId,
        cwd: project,
        transcriptUser: prepared.transcriptUser,
      });
      const restartContext = {
        bootId: prepared.bootId,
        rendererToken: handle.rendererToken,
        workHash,
        sessionTabs,
      };
      smokeRestartContext = restartContext;
      armSmokeRequest(directory, "restart-request", async () => {
        await verifyDesktopSmokeSessionTabsCommitted({
          webContents: window.webContents,
          userDataDir: app.getPath("userData"),
          receipt: sessionTabs,
        });
        const clearedSessionTabs = await clearDesktopSmokeSessionTabsStorage({
          webContents: window.webContents,
          userDataDir: app.getPath("userData"),
          receipt: sessionTabs,
        });
        restartContext.sessionTabs = clearedSessionTabs;
        const restarted = await requestDesktopSmokeRestart({
          origin: handle.ready.origin,
          rendererToken: handle.rendererToken,
          oldBootId: prepared.bootId,
          proxyUrl,
          fetch: async (input, init) => {
            if (new URL(input instanceof Request ? input.url : input).pathname === "/api/runtime/restart") {
              emitSmokeEvent(await verifyDesktopSmokeSessionTabsCleared({
                webContents: window.webContents,
                userDataDir: app.getPath("userData"),
                receipt: clearedSessionTabs,
                bootId: prepared.bootId,
              }));
            }
            return fetch(input, init);
          },
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
    emitSmokeEvent(await verifyDesktopSmokeSessionTabs({
      webContents: window.webContents,
      userDataDir: app.getPath("userData"),
      receipt: smokeRestartContext.sessionTabs,
      origin: handle.ready.origin,
      bootId: successor.bootId,
    }));
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
