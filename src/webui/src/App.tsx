import { useState } from "react";
import { HomePage } from "./pages/HomePage";
import { WorkPage } from "./pages/WorkPage";

export interface ActiveSession {
  id: string;
  cwd: string;
}

export function App() {
  const [active, setActive] = useState<ActiveSession | null>(null);

  if (active) {
    return <WorkPage id={active.id} cwd={active.cwd} onBack={() => setActive(null)} />;
  }
  return <HomePage homeDir="/" onOpenSession={setActive} />;
}
