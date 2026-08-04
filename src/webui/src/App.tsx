import { useState } from "react";
import { HomePage } from "./pages/HomePage";
import { WorkPage } from "./pages/WorkPage";

export function App() {
  const [active, setActive] = useState<{ cwd: string } | null>(null);

  if (active) {
    return <WorkPage cwd={active.cwd} onBack={() => setActive(null)} />;
  }
  return <HomePage onOpenSession={(cwd) => setActive({ cwd })} />;
}
