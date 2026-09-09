import { useCallback, useEffect, useRef, useState } from "react";
import { isSameOrDescendantPath, parentFilesystemPath } from "../filesystem-path";

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
export function useLazyTree<T extends { path: string; kind?: string }>({
  root,
  loadChildren,
  enabled = true,
}: UseLazyTreeOptions<T>): UseLazyTreeResult<T> {
  const [stateMap, setStateMap] = useState<Map<string, NodeLoadState<T>>>(() => new Map());
  // Promise settlements must see each other even when React batches the rendered tree.
  const nodes = useRef(stateMap);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const inFlight = useRef<Map<string, number>>(new Map());
  const pendingRefresh = useRef<Set<string>>(new Set());
  const tokens = useRef(0);

  const commit = useCallback((next: Map<string, NodeLoadState<T>>) => {
    nodes.current = next;
    setStateMap(next);
  }, []);

  const load = useCallback(
    function loadDirectory(path: string) {
      if (!enabled) return;
      if (inFlight.current.has(path)) return;
      const token = ++tokens.current;
      inFlight.current.set(path, token);
      commit(
        new Map(nodes.current).set(path, { status: "loading", children: nodes.current.get(path)?.children ?? [] }),
      );
      const settle = (node: NodeLoadState<T>) => {
        if (inFlight.current.get(path) !== token) return;
        inFlight.current.delete(path);
        if (pendingRefresh.current.delete(path)) {
          loadDirectory(path);
          return;
        }
        // Reconcile against the latest cache, not the tree captured when this request began.
        const next = new Map(nodes.current);
        const directories = new Set(node.children.filter((child) => child.kind !== "file").map((child) => child.path));
        const removed = [...next.keys()].filter(
          (child) => child !== path && parentFilesystemPath(child) === path && !directories.has(child),
        );
        if (removed.length > 0) {
          const detached = (candidate: string) => removed.some((child) => isSameOrDescendantPath(child, candidate));
          for (const candidate of next.keys()) {
            if (!detached(candidate)) continue;
            next.delete(candidate);
            inFlight.current.delete(candidate);
            pendingRefresh.current.delete(candidate);
          }
          setExpanded((current) => new Set([...current].filter((candidate) => !detached(candidate))));
        }
        commit(next.set(path, node));
      };
      Promise.resolve()
        .then(() => loadChildren(path))
        .then(
          (children) => settle({ status: "loaded", children }),
          (error: unknown) => {
            settle({ status: "error", children: [], error: error instanceof Error ? error.message : String(error) });
          },
        );
    },
    [commit, enabled, loadChildren],
  );

  // Root or enablement changes are reset boundaries; adding load here would also reset when its callback identity changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: load is intentionally excluded from these reset boundaries.
  useEffect(() => {
    inFlight.current.clear();
    pendingRefresh.current.clear();
    commit(new Map());
    setExpanded(new Set());
    if (enabled) load(root);
    return () => {
      inFlight.current.clear();
      pendingRefresh.current.clear();
    };
  }, [root, enabled]);

  const toggle = useCallback(
    (path: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      const node = nodes.current.get(path);
      if (!node || node.status === "unloaded" || node.status === "error") load(path);
    },
    [load],
  );

  const retry = useCallback((path: string) => load(path), [load]);

  const refresh = useCallback(
    (path: string) => {
      const next = new Map(nodes.current);
      for (const key of next.keys()) {
        if (isSameOrDescendantPath(path, key)) next.delete(key);
      }
      commit(next);
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
      for (const key of pendingRefresh.current) {
        if (isSameOrDescendantPath(path, key)) pendingRefresh.current.delete(key);
      }
      load(path);
    },
    [commit, load],
  );

  const refreshDirectory = useCallback(
    (path: string) => {
      const node = nodes.current.get(path);
      if (!node || node.status === "unloaded") return;
      if (inFlight.current.has(path)) {
        pendingRefresh.current.add(path);
        return;
      }
      load(path);
    },
    [load],
  );

  const children = useCallback((path: string) => stateMap.get(path)?.children ?? [], [stateMap]);
  const status = useCallback((path: string) => stateMap.get(path)?.status ?? "unloaded", [stateMap]);
  const error = useCallback((path: string) => stateMap.get(path)?.error, [stateMap]);

  return { children, status, error, expanded, toggle, retry, refresh, refreshDirectory };
}
