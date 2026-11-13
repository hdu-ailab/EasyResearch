import { useLayoutEffect, useState } from "react";

const DESKTOP_QUERY = "(min-width: 820px)";

/** Work owns the viewport breakpoint; standalone file browsers may own the same query locally. */
export function useWorkBreakpoint(ownedMobile?: boolean): boolean {
  const [mobile, setMobile] = useState(
    () =>
      ownedMobile ??
      (typeof window.matchMedia === "function" ? !window.matchMedia(DESKTOP_QUERY).matches : window.innerWidth < 820),
  );

  useLayoutEffect(() => {
    if (ownedMobile !== undefined) return;
    if (typeof window.matchMedia === "function") {
      const query = window.matchMedia(DESKTOP_QUERY);
      const update = () => setMobile(!query.matches);
      query.addEventListener("change", update);
      update();
      return () => query.removeEventListener("change", update);
    }
    // Non-browser renderers without media-query support retain a working layout.
    const update = () => setMobile(window.innerWidth < 820);
    window.addEventListener("resize", update);
    update();
    return () => window.removeEventListener("resize", update);
  }, [ownedMobile]);

  return ownedMobile ?? mobile;
}
