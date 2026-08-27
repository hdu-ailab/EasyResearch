import { Settings } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listStatus, openSession } from "./api";
import { SettingsModal } from "./components/settings/SettingsModal";
import { TopbarIconButton } from "./components/Topbar";
import { useConfigurationEvents } from "./hooks/useConfigurationEvents";
import { useHashRoute } from "./hooks/useHashRoute";
import { useI18n } from "./i18n/useI18n";
import { ConfigPage } from "./pages/ConfigPage";
import { HomePage } from "./pages/HomePage";
import { WorkPage } from "./pages/WorkPage";
import { isSettingsHostRoute, resolveWorkSession, type WorkSession } from "./router";

/**
 * Hash-routed page shell (ADR-076): the URL keeps the current page across
 * refreshes. Entering the work route resolves the session id through the
 * status listing plus `POST /api/sessions/open` before mounting WorkPage, so
 * a refresh resumes the persisted session instead of erroring; every
 * completed resolve remounts WorkPage so its connection attaches after the
 * resume.
 */
export function App() {
  const { t } = useI18n();
  const configuration = useConfigurationEvents();
  const { route, navigate, openSettings, closeSettings, openConfig, returnToSettings, registerSettingsCloseGuard } =
    useHashRoute();
  const [workResolution, setWorkResolution] = useState<{
    requested: WorkSession;
    resolved: WorkSession | null;
    error: string | null;
  } | null>(null);
  const [workRevision, setWorkRevision] = useState(0);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsOpen = isSettingsHostRoute(route);
  const configOpen = route.page === "config";
  const hostRoute = configOpen ? route.returnTo : route;
  const previousSettingsOpen = useRef(settingsOpen);
  const routeWorkId = hostRoute?.page === "work" ? hostRoute.session.id : null;
  const routeWorkCwd = hostRoute?.page === "work" ? hostRoute.session.cwd : null;
  const resolvedWorkSession =
    hostRoute?.page === "work" &&
    workResolution?.requested.id === hostRoute.session.id &&
    workResolution.requested.cwd === hostRoute.session.cwd
      ? workResolution.resolved
      : null;
  const mountedWorkCwd = resolvedWorkSession?.cwd;
  const setProjectInterests = configuration.setProjectInterests;

  const onSettingsProjectInterestChange = useCallback(
    (cwd?: string) => setProjectInterests("settings", cwd === undefined ? [] : [cwd]),
    [setProjectInterests],
  );
  const onConfigProjectInterestChange = useCallback(
    (cwd?: string) => setProjectInterests("config", cwd === undefined ? [] : [cwd]),
    [setProjectInterests],
  );

  useEffect(() => {
    if (routeWorkId === null || routeWorkCwd === null) return;
    let cancelled = false;
    const requested = { id: routeWorkId, cwd: routeWorkCwd };
    setWorkResolution({ requested, resolved: null, error: null });
    resolveWorkSession(routeWorkId, routeWorkCwd, { listStatus, openSession })
      .then((resolved) => {
        if (cancelled) return;
        setWorkResolution({ requested, resolved, error: null });
        setWorkRevision((revision) => revision + 1);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setWorkResolution({
          requested,
          resolved: null,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [routeWorkCwd, routeWorkId]);

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
    if (previousSettingsOpen.current && !settingsOpen && !configOpen) {
      settingsTriggerRef.current?.focus({ preventScroll: true });
    }
    previousSettingsOpen.current = settingsOpen;
  }, [configOpen, settingsOpen]);

  const settingsButton = (
    <TopbarIconButton
      buttonRef={settingsTriggerRef}
      label={t("home.settings")}
      title={t("home.settingsTitle")}
      onClick={() => openSettings({ page: "home" })}
    >
      <Settings size={15} />
    </TopbarIconButton>
  );

  let baseSurface: ReactNode = null;
  let workLoading = false;
  let workError: string | null = null;
  if (hostRoute?.page === "work") {
    const resolution =
      workResolution?.requested.id === hostRoute.session.id && workResolution.requested.cwd === hostRoute.session.cwd
        ? workResolution
        : null;
    const session = resolvedWorkSession;
    if (resolution?.error) {
      workError = resolution.error;
    } else if (!session) {
      workLoading = true;
    } else {
      baseSurface = (
        <WorkPage
          key={`${session.id}:${workRevision}`}
          id={session.id}
          cwd={session.cwd}
          configurationGeneration={configuration.generation}
          configurationError={configuration.error}
          onBack={() => navigate({ page: "home" })}
          onOpenSettings={() => openSettings(hostRoute)}
          settingsButtonRef={settingsTriggerRef}
        />
      );
    }
  } else if (hostRoute?.page === "home") {
    baseSurface = (
      <HomePage
        onOpenSession={(session) => navigate({ page: "work", session })}
        onOpenSettings={() => openSettings(hostRoute)}
        settingsButton={settingsButton}
      />
    );
  }

  if (workError && !configOpen) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p role="alert" className="max-w-[640px] text-[13px] text-v2-status-error">
          {workError}
        </p>
        <button
          type="button"
          className="h-8 rounded-md border border-v2-grey-200 px-3 text-[12px] text-v2-text-text-base hover:bg-v2-grey-100"
          onClick={() => navigate({ page: "home" })}
        >
          {t("topbar.backToHome")}
        </button>
      </div>
    );
  }

  if (workLoading && !configOpen) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[12px] text-v2-text-text-muted">{t("work.loading")}</p>
      </div>
    );
  }

  return (
    <>
      {baseSurface && (
        <div
          data-app-surface
          className="h-full"
          hidden={configOpen}
          inert={settingsOpen || configOpen ? true : undefined}
          aria-hidden={settingsOpen || configOpen ? "true" : undefined}
        >
          {baseSurface}
        </div>
      )}
      {configOpen && (
        <ConfigPage
          onHome={() => navigate({ page: "home" })}
          onBackToSettings={() => returnToSettings(route)}
          onProjectInterestChange={onConfigProjectInterestChange}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          configurationGeneration={configuration.generation}
          configurationError={configuration.error}
          onClose={() => closeSettings(route)}
          onOpenConfig={() => openConfig(route)}
          onProjectInterestChange={onSettingsProjectInterestChange}
          registerRouteCloseGuard={registerSettingsCloseGuard}
        />
      )}
    </>
  );
}
