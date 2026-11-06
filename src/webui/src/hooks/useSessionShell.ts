import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusDto, WorkspaceMutationResultDto } from "../../../web/contracts";
import { listStatus, openSession, resumeRelocatedSession, workspaceMissingCwd } from "../api";
import { usePreferences } from "../preferences/PreferencesProvider";
import { resolveWorkSession, type WorkSession } from "../router";
import {
  closeSessionTab,
  reorderSessionTabs,
  type SessionTab,
  type SessionTabItem,
  snapshotSessionTabs,
} from "../session-tabs";

export interface SessionMetadata extends WorkSession {
  name?: string;
  status?: string;
}

export interface SessionView {
  generation: number;
  phase: "loading" | "ready" | "error";
  session: WorkSession;
  error?: string;
  missingCwd?: string;
  live?: boolean;
}

export interface HomeCatalogMutation {
  renamed(id: string, name: string): void;
  deleted(id: string): void;
  workspace(oldCwd: string, result: WorkspaceMutationResultDto, deleted: boolean): void;
  recovered?(previousId: string, session: SessionMetadata): boolean;
}

interface ShellState {
  tabs: SessionTabItem[];
  views: Record<string, SessionView>;
}

/** Document-local UI ownership. Neither hiding nor closing owns an Agent runtime. */
export function useSessionShell(
  getSelectedId: () => string | null,
  onSelectionRemoved: (id: string | null) => void,
  onSessionReplaced?: (previousId: string, session: WorkSession) => void,
) {
  const { preferences, updatePreferences } = usePreferences();
  const [state, setState] = useState<ShellState>(() => ({ tabs: preferences.sessionTabs ?? [], views: {} }));
  const current = useRef(state);
  const inputs = useRef({ getSelectedId, onSelectionRemoved, onSessionReplaced, updatePreferences });
  inputs.current = { getSelectedId, onSelectionRemoved, onSessionReplaced, updatePreferences };
  const generation = useRef(0);
  const versions = useRef(new Map<string, number>());
  const incarnations = useRef(new Map<string, number>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const commit = useCallback((next: ShellState, preferredId = inputs.current.getSelectedId()) => {
    if (!alive.current || next === current.current) return;
    const before = snapshotSessionTabs(current.current.tabs, inputs.current.getSelectedId());
    const after = snapshotSessionTabs(next.tabs, preferredId);
    current.current = next;
    setState(next);
    // Status/streaming and visibility changes never write bookmarks. Provider
    // callbacks can change identity on every render; they are deliberately refs.
    if (JSON.stringify(before) !== JSON.stringify(after)) inputs.current.updatePreferences({ sessionTabs: after });
  }, []);

  const metadata = useCallback(
    (value: SessionMetadata, owner?: number) => {
      const state = current.current;
      const tab = state.tabs.find((tab) => tab.id === value.id);
      const view = state.views[value.id];
      if (!tab || (owner !== undefined && view?.generation !== owner)) return;
      const next = {
        ...tab,
        cwd: value.cwd,
        name: value.name,
        status: Object.hasOwn(value, "status") ? value.status : tab.status,
      };
      const changed = next.cwd !== tab.cwd || next.name !== tab.name || next.status !== tab.status;
      if (!changed && (owner === undefined || view?.live)) return;
      versions.current.set(value.id, (versions.current.get(value.id) ?? 0) + 1);
      // A genuine cwd rebind invalidates the old view and every pending resolver.
      const relocated = tab.cwd !== value.cwd;
      const views = { ...state.views };
      if (relocated) {
        delete views[value.id];
        incarnations.current.set(value.id, (incarnations.current.get(value.id) ?? 0) + 1);
      } else if (owner !== undefined && view) views[value.id] = { ...view, live: true };
      commit({ tabs: state.tabs.map((tab) => (tab.id === value.id ? next : tab)), views });
    },
    [commit],
  );

  const remove = useCallback(
    (ids: string[]) => {
      const state = current.current;
      let tabs: SessionTabItem[] = state.tabs;
      // Router publication is synchronous; render-fed selection can still name
      // the root removed by an earlier SSE/HTTP completion in this same batch.
      const previousSelectedId = inputs.current.getSelectedId();
      let selectedId = previousSelectedId;
      const views = { ...state.views };
      for (const id of ids) {
        if (!tabs.some((tab) => tab.id === id)) continue;
        const result = closeSessionTab(tabs, id, selectedId);
        tabs = result.tabs;
        selectedId = result.selectedId;
        delete views[id];
        incarnations.current.set(id, (incarnations.current.get(id) ?? 0) + 1);
        versions.current.set(id, (versions.current.get(id) ?? 0) + 1);
      }
      if (tabs === state.tabs) return;
      commit({ tabs, views }, selectedId);
      if (previousSelectedId !== selectedId) inputs.current.onSelectionRemoved(selectedId);
    },
    [commit],
  );

  const close = useCallback(
    (id: string, owner?: number) => {
      if (owner !== undefined && current.current.views[id]?.generation !== owner) return;
      remove([id]);
    },
    [remove],
  );

  const acceptRecovery = useCallback(
    (previousId: string, next: SessionMetadata, owner?: number) => {
      const state = current.current;
      const previous = state.tabs.find((tab) => tab.id === previousId);
      if (!alive.current || !previous || (owner !== undefined && state.views[previousId]?.generation !== owner))
        return false;
      const target = state.tabs.find((tab) => tab.id === next.id);
      const replacement = { ...previous, ...next };
      const tabs =
        target && next.id !== previousId
          ? state.tabs
              .filter((tab) => tab.id !== previousId)
              .map((tab) => (tab.id === next.id ? { ...tab, cwd: next.cwd } : tab))
          : state.tabs.map((tab) => (tab.id === previousId ? replacement : tab));
      const views = { ...state.views };
      const targetView = views[next.id];
      delete views[previousId];
      views[next.id] =
        targetView?.phase === "ready" && targetView.session.cwd === next.cwd
          ? targetView
          : { generation: owner ?? ++generation.current, phase: "ready", session: { id: next.id, cwd: next.cwd } };
      incarnations.current.set(previousId, (incarnations.current.get(previousId) ?? 0) + 1);
      versions.current.set(previousId, (versions.current.get(previousId) ?? 0) + 1);
      versions.current.set(next.id, (versions.current.get(next.id) ?? 0) + 1);
      const selectedId = inputs.current.getSelectedId();
      commit({ tabs, views }, selectedId === previousId ? next.id : selectedId);
      inputs.current.onSessionReplaced?.(previousId, { id: next.id, cwd: next.cwd });
      return true;
    },
    [commit],
  );

  const resolve = useCallback(
    (requested: WorkSession, mode: "normal" | "retry" | "relocate" | "opened" = "normal", expectedOwner?: number) => {
      const state = current.current;
      if (expectedOwner !== undefined && state.views[requested.id]?.generation !== expectedOwner) return;
      const existing = state.tabs.find((tab) => tab.id === requested.id);
      if (mode === "normal" && state.views[requested.id]) return;
      const session = mode === "normal" && existing ? { id: existing.id, cwd: existing.cwd } : requested;
      const owner = ++generation.current;
      if (mode === "relocate") incarnations.current.set(session.id, (incarnations.current.get(session.id) ?? 0) + 1);
      const view: SessionView = { generation: owner, phase: mode === "opened" ? "ready" : "loading", session };
      versions.current.set(session.id, (versions.current.get(session.id) ?? 0) + 1);
      const metadataVersion = versions.current.get(session.id);
      const tabs = existing
        ? state.tabs.map((tab) => (tab.id === session.id ? { ...tab, cwd: session.cwd } : tab))
        : [...state.tabs, session];
      commit({ tabs, views: { ...state.views, [session.id]: view } });
      if (mode === "opened") return;
      let found: SessionMetadata | undefined;
      const fail = (error: unknown) => {
        const state = current.current;
        if (!alive.current || state.views[session.id]?.generation !== owner) return;
        commit({
          ...state,
          views: {
            ...state.views,
            [session.id]: {
              ...view,
              phase: "error",
              error: error instanceof Error ? error.message : String(error),
              missingCwd: workspaceMissingCwd(error) ?? undefined,
            },
          },
        });
      };
      const promise =
        mode === "relocate"
          ? resumeRelocatedSession(session.id, session.cwd).then((resolved) => {
              found = { id: resolved.id, cwd: resolved.cwd, name: resolved.sessionName, status: resolved.status };
              return resolved;
            })
          : resolveWorkSession(session.id, session.cwd, {
              listStatus: async () => {
                const status = await listStatus();
                const summary = status.sessions.find((item) => item.id === session.id);
                const active = status.activeSessions.find((item) => item.id === session.id);
                found = active
                  ? { id: active.id, cwd: active.cwd, name: active.sessionName, status: active.status }
                  : summary && { id: summary.id, cwd: summary.cwd, name: summary.name };
                return status;
              },
              openSession: async (path) => {
                if (!alive.current || current.current.views[session.id]?.generation !== owner)
                  throw new DOMException("View closed", "AbortError");
                const opened = await openSession(path);
                found = { id: opened.id, cwd: opened.cwd, name: opened.sessionName, status: opened.status };
                return opened;
              },
            });
      void promise.then((resolved) => {
        const state = current.current;
        if (!alive.current || state.views[session.id]?.generation !== owner) return;
        if (resolved.id !== session.id && mode !== "relocate") {
          fail(new Error("The opened session does not match the requested session"));
          return;
        }
        const next = { id: resolved.id, cwd: resolved.cwd };
        if (next.id !== session.id) {
          // Explicit recovery may recreate a never-persisted root. Preserve an
          // already-open target's state/order rather than mounting it twice.
          acceptRecovery(session.id, { ...found, ...next }, owner);
          return;
        }
        const tabs = state.tabs.map((tab) =>
          tab.id === session.id
            ? { ...tab, ...(versions.current.get(session.id) === metadataVersion ? found : undefined), ...next }
            : tab,
        );
        commit({ tabs, views: { ...state.views, [session.id]: { ...view, phase: "ready", session: next } } });
      }, fail);
    },
    [commit, acceptRecovery],
  );

  const captureStatus = useCallback(() => {
    const captured = new Map(current.current.tabs.map((tab) => [tab.id, versions.current.get(tab.id)]));
    return (status: StatusDto) => {
      const byId = new Map<string, SessionMetadata>();
      for (const session of status.sessions) byId.set(session.id, { ...session, status: undefined });
      for (const session of status.activeSessions) byId.set(session.id, { ...session, name: session.sessionName });
      for (const [id, version] of captured) {
        // Live Work owns current metadata. A slow Home poll cannot roll it back.
        if (versions.current.get(id) !== version || current.current.views[id]?.live) continue;
        const value = byId.get(id);
        if (value) metadata(value);
      }
    };
  }, [metadata]);

  const captureMutation = useCallback((): HomeCatalogMutation => {
    const captured = new Map(incarnations.current);
    const owns = (id: string) => captured.get(id) === incarnations.current.get(id);
    return {
      renamed(id, name) {
        const tab = current.current.tabs.find((tab) => tab.id === id);
        if (tab && owns(id)) metadata({ ...tab, name });
      },
      deleted(id) {
        if (owns(id)) close(id);
      },
      workspace(oldCwd, result, deleted) {
        if (deleted) {
          remove(result.sessionIds.filter(owns));
          return;
        }
        for (const id of result.sessionIds) {
          const tab = current.current.tabs.find((tab) => tab.id === id);
          if (!tab || !owns(id)) continue;
          metadata({ ...tab, cwd: result.cwd + tab.cwd.slice(oldCwd.length) });
          const incarnation = incarnations.current.get(id);
          if (incarnation === undefined) captured.delete(id);
          else captured.set(id, incarnation);
        }
      },
      recovered(previousId, session) {
        if (!alive.current || !owns(previousId)) return false;
        if (!current.current.tabs.some((tab) => tab.id === previousId)) return true;
        return acceptRecovery(previousId, session);
      },
    };
  }, [close, metadata, remove, acceptRecovery]);

  const reorder = useCallback(
    (from: string, to: string) => {
      commit({ ...current.current, tabs: reorderSessionTabs(current.current.tabs, from, to) });
    },
    [commit],
  );
  const getTab = useCallback(
    (id: string): SessionTab | undefined => current.current.tabs.find((tab) => tab.id === id),
    [],
  );
  const captureOpen = useCallback((id: string) => {
    const incarnation = incarnations.current.get(id);
    return () => alive.current && incarnation === incarnations.current.get(id);
  }, []);
  return { ...state, resolve, metadata, close, captureStatus, captureMutation, captureOpen, reorder, getTab };
}
