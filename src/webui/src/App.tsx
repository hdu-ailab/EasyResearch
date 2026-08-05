import { useState } from "react";
import { Settings } from "lucide-react";
import { HomePage } from "./pages/HomePage";
import { WorkPage } from "./pages/WorkPage";
import { ConfigBrowser } from "./components/ConfigBrowser";
import { BackButton, ProductMark, Topbar, TopbarIconButton } from "./components/Topbar";

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
    return (
      <div className="flex h-full flex-col">
        <Topbar
          leading={
            <>
              <BackButton onClick={() => setRoute({ page: "home" })} />
              <ProductMark />
            </>
          }
          center={<span className="truncate text-[13px] text-v2-text-text-muted">Settings — global config</span>}
        />
        <div className="min-h-0 flex-1 p-4">
          <ConfigBrowser />
        </div>
      </div>
    );
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
