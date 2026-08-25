import { useEffect, useRef, useState } from "react";

export type PanelPhase = "open" | "closing" | "closed";

export const PANEL_TRANSITION_MS = 200;

export function usePanelTransition(open: boolean): PanelPhase {
  const [phase, setPhase] = useState<PanelPhase>(() => (open ? "open" : "closed"));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setPhase("open");
      return;
    }
    setPhase((current) => (current === "open" || current === "closing" ? "closing" : current));
    if (timer.current === null) {
      timer.current = setTimeout(() => {
        timer.current = null;
        setPhase("closed");
      }, PANEL_TRANSITION_MS);
    }
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [open]);

  return phase;
}
