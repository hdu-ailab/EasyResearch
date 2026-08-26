import { Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { listStatus, openSession } from "./api";
import { TopbarIconButton } from "./components/Topbar";
import { useConfigurationEvents } from "./hooks/useConfigurationEvents";
import { useHashRoute } from "./hooks/useHashRoute";
import { useI18n } from "./i18n/useI18n";
import { ConfigPage } from "./pages/ConfigPage";
import { HomePage } from "./pages/HomePage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkPage } from "./pages/WorkPage";
import { resolveWorkSession, type WorkSession } from "./router";

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
  const { route, navigate } = useHashRoute();
  const [workResolved, setWorkResolved] = useState<WorkSession | null>(null);
  const [workError, setWorkError] = useState<string | null>(null);
  const [workRevision, setWorkRevision] = useState(0);

  useEffect(() => {
    if (route.page !== "work") return;
    let cancelled = false;
    setWorkResolved(null);
    setWorkError(null);
    resolveWorkSession(route.session.id, route.session.cwd, { listStatus, openSession })
      .then((session) => {
        if (cancelled) return;
        setWorkResolved(session);
        setWorkRevision((revision) => revision + 1);
      })
      .catch((error: unknown) => {
        if (!cancelled) setWorkError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [route]);

  const settingsButton = (
    <TopbarIconButton
      label={t("home.settings")}
      title={t("home.settingsTitle")}
      onClick={() => navigate({ page: "settings" })}
    >
      <Settings size={15} />
    </TopbarIconButton>
  );

  if (route.page === "work") {
    const session = workResolved !== null && workResolved.id === route.session.id ? workResolved : null;
    if (session) {
      return (
        <WorkPage
          key={`${session.id}:${workRevision}`}
          id={session.id}
          cwd={session.cwd}
          configurationGeneration={configuration.generation}
          configurationError={configuration.error}
          onBack={() => navigate({ page: "home" })}
          onOpenSettings={() => navigate({ page: "settings" })}
        />
      );
    }
    if (workError) {
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
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[12px] text-v2-text-text-muted">{t("work.loading")}</p>
      </div>
    );
  }

  if (route.page === "settings") {
    return (
      <SettingsPage
        onBack={() => navigate({ page: "home" })}
        onOpenConfigPage={() => navigate({ page: "config" })}
        configurationGeneration={configuration.generation}
        configurationError={configuration.error}
      />
    );
  }

  if (route.page === "config") {
    return <ConfigPage onBack={() => navigate({ page: "settings" })} />;
  }

  return (
    <HomePage
      onOpenSession={(session) => navigate({ page: "work", session })}
      onOpenSettings={() => navigate({ page: "settings" })}
      settingsButton={settingsButton}
    />
  );
}
