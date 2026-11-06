import { createContext, type ReactNode, type RefObject, useContext, useLayoutEffect, useMemo, useRef } from "react";

interface ViewActivity {
  visible: boolean;
  interactive: boolean;
}

const standalone: ViewActivity = { visible: true, interactive: true };
const ViewActivityContext = createContext<{ state: ViewActivity; live: RefObject<ViewActivity> }>({
  state: standalone,
  live: { current: standalone },
});

/** Presentation ownership only: never use this boundary to stop a runtime or release its view lease. */
export function ViewActivityProvider({ visible, interactive, children }: ViewActivity & { children: ReactNode }) {
  const parent = useViewActivity();
  const state = useMemo(
    () => ({ visible: parent.visible && visible, interactive: parent.interactive && visible && interactive }),
    [parent.visible, parent.interactive, visible, interactive],
  );
  const live = useRef(state);
  live.current = state;
  // Parent layout cleanup precedes descendant modal cleanup on view disposal.
  // Closing a retained root must not restore focus into its about-to-detach DOM.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only disposal invalidates this owner; renders already publish current activity.
  useLayoutEffect(() => {
    live.current = state;
    return () => {
      live.current = { visible: false, interactive: false };
    };
  }, []);
  const value = useMemo(() => ({ state, live }), [state]);
  return <ViewActivityContext value={value}>{children}</ViewActivityContext>;
}

export function useViewActivity(): ViewActivity {
  return useContext(ViewActivityContext).state;
}

/** Async completions and imperative handles must consult the current owner, not their starting render. */
export function useViewActivityRef() {
  return useContext(ViewActivityContext).live;
}
