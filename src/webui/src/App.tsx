import { Settings } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import packageJson from "../../../package.json";
import { listStatus } from "./api";
import { RuntimeRestartOverlay } from "./components/RuntimeRestartOverlay";
import { SessionTabBar } from "./components/SessionTabBar";
import { SettingsModal } from "./components/settings/SettingsModal";
import { Topbar, TopbarIconButton } from "./components/Topbar";
import { WorkspaceDialog } from "./components/WorkspaceDialog";
import { useConfigurationEvents } from "./hooks/useConfigurationEvents";
import { useHashRoute } from "./hooks/useHashRoute";
import {
  type HomeCatalogMutation,
  type SessionMetadata,
  type SessionView,
  useSessionShell,
} from "./hooks/useSessionShell";
import { useI18n } from "./i18n/useI18n";
import { ConfigPage } from "./pages/ConfigPage";
import { HomePage } from "./pages/HomePage";
import { WorkPage } from "./pages/WorkPage";
import { isSettingsHostRoute, type WorkSession } from "./router";
import {
  pollForRuntimeReplacement,
  type RuntimeReplacementBrowser,
  type RuntimeReplacementPollDependencies,
  type RuntimeReplacementPollResult,
  reloadForRuntimeReplacement,
} from "./runtime-replacement";
import { sessionPanelDomId, sessionTabDomId } from "./session-tabs";
import { ViewActivityProvider } from "./view-activity";

const RUNTIME_RESTART_POLL_INTERVAL_MS = 500;
const RUNTIME_RESTART_TIMEOUT_MS = 30_000;

export type RuntimeReplacementPoller = (
  oldBootId: string,
  dependencies: RuntimeReplacementPollDependencies,
) => Promise<RuntimeReplacementPollResult>;

interface ExpectedRuntimeRestart {
  oldBootId: string;
  phase: "waiting" | "timed-out";
  attempt: number;
}

function waitForNextRuntimePoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, RUNTIME_RESTART_POLL_INTERVAL_MS);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function ViewSlot({
  visible,
  interactive,
  children,
  id,
  panelPrefix,
  visited = true,
}: {
  visible: boolean;
  interactive: boolean;
  children: ReactNode;
  id: string;
  panelPrefix?: string;
  visited?: boolean;
}) {
  return (
    <ViewActivityProvider visible={visible} interactive={interactive}>
      <div
        data-session-view={id}
        data-session-surface={visited ? id : undefined}
        data-session-active={visible}
        {...(panelPrefix === undefined
          ? {}
          : {
              id: sessionPanelDomId(panelPrefix, id),
              role: "tabpanel",
              "aria-labelledby": sessionTabDomId(panelPrefix, id),
            })}
        className="absolute inset-0"
        style={{ visibility: visible ? "visible" : "hidden" }}
        inert={!interactive ? true : undefined}
        aria-hidden={!interactive ? "true" : undefined}
      >
        {children}
      </div>
    </ViewActivityProvider>
  );
}

function RetainedWork({
  view,
  shell,
  actionsTarget,
  configuration,
  onBack,
  onOpenSettings,
  onMissing,
}: {
  view: SessionView;
  shell: ReturnType<typeof useSessionShell>;
  actionsTarget: HTMLElement | null;
  configuration: ReturnType<typeof useConfigurationEvents>;
  onBack(): void;
  onOpenSettings(): void;
  onMissing(session: WorkSession, generation: number): void;
}) {
  const { metadata, close, resolve } = shell;
  const { session, generation } = view;
  const onMetadata = useCallback(
    (next: SessionMetadata) => {
      if (next.id === session.id) metadata(next, generation);
    },
    [metadata, session.id, generation],
  );
  const onDeleted = useCallback((id: string) => close(id, generation), [close, generation]);
  const onWorkspaceMissing = useCallback(
    (cwd: string) => onMissing({ id: session.id, cwd }, generation),
    [onMissing, session.id, generation],
  );
  const onWorkspaceRelocated = useCallback(
    (next: WorkSession) => {
      if (next.id === session.id) resolve(next, "relocate", generation);
    },
    [resolve, session.id, generation],
  );
  return (
    <WorkPage
      id={session.id}
      cwd={session.cwd}
      shell={{ actionsTarget }}
      configurationGeneration={configuration.revision}
      configurationError={configuration.error}
      onSessionMetadata={onMetadata}
      onSessionDeleted={onDeleted}
      onWorkspaceMissing={onWorkspaceMissing}
      onWorkspaceRelocated={onWorkspaceRelocated}
      onBack={onBack}
      onOpenSettings={onOpenSettings}
    />
  );
}

