import { Settings } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
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
    resolved: WorkSession;
  } | null>(null);
  const [workRevision, setWorkRevision] = useState(0);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsOpen = isSettingsHostRoute(route);
  const configOpen = route.page === "config";
  const hostRoute = configOpen ? route.returnTo : route;
  const previousSettingsOpen = useRef(settingsOpen);
  const routeWorkId = hostRoute?.page === "work" ? hostRoute.session.id : null;
  const routeWorkCwd = hostRoute?.page === "work" ? hostRoute.session.cwd : null;

  useEffect(() => {
    if (routeWorkId === null || routeWorkCwd === null) return;
    let cancelled = false;
    const requested = { id: routeWorkId, cwd: routeWorkCwd };
    resolveWorkSession(routeWorkId, routeWorkCwd, { listStatus, openSession }).then((resolved) => {
      if (cancelled) return;
      setWorkResolution({ requested, resolved });
      setWorkRevision((revision) => revision + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [routeWorkCwd, routeWorkId]);

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
  if (hostRoute?.page === "work") {
    const session =
      workResolution?.requested.id === hostRoute.session.id && workResolution.requested.cwd === hostRoute.session.cwd
        ? workResolution.resolved
        : null;
    if (!session) {
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
        <ConfigPage onHome={() => navigate({ page: "home" })} onBackToSettings={() => returnToSettings(route)} />
      )}
      {settingsOpen && (
        <SettingsModal
          configurationGeneration={configuration.generation}
          configurationError={configuration.error}
          onClose={() => closeSettings(route)}
          onOpenConfig={() => openConfig(route)}
          registerRouteCloseGuard={registerSettingsCloseGuard}
        />
      )}
    </>
  );
}
