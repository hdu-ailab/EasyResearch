import { useCallback, useEffect, useRef, useState } from "react";
import packageJson from "../../../../package.json";
import type { ActiveSessionDto, SessionSummaryDto, StatusDto } from "../../../web/contracts";
import {
  checkForUpdate,
  createSession,
  deleteSession,
  listStatus,
  openSession,
  renameSession,
  resumeRelocatedSession,
  stopSession,
  touchSession,
  validateWorkspace,
  workspaceMissingCwd,
} from "../api";
import { DeleteSessionDialog } from "../components/DeleteSessionDialog";
import { DirectoryDialog } from "../components/DirectoryDialog";
import { HomeWorkspace } from "../components/HomeWorkspace";
import { RenameSessionDialog } from "../components/RenameSessionDialog";
import { Topbar } from "../components/Topbar";
import { WorkspaceDialog, type WorkspaceDialogProps } from "../components/WorkspaceDialog";
import type { HomeCatalogMutation } from "../hooks/useSessionShell";
import { useI18n } from "../i18n/useI18n";
import { useViewActivity, useViewActivityRef } from "../view-activity";
import { buildHomeProjectGroups } from "./home-view-model";

export interface HomePageProps {
  onOpenSession: (session: { id: string; cwd: string }) => void;
  onOpenSettings: () => void;
  settingsButton: React.ReactNode;
  embedded?: boolean;
  onUpdateAvailable?(version: string | null): void;
  onStatusRequest?(): (status: StatusDto) => void;
  onCatalogMutationStart?(): HomeCatalogMutation;
  onSessionOpenStart?(id: string): () => boolean;
}

const MONITOR_POLL_MS = 5000;

