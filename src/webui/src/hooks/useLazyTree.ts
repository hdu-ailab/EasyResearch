import { useCallback, useEffect, useRef, useState } from "react";
import { isSameOrDescendantPath } from "../filesystem-path";

export type NodeLoadStatus = "unloaded" | "loading" | "loaded" | "error";

export interface NodeLoadState<T> {
  status: NodeLoadStatus;
  children: T[];
  error?: string;
}

export interface UseLazyTreeOptions<T> {
  root: string;
  loadChildren: (path: string) => Promise<T[]>;
  enabled?: boolean;
}

export interface UseLazyTreeResult<T> {
  children: (path: string) => T[];
  status: (path: string) => NodeLoadStatus;
  error: (path: string) => string | undefined;
  expanded: Set<string>;
  toggle: (path: string) => void;
  retry: (path: string) => void;
  refresh: (path: string) => void;
  refreshDirectory: (path: string) => void;
}

/**
 * Shared explicit lazy-tree state. The root is loaded in an effect; child
 * loading starts only from `toggle` or `retry`. Each request carries an
 * identity token (`inFlight` ref) so stale resolutions are ignored after the
 * `root` changes or a `refresh` invalidates a path. `load` is idempotent per
 * path: it refuses to start a second request while one is already in flight,
 * so rapid batched toggles can never duplicate a fetch.
 */
export function useLazyTree<T>({ root, loadChildren, enabled = true }: UseLazyTreeOptions<T>): UseLazyTreeResult<T> {
  const [stateMap, setStateMap] = useState<Map<string, NodeLoadState<T>>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const inFlight = useRef<Map<string, number>>(new Map());
  const pendingRefresh = useRef<Set<string>>(new Set());
  const tokens = useRef(0);

  const load = useCallback(
    (path: string) => {
      if (!enabled) return;
      if (inFlight.current.has(path)) return;
      const token = ++tokens.current;
      inFlight.current.set(path, token);
      setStateMap((current) => new Map(current).set(path, { status: "loading", children: [] }));
      Promise.resolve()
        .then(() => loadChildren(path))
        .then(
          (children) => {
            if (inFlight.current.get(path) !== token) return;
            inFlight.current.delete(path);
            setStateMap((current) => new Map(current).set(path, { status: "loaded", children }));
          },
          (error: unknown) => {
            if (inFlight.current.get(path) !== token) return;
            inFlight.current.delete(path);
            setStateMap((current) =>
              new Map(current).set(path, {
                status: "error",
                children: [],
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          },
        );
    },
    [enabled, loadChildren],
  );

  // Root or enablement changes are reset boundaries; adding load here would also reset when its callback identity changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: load is intentionally excluded from these reset boundaries.
  useEffect(() => {
    inFlight.current.clear();
    pendingRefresh.current.clear();
    setStateMap(new Map());
    setExpanded(new Set());
    if (enabled) load(root);
  }, [root, enabled]);

  useEffect(() => {
    for (const path of pendingRefresh.current) {
      if (stateMap.get(path)?.status !== "loaded") continue;
      pendingRefresh.current.delete(path);
      load(path);
    }
  }, [load, stateMap]);

  const toggle = useCallback(
    (path: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      const node = stateMap.get(path);
      if (!node || node.status === "unloaded" || node.status === "error") load(path);
    },
    [stateMap, load],
  );

  const retry = useCallback((path: string) => load(path), [load]);

  const refresh = useCallback(
    (path: string) => {
      setStateMap((current) => {
        const next = new Map(current);
        for (const key of current.keys()) {
          if (isSameOrDescendantPath(path, key)) next.delete(key);
        }
        return next;
      });
      setExpanded((current) => {
        const next = new Set(current);
        for (const key of current) {
          if (isSameOrDescendantPath(path, key)) next.delete(key);
        }
        return next;
      });
      for (const key of [...inFlight.current.keys()]) {
        if (isSameOrDescendantPath(path, key)) inFlight.current.delete(key);
      }
      load(path);
    },
    [load],
  );

  const refreshDirectory = useCallback(
    (path: string) => {
      const node = stateMap.get(path);
      if (!node || node.status === "unloaded" || node.status === "error") return;
      if (node.status === "loading") {
        pendingRefresh.current.add(path);
        return;
      }
      inFlight.current.delete(path);
      load(path);
    },
    [load, stateMap],
  );

  const children = useCallback((path: string) => stateMap.get(path)?.children ?? [], [stateMap]);
  const status = useCallback((path: string) => stateMap.get(path)?.status ?? "unloaded", [stateMap]);
  const error = useCallback((path: string) => stateMap.get(path)?.error, [stateMap]);

  return { children, status, error, expanded, toggle, retry, refresh, refreshDirectory };
}
