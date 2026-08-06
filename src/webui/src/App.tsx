import { useState } from "react";
import { Settings } from "lucide-react";
import { HomePage } from "./pages/HomePage";
import { WorkPage } from "./pages/WorkPage";
import { ConfigPage } from "./pages/ConfigPage";
import { TopbarIconButton } from "./components/Topbar";

export interface ActiveSession {
  id: string;
  cwd: string;
}

type Route =
  | { page: "home" }
  | { page: "config" }
  | { page: "work"; session: ActiveSession };

export function App() {
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

  if (route.page === "config") {
    return <ConfigPage onBack={() => setRoute({ page: "home" })} />;
  }

  return (
    <HomePage
      onOpenSession={(session) => setRoute({ page: "work", session })}
      onOpenSettings={() => setRoute({ page: "config" })}
      settingsButton={<TopbarIconButton label="Settings" title="Open global config" onClick={() => setRoute({ page: "config" })}>
        <Settings size={15} />
      </TopbarIconButton>}
    />
  );
}
