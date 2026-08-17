import { Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { listStatus, openSession } from "./api";
import { TopbarIconButton } from "./components/Topbar";
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
  const { route, navigate } = useHashRoute();
  const [workResolved, setWorkResolved] = useState<WorkSession | null>(null);
  const [workRevision, setWorkRevision] = useState(0);

  useEffect(() => {
    if (route.page !== "work") return;
    let cancelled = false;
    resolveWorkSession(route.session.id, route.session.cwd, { listStatus, openSession }).then((session) => {
      if (cancelled) return;
      setWorkResolved(session);
      setWorkRevision((revision) => revision + 1);
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
          onBack={() => navigate({ page: "home" })}
          onOpenSettings={() => navigate({ page: "settings" })}
        />
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
      <SettingsPage onBack={() => navigate({ page: "home" })} onOpenConfigPage={() => navigate({ page: "config" })} />
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