export function HomePage({
  onOpenSession,
  settingsButton,
  embedded = false,
  onUpdateAvailable,
  onStatusRequest,
  onCatalogMutationStart,
  onSessionOpenStart,
}: HomePageProps) {
  const { t } = useI18n();
  const { visible, interactive } = useViewActivity();
  const viewActivity = useViewActivityRef();
  const activity = useRef({ interactive, epoch: 0 });
  if (activity.current.interactive !== interactive)
    activity.current = { interactive, epoch: activity.current.epoch + 1 };
  const callbacks = useRef({ onUpdateAvailable, onStatusRequest, onCatalogMutationStart, onSessionOpenStart });
  callbacks.current = { onUpdateAvailable, onStatusRequest, onCatalogMutationStart, onSessionOpenStart };
  const openingRequest = useRef(0);
  const openingOwner = useCallback(() => {
    const request = ++openingRequest.current;
    const epoch = activity.current.epoch;
    return () =>
      mounted.current &&
      activity.current.interactive &&
      activity.current.epoch === epoch &&
      openingRequest.current === request;
  }, []);
  const [status, setStatus] = useState<{
    sessions: SessionSummaryDto[];
    activeSessions: ActiveSessionDto[];
    homeDir: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [disconnectingSessionId, setDisconnectingSessionId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [renamingSession, setRenamingSession] = useState<ActiveSessionDto | SessionSummaryDto | null>(null);
  const [deletingSession, setDeletingSession] = useState<ActiveSessionDto | SessionSummaryDto | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const statusRequest = useRef(0);
  const statusRead = useRef<AbortController | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionRequest = useRef(0);
  const mounted = useRef(true);
  const [workspaceDialog, setWorkspaceDialog] = useState<{
    cwd: string;
    mode: WorkspaceDialogProps["mode"];
    sessionId?: string;
    mutation?: HomeCatalogMutation;
    ownsSelection?: () => boolean;
    ownsTab?: () => boolean;
  } | null>(null);
  const reportFailure = useCallback(
    (failure: unknown, ownsSelection: () => boolean, sessionId?: string, ownsTab: () => boolean = () => true) => {
      if (!ownsSelection() || !ownsTab()) return;
      const cwd = workspaceMissingCwd(failure);
      if (cwd)
        setWorkspaceDialog({
          cwd,
          mode: "missing",
          sessionId,
          mutation: callbacks.current.onCatalogMutationStart?.(),
          ownsSelection,
          ownsTab,
        });
      else setError(failure instanceof Error ? failure.message : String(failure));
    },
    [],
  );
  const selectProject = useCallback(
    async (cwd: string | null) => {
      const request = ++selectionRequest.current;
      const ownsSelection = openingOwner();
      setSelectedCwd(cwd);
      setError(null);
      if (cwd === null) return;
      try {
        await validateWorkspace(cwd);
      } catch (failure) {
        reportFailure(failure, () => request === selectionRequest.current && ownsSelection());
      }
    },
    [reportFailure, openingOwner],
  );

  const cancelStatusRefresh = useCallback(() => {
    statusRequest.current += 1;
    if (statusTimer.current !== null) clearTimeout(statusTimer.current);
    statusTimer.current = null;
    const read = statusRead.current;
    statusRead.current = null;
    read?.abort();
  }, []);

  const refresh = useCallback((): void => {
    cancelStatusRefresh();
    const eligible = () => mounted.current && viewActivity.current.visible && document.visibilityState === "visible";
    if (!eligible()) return;
    const request = statusRequest.current;
    const controller = new AbortController();
    statusRead.current = controller;
    const ownsRead = () => eligible() && request === statusRequest.current && statusRead.current === controller;
    const read = async () => {
      try {
        const publish = callbacks.current.onStatusRequest?.();
        const next = await listStatus({ signal: controller.signal });
        if (ownsRead()) {
          setStatus(next);
          setStatusError(null);
          publish?.(next);
        }
      } catch (failure) {
        if (ownsRead()) setStatusError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        // Only this read's owner may schedule its successor. Aborted requests
        // can still settle after a hide, mutation, or replacement read.
        if (ownsRead()) {
          statusRead.current = null;
          statusTimer.current = setTimeout(() => {
            if (request === statusRequest.current) refresh();
          }, MONITOR_POLL_MS);
        }
      }
    };
    void read();
  }, [cancelStatusRefresh, viewActivity]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      selectionRequest.current += 1;
    };
  }, []);

  useEffect(() => {
    let eligible = false;
    const syncVisibility = () => {
      const next = visible && document.visibilityState === "visible";
      if (next === eligible) return;
      eligible = next;
      if (next) refresh();
      else cancelStatusRefresh();
    };
    document.addEventListener("visibilitychange", syncVisibility);
    syncVisibility();
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      cancelStatusRefresh();
    };
  }, [visible, refresh, cancelStatusRefresh]);

  useEffect(() => {
    let active = true;
    checkForUpdate()
      .then((result) => {
        if (active) {
          setLatestVersion(result.latestVersion);
          callbacks.current.onUpdateAvailable?.(result.latestVersion);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const startSession = useCallback(
    async (cwd: string) => {
      const ownsSelection = openingOwner();
      setCreating(true);
      setError(null);
      try {
        const dto = await createSession(cwd);
        if (ownsSelection()) onOpenSession({ id: dto.id, cwd: dto.cwd });
      } catch (e) {
        reportFailure(e, ownsSelection);
      } finally {
        setCreating(false);
      }
    },
    [onOpenSession, reportFailure, openingOwner],
  );

  const openHistory = useCallback(
    async (session: SessionSummaryDto) => {
      const ownsSelection = openingOwner();
      const ownsTab = callbacks.current.onSessionOpenStart?.(session.id) ?? (() => true);
      setError(null);
      try {
        const dto = await openSession(session.path);
        if (dto.id !== session.id) throw new Error("The opened session does not match the requested session");
        if (ownsSelection() && ownsTab()) onOpenSession({ id: dto.id, cwd: dto.cwd });
      } catch (e) {
        reportFailure(e, ownsSelection, session.id, ownsTab);
      }
    },
    [onOpenSession, reportFailure, openingOwner],
  );

  const openActive = useCallback(
    async (session: ActiveSessionDto) => {
      const ownsSelection = openingOwner();
      const ownsTab = callbacks.current.onSessionOpenStart?.(session.id) ?? (() => true);
      setError(null);
      try {
        await touchSession(session.id);
        if (ownsSelection() && ownsTab()) onOpenSession({ id: session.id, cwd: session.cwd });
      } catch (e) {
        reportFailure(e, ownsSelection, session.id, ownsTab);
      }
    },
    [onOpenSession, reportFailure, openingOwner],
  );

  const disconnectActive = useCallback(
    async (session: ActiveSessionDto) => {
      setDisconnectingSessionId(session.id);
      setError(null);
      try {
        await stopSession(session.id);
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setDisconnectingSessionId(null);
      }
    },
    [refresh],
  );

  const groups = buildHomeProjectGroups(status?.sessions ?? [], status?.activeSessions ?? []);
  const displayedError = error ?? statusError;

  useEffect(() => {
    if (selectedCwd && !groups.some((group) => group.cwd === selectedCwd)) setSelectedCwd(null);
  }, [groups, selectedCwd]);

  return (
    <div className="flex h-full flex-col">
      {!embedded && (
        <Topbar
          home={{ active: true }}
          leading={
            <span className="shrink-0 rounded-md border border-v2-grey-300 bg-v2-background-bg-base px-1 py-0.5 font-mono text-[10px] text-v2-text-text-faint min-[360px]:px-1.5 min-[360px]:text-[11px]">
              v{packageJson.version}
            </span>
          }
          center={
            latestVersion ? (
              <span
                role="status"
                title={`${t("home.updateAvailable")} v${latestVersion}`}
                className="truncate text-[12px] font-medium text-v2-text-text-accent"
              >
                {t("home.updateAvailable")} <span className="font-mono">v{latestVersion}</span>
              </span>
            ) : (
              <span className="hidden truncate text-[13px] text-v2-text-text-muted sm:inline">
                {t("home.workspace")}
              </span>
            )
          }
          actions={settingsButton}
        />
      )}
      <main className="er-home-main min-h-0 flex-1 overflow-y-auto bg-v2-background-bg-base">
        <div className="flex min-h-full w-full flex-col">
          {displayedError && (
            <p
              className="shrink-0 border-b border-v2-status-error/30 bg-v2-status-error/5 px-5 py-3 text-[13px] text-v2-status-error"
              role="alert"
            >
              {displayedError}
            </p>
          )}

          <HomeWorkspace
            groups={groups}
            selectedCwd={selectedCwd}
            query={query}
            onQueryChange={setQuery}
            loading={!status}
            creating={creating}
            onSelectProject={(cwd) => void selectProject(cwd)}
            onChooseDirectory={() => setDialogOpen(true)}
            onCreateInProject={(cwd) => void startSession(cwd)}
            onOpenActive={(session) => void openActive(session)}
            onDisconnectActive={(session) => void disconnectActive(session)}
            onOpenHistory={(session) => void openHistory(session)}
            onRenameSession={(session: ActiveSessionDto | SessionSummaryDto) => setRenamingSession(session)}
            onRenameHistory={(session) => setRenamingSession(session)}
            onDeleteSession={setDeletingSession}
            onRenameWorkspace={(cwd) =>
              setWorkspaceDialog({ cwd, mode: "rename", mutation: callbacks.current.onCatalogMutationStart?.() })
            }
            onDeleteWorkspace={(cwd) =>
              setWorkspaceDialog({ cwd, mode: "delete", mutation: callbacks.current.onCatalogMutationStart?.() })
            }
            disconnectingSessionId={disconnectingSessionId}
          />
        </div>
      </main>
      {dialogOpen && (
        <DirectoryDialog
          homeDir={status?.homeDir ?? "/"}
          onClose={() => setDialogOpen(false)}
          onSelect={(path) => {
            setDialogOpen(false);
            void startSession(path);
          }}
        />
      )}
      {workspaceDialog && (
        <WorkspaceDialog
          key={`${workspaceDialog.cwd}:${workspaceDialog.mode}`}
          cwd={workspaceDialog.cwd}
          mode={workspaceDialog.mode}
          homeDir={status?.homeDir ?? "/"}
          onClose={() => setWorkspaceDialog(null)}
          onComplete={async (result, deleted) => {
            if (!mounted.current) return;
            const ownsSelection = workspaceDialog.ownsSelection ?? (() => false);
            const canRecover = ownsSelection() && (workspaceDialog.ownsTab?.() ?? true);
            cancelStatusRefresh();
            selectionRequest.current += 1;
            const ids = new Set(result.sessionIds);
            const oldCwd = workspaceDialog.cwd;
            workspaceDialog.mutation?.workspace(oldCwd, result, deleted);
            setStatus(
              (current) =>
                current && {
                  ...current,
                  sessions: deleted
                    ? current.sessions.filter((session) => !ids.has(session.id))
                    : current.sessions.map((session) =>
                        ids.has(session.id)
                          ? { ...session, cwd: result.cwd + session.cwd.slice(oldCwd.length) }
                          : session,
                      ),
                  activeSessions: current.activeSessions.filter((session) => !ids.has(session.id)),
                },
            );
            setSelectedCwd((current) => (current === oldCwd ? (deleted ? null : result.cwd) : current));
            refresh();
            if (!deleted && workspaceDialog.sessionId && canRecover) {
              try {
                const next = await resumeRelocatedSession(workspaceDialog.sessionId, result.cwd);
                const accepted =
                  workspaceDialog.mutation?.recovered?.(workspaceDialog.sessionId, {
                    id: next.id,
                    cwd: next.cwd,
                    name: next.sessionName,
                    status: next.status,
                  }) ?? true;
                if (accepted && ownsSelection()) onOpenSession({ id: next.id, cwd: next.cwd });
              } catch (failure) {
                if (ownsSelection()) setError(failure instanceof Error ? failure.message : String(failure));
              }
            }
          }}
        />
      )}
      {renamingSession && (
        <RenameSessionDialog
          currentName={
            "isStreaming" in renamingSession ? (renamingSession.sessionName ?? "") : (renamingSession.name ?? "")
          }
          onClose={() => setRenamingSession(null)}
          onSave={(name) => {
            const session = renamingSession;
            const mutation = callbacks.current.onCatalogMutationStart?.();
            setRenamingSession(null);
            setError(null);
            renameSession(session.id, name)
              .then(() => {
                mutation?.renamed(session.id, name);
                refresh();
              })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
          }}
        />
      )}
      {deletingSession && (
        <DeleteSessionDialog
          key={deletingSession.id}
          session={deletingSession}
          onClose={() => setDeletingSession(null)}
          onDelete={async (force) => {
            const mutation = callbacks.current.onCatalogMutationStart?.();
            cancelStatusRefresh();
            try {
              await deleteSession(deletingSession.id, force);
              mutation?.deleted(deletingSession.id);
              // Invalidate every pre-success poll before removing either projection.
              cancelStatusRefresh();
              setStatus(
                (current) =>
                  current && {
                    ...current,
                    sessions: current.sessions.filter((session) => session.id !== deletingSession.id),
                    activeSessions: current.activeSessions.filter((session) => session.id !== deletingSession.id),
                  },
              );
            } finally {
              refresh();
            }
          }}
        />
      )}
    </div>
  );
}
