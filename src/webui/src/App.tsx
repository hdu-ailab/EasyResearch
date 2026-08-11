import { Settings } from "lucide-react";
import { useState } from "react";
import { TopbarIconButton } from "./components/Topbar";
import { useI18n } from "./i18n/useI18n";
import { ConfigPage } from "./pages/ConfigPage";
import { HomePage } from "./pages/HomePage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkPage } from "./pages/WorkPage";

export interface ActiveSession {
  id: string;
  cwd: string;
}

type Route = { page: "home" } | { page: "config" } | { page: "config-json" } | { page: "work"; session: ActiveSession };

export function App() {
  const { t } = useI18n();
  const [route, setRoute] = useState<Route>({ page: "home" });

  if (route.page === "work") {
    return (
      <WorkPage
        key={route.session.id}
        id={route.session.id}
        cwd={route.session.cwd}
        onBack={() => setRoute({ page: "home" })}
      />
    );
  }

  if (route.page === "config-json") {
    return <ConfigPage onBack={() => setRoute({ page: "config" })} />;
  }

  if (route.page === "config") {
    return (
      <SettingsPage
        onBack={() => setRoute({ page: "home" })}
        onOpenConfigPage={() => setRoute({ page: "config-json" })}
      />
    );
  }

  return (
    <HomePage
      onOpenSession={(session) => setRoute({ page: "work", session })}
      onOpenSettings={() => setRoute({ page: "config" })}
      settingsButton={
        <TopbarIconButton
          label={t("home.settings")}
          title={t("home.settingsTitle")}
          onClick={() => setRoute({ page: "config" })}
        >
          <Settings size={15} />
        </TopbarIconButton>
      }
    />
  );
}