/** The hash selects one lazy view; the catalog owns each visited view until close. */
export function App({
  runtimeReplacementBrowser,
  runtimeReplacementPoller = pollForRuntimeReplacement,
}: {
  runtimeReplacementBrowser?: RuntimeReplacementBrowser;
  runtimeReplacementPoller?: RuntimeReplacementPoller;
} = {}) {
  const { t } = useI18n();
  const sessionTabsPrefix = useId();
  const configuration = useConfigurationEvents();
  const {
    route,
    getRoute,
    navigate,
    replaceWorkSession,
    openSettings,
    closeSettings,
    openConfig,
    returnToSettings,
    registerSettingsCloseGuard,
  } = useHashRoute();
  const [missingWorkspaces, setMissingWorkspaces] = useState<
    Record<string, WorkSession & { generation: number; mutation: HomeCatalogMutation }>
  >({});
  const [homeDir, setHomeDir] = useState("/");
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsOpen = isSettingsHostRoute(route);
  const configOpen = route.page === "config";
  const hostRoute = configOpen ? route.returnTo : route;
  const previousSettingsOpen = useRef(settingsOpen);
  const runtimeReplacementHandled = useRef(false);
  const runtimePollAbort = useRef<AbortController | null>(null);
  const routeRef = useRef(route);
  routeRef.current = route;
  const [expectedRuntimeRestart, setExpectedRuntimeRestart] = useState<ExpectedRuntimeRestart | null>(null);
  const restarting = useRef(false);
  restarting.current = expectedRuntimeRestart !== null;
  const routeWorkId = hostRoute?.page === "work" ? hostRoute.session.id : null;
  const routeWorkCwd = hostRoute?.page === "work" ? hostRoute.session.cwd : null;
  const shellRef = useRef<ReturnType<typeof useSessionShell> | null>(null);
  const selectTab = useCallback(
    (id: string | null) => {
      const tab = id === null ? undefined : shellRef.current?.getTab(id);
      navigate(tab ? { page: "work", session: { id: tab.id, cwd: tab.cwd } } : { page: "home" });
    },
    [navigate],
  );
  const selectAfterRemoval = useCallback(
    (id: string | null) => {
      const tab = id === null ? undefined : shellRef.current?.getTab(id);
      const next = tab ? { page: "work" as const, session: { id: tab.id, cwd: tab.cwd } } : { page: "home" as const };
      const current = getRoute();
      if (current.page === "config") navigate({ page: "config", returnTo: { ...next, settingsOpen: true } });
      else if (isSettingsHostRoute(current)) openSettings(next);
      else navigate(next);
    },
    [navigate, openSettings, getRoute],
  );
  const replaceRecoveredSession = useCallback(
    (previousId: string, session: WorkSession) => {
      replaceWorkSession(session, previousId);
    },
    [replaceWorkSession],
  );
  const getSelectedSessionId = useCallback(() => {
    const current = getRoute();
    const host = current.page === "config" ? current.returnTo : current;
    return host?.page === "work" ? host.session.id : null;
  }, [getRoute]);
  const shell = useSessionShell(getSelectedSessionId, selectAfterRemoval, replaceRecoveredSession);
  shellRef.current = shell;
  const { resolve, captureStatus, captureMutation } = shell;
  const selectedView = routeWorkId ? shell.views[routeWorkId] : undefined;
  const selectedTab = shell.tabs.find((tab) => tab.id === routeWorkId);
  useEffect(() => {
    if (selectedTab && selectedTab.cwd !== routeWorkCwd)
      replaceWorkSession({ id: selectedTab.id, cwd: selectedTab.cwd });
  }, [selectedTab, routeWorkCwd, replaceWorkSession]);
  const mountedWorkCwd = selectedView?.phase === "ready" ? selectedView.session.cwd : undefined;
  const [homeVisited, setHomeVisited] = useState(hostRoute?.page === "home");
  const homeVisible = hostRoute?.page === "home" && !configOpen;
  useEffect(() => {
    if (hostRoute?.page === "home") setHomeVisited(true);
  }, [hostRoute?.page]);
  const setProjectInterests = configuration.setProjectInterests;
  const showMissingWorkspace = useCallback((session: WorkSession, generation: number) => {
    if (shellRef.current?.views[session.id]?.generation !== generation) return;
    const mutation = shellRef.current.captureMutation();
    setMissingWorkspaces((current) =>
      current[session.id]?.generation === generation && current[session.id]?.cwd === session.cwd
        ? current
        : { ...current, [session.id]: { ...session, generation, mutation } },
    );
    void listStatus()
      .then((status) => setHomeDir(status.homeDir))
      .catch(() => {});
  }, []);
  useEffect(() => {
    setMissingWorkspaces((current) => {
      const owned = Object.entries(current).filter(([id, value]) => shell.views[id]?.generation === value.generation);
      return owned.length === Object.keys(current).length ? current : Object.fromEntries(owned);
    });
  }, [shell.views]);
  useEffect(() => {
    if (selectedView?.missingCwd)
      showMissingWorkspace({ id: selectedView.session.id, cwd: selectedView.missingCwd }, selectedView.generation);
  }, [selectedView, showMissingWorkspace]);

  const onHomeOpenSession = useCallback(
    (session: WorkSession) => {
      const current = routeRef.current;
      if (current.page !== "home" || current.settingsOpen || restarting.current) return;
      if (shellRef.current?.views[session.id]?.phase !== "ready") resolve(session, "opened");
      navigate({ page: "work", session });
    },
    [navigate, resolve],
  );
  const goHome = useCallback(() => navigate({ page: "home" }), [navigate]);

  const reloadRuntime = useCallback(() => {
    if (runtimeReplacementHandled.current) return;
    runtimeReplacementHandled.current = true;
    runtimePollAbort.current?.abort();
    reloadForRuntimeReplacement(routeRef.current, runtimeReplacementBrowser);
  }, [runtimeReplacementBrowser]);

  useLayoutEffect(() => {
    if (configuration.runtimeReplaced) reloadRuntime();
  }, [configuration.runtimeReplaced, reloadRuntime]);

  const onRuntimeRestartAccepted = useCallback(
    (oldBootId: string) => {
      if (runtimeReplacementHandled.current) return;
      setExpectedRuntimeRestart({ oldBootId, phase: "waiting", attempt: 0 });
      const current = routeRef.current;
      if (isSettingsHostRoute(current)) closeSettings(current, { replace: true });
    },
    [closeSettings],
  );

  useEffect(() => {
    if (expectedRuntimeRestart?.phase !== "waiting" || window.easyresearchDesktop) return;
    const controller = new AbortController();
    runtimePollAbort.current?.abort();
    runtimePollAbort.current = controller;
    let active = true;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, RUNTIME_RESTART_TIMEOUT_MS);

    void runtimeReplacementPoller(expectedRuntimeRestart.oldBootId, {
      readStatus: (signal) => listStatus({ signal }),
      waitForNextAttempt: waitForNextRuntimePoll,
      signal: controller.signal,
      timedOut: () => timedOut,
    }).then((result) => {
      if (!active) return;
      if (result === "replaced") {
        reloadRuntime();
      } else if (result === "timed-out") {
        setExpectedRuntimeRestart((current) =>
          current?.attempt === expectedRuntimeRestart.attempt ? { ...current, phase: "timed-out" } : current,
        );
      }
    });

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
      if (runtimePollAbort.current === controller) runtimePollAbort.current = null;
    };
  }, [expectedRuntimeRestart, reloadRuntime, runtimeReplacementPoller]);

  const onSettingsProjectInterestChange = useCallback(
    (cwd?: string) => setProjectInterests("settings", cwd === undefined ? [] : [cwd]),
    [setProjectInterests],
  );
  const onConfigProjectInterestChange = useCallback(
    (cwd?: string) => setProjectInterests("config", cwd === undefined ? [] : [cwd]),
    [setProjectInterests],
  );

  useEffect(() => {
    if (routeWorkId === null || routeWorkCwd === null || selectedView) return;
    const current = getRoute();
    const host = current.page === "config" ? current.returnTo : current;
    if (host?.page !== "work" || host.session.id !== routeWorkId || host.session.cwd !== routeWorkCwd) return;
    resolve({ id: routeWorkId, cwd: routeWorkCwd });
  }, [routeWorkCwd, routeWorkId, resolve, selectedView, getRoute]);

  useEffect(() => {
    setProjectInterests("work", mountedWorkCwd === undefined ? [] : [mountedWorkCwd]);
  }, [mountedWorkCwd, setProjectInterests]);

  useEffect(
    () => () => {
      setProjectInterests("work", []);
    },
    [setProjectInterests],
  );

  useLayoutEffect(() => {
    if (previousSettingsOpen.current && !settingsOpen && !configOpen && !expectedRuntimeRestart) {
      settingsTriggerRef.current?.focus({ preventScroll: true });
    }
    previousSettingsOpen.current = settingsOpen;
  }, [configOpen, settingsOpen, expectedRuntimeRestart]);

  const settingsButton = (
    <TopbarIconButton
      buttonRef={settingsTriggerRef}
      label={t("home.settings")}
      title={t("home.settingsTitle")}
      onClick={() => openSettings(hostRoute ?? { page: "home" })}
    >
      <Settings size={15} />
    </TopbarIconButton>
  );

  const blocked = settingsOpen || configOpen || !!expectedRuntimeRestart;
  const workLoading = routeWorkId !== null && (!selectedView || selectedView.phase === "loading");
  const settingsMounted = useRef(false);
  if (!settingsOpen) settingsMounted.current = false;
  else if (!workLoading) settingsMounted.current = true;
  const recoveryDialogs = Object.values(missingWorkspaces).map((missingWorkspace) => {
    if (shell.views[missingWorkspace.id]?.generation !== missingWorkspace.generation) return null;
    const recoveryVisible = missingWorkspace.id === routeWorkId && !blocked;
    return (
      <ViewActivityProvider
        key={`${missingWorkspace.id}:${missingWorkspace.generation}`}
        visible={recoveryVisible}
        interactive={recoveryVisible}
      >
        <WorkspaceDialog
          key={`${missingWorkspace.id}:${missingWorkspace.generation}:${missingWorkspace.cwd}`}
          cwd={missingWorkspace.cwd}
          mode="missing"
          homeDir={homeDir}
          onClose={() =>
            setMissingWorkspaces((current) => {
              const next = { ...current };
              delete next[missingWorkspace.id];
              return next;
            })
          }
          onComplete={async (result, deleted) => {
            const ownsInitiator =
              shellRef.current?.views[missingWorkspace.id]?.generation === missingWorkspace.generation;
            missingWorkspace.mutation.workspace(missingWorkspace.cwd, result, deleted);
            if (!deleted && ownsInitiator) resolve({ id: missingWorkspace.id, cwd: result.cwd }, "relocate");
          }}
        />
      </ViewActivityProvider>
    );
  });

  return (
    <>
      {recoveryDialogs}
      <div
        data-app-surface
        className="flex h-full flex-col"
        style={{ visibility: configOpen ? "hidden" : undefined }}
        inert={blocked ? true : undefined}
        aria-hidden={blocked ? "true" : undefined}
      >
        <Topbar
          home={{ active: routeWorkId === null, onClick: goHome }}
          leading={
            <>
              <span className="shrink-0 rounded-md border border-v2-grey-300 bg-v2-background-bg-base px-1 py-0.5 font-mono text-[10px] text-v2-text-text-faint min-[360px]:px-1.5 min-[360px]:text-[11px]">
                v{packageJson.version}
              </span>
              {latestVersion && (
                <span
                  role="status"
                  title={`${t("home.updateAvailable")} v${latestVersion}`}
                  className="truncate text-[12px] font-medium text-v2-text-text-accent"
                >
                  {t("home.updateAvailable")} <span className="font-mono">v{latestVersion}</span>
                </span>
              )}
            </>
          }
          center={
            <SessionTabBar
              idPrefix={sessionTabsPrefix}
              disabled={blocked}
              tabs={shell.tabs.map((tab) => ({
                ...tab,
                loading: shell.views[tab.id]?.phase === "loading",
                error: shell.views[tab.id]?.phase === "error",
              }))}
              activeId={routeWorkId}
              onSelect={selectTab}
              onClose={shell.close}
              onNew={goHome}
              onReorder={shell.reorder}
            />
          }
          actions={
            <>
              <div ref={setActionsTarget} className="flex min-w-0 items-center gap-0.5" />
              {settingsButton}
            </>
          }
        />
        <div className="relative min-h-0 flex-1">
          {(homeVisited || hostRoute?.page === "home") && (
            <ViewSlot id="home" visible={homeVisible} interactive={homeVisible && !blocked}>
              <HomePage
                embedded
                onOpenSession={onHomeOpenSession}
                onOpenSettings={() => openSettings({ page: "home" })}
                settingsButton={null}
                onUpdateAvailable={setLatestVersion}
                onStatusRequest={captureStatus}
                onCatalogMutationStart={captureMutation}
                onSessionOpenStart={shell.captureOpen}
              />
            </ViewSlot>
          )}
          {shell.tabs.map((tab) => {
            const view = shell.views[tab.id];
            const visible = tab.id === routeWorkId && !configOpen;
            return (
              <ViewSlot
                key={`${tab.id}:${view?.generation ?? "bookmark"}`}
                id={tab.id}
                panelPrefix={sessionTabsPrefix}
                visited={view?.phase === "ready"}
                visible={visible}
                interactive={visible && !blocked}
              >
                {view?.phase === "ready" ? (
                  <RetainedWork
                    view={view}
                    shell={shell}
                    actionsTarget={actionsTarget}
                    configuration={configuration}
                    onBack={goHome}
                    onOpenSettings={() => openSettings({ page: "work", session: view.session })}
                    onMissing={showMissingWorkspace}
                  />
                ) : (
                  visible && (
                    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
                      {view?.phase === "error" ? (
                        <>
                          <p role="alert" className="max-w-[640px] text-[13px] text-v2-status-error">
                            {view.error}
                          </p>
                          <button
                            type="button"
                            className="er-outlined-button"
                            onClick={() => resolve(view.session, "retry")}
                          >
                            {t("sessionTabs.retry")}
                          </button>
                        </>
                      ) : (
                        <p className="text-[12px] text-v2-text-text-muted">{t("work.loading")}</p>
                      )}
                    </div>
                  )
                )}
              </ViewSlot>
            );
          })}
        </div>
      </div>
      {configOpen && (
        <div
          className="absolute inset-0"
          inert={expectedRuntimeRestart ? true : undefined}
          aria-hidden={expectedRuntimeRestart ? "true" : undefined}
        >
          <ConfigPage
            onHome={() => navigate({ page: "home" })}
            onBackToSettings={() => returnToSettings(route)}
            onProjectInterestChange={onConfigProjectInterestChange}
            configurationError={configuration.error}
          />
        </div>
      )}
      {settingsOpen && settingsMounted.current && (
        <SettingsModal
          configurationGeneration={configuration.revision}
          configurationError={configuration.error}
          onClose={() => closeSettings(route)}
          onOpenConfig={() => openConfig(route)}
          onProjectInterestChange={onSettingsProjectInterestChange}
          registerRouteCloseGuard={registerSettingsCloseGuard}
          onRuntimeRestartAccepted={onRuntimeRestartAccepted}
        />
      )}
      {expectedRuntimeRestart && (
        <RuntimeRestartOverlay
          phase={expectedRuntimeRestart.phase}
          desktop={window.easyresearchDesktop !== undefined}
          onRetry={() =>
            setExpectedRuntimeRestart((current) =>
              current ? { ...current, phase: "waiting", attempt: current.attempt + 1 } : current,
            )
          }
        />
      )}
    </>
  );
}
