import { useEffect, useRef, useState } from "react";

export type ExpandPhase = "enter" | "exit";

export const EXPAND_TRANSITION_MS = 200;

/** Keeps a collapsible body mounted while its exit animation plays, then
 * unmounts it. `phase` selects the enter ("expand") or exit ("collapse")
 * animation class; reopening during the exit phase switches back to enter. */
export function useExpandable(open: boolean): { mounted: boolean; phase: ExpandPhase } {
  const [state, setState] = useState<{ mounted: boolean; phase: ExpandPhase }>(() => ({
    mounted: open,
    phase: "enter",
  }));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setState((current) => (current.mounted ? { ...current, phase: "enter" } : { mounted: true, phase: "enter" }));
      return;
    }
    setState((current) => (current.mounted ? { mounted: true, phase: "exit" } : current));
    if (timer.current === null) {
      timer.current = setTimeout(() => {
        timer.current = null;
        setState({ mounted: false, phase: "enter" });
      }, EXPAND_TRANSITION_MS);
    }
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [open]);

  return state;
}