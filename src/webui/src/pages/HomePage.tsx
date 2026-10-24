import { useCallback, useEffect, useRef, useState } from "react";
import packageJson from "../../../../package.json";
import type { ActiveSessionDto, SessionSummaryDto } from "../../../web/contracts";
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
import { useI18n } from "../i18n/useI18n";
import { buildHomeProjectGroups } from "./home-view-model";

export interface HomePageProps {
  onOpenSession: (session: { id: string; cwd: string }) => void;
  onOpenSettings: () => void;
  settingsButton: React.ReactNode;
}

const MONITOR_POLL_MS = 5000;

export function HomePage({ onOpenSession, settingsButton }: HomePageProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<{
    sessions: SessionSummaryDto[];
    activeSessions: ActiveSessionDto[];
    homeDir: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [disconnectingSessionId, setDisconnectingSessionId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [renamingSession, setRenamingSession] = useState<ActiveSessionDto | SessionSummaryDto | null>(null);
  const [deletingSession, setDeletingSession] = useState<ActiveSessionDto | SessionSummaryDto | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const statusRequest = useRef(0);
  const selectionRequest = useRef(0);
  const mounted = useRef(true);
  const [workspaceDialog, setWorkspaceDialog] = useState<{
    cwd: string;
    mode: WorkspaceDialogProps["mode"];
    sessionId?: string;
  } | null>(null);
  const reportFailure = useCallback((failure: unknown, sessionId?: string) => {
    if (!mounted.current) return;
    const cwd = workspaceMissingCwd(failure);
    if (cwd) setWorkspaceDialog({ cwd, mode: "missing", sessionId });
    else setError(failure instanceof Error ? failure.message : String(failure));
  }, []);
  const selectProject = useCallback(
    async (cwd: string | null) => {
      const request = ++selectionRequest.current;
      setSelectedCwd(cwd);
      if (cwd === null) return;
      try {
        await validateWorkspace(cwd);
      } catch (failure) {
        if (request === selectionRequest.current) reportFailure(failure);
      }
    },
    [reportFailure],
  );

  const refresh = useCallback(() => {
    const request = ++statusRequest.current;
    setError(null);
    listStatus()
      .then((next) => {
        if (request === statusRequest.current) setStatus(next);
      })
      .catch((e: unknown) => {
        if (request === statusRequest.current) setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => {
      mounted.current = false;
      statusRequest.current += 1;
      selectionRequest.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    checkForUpdate()
      .then((result) => {
        if (active) setLatestVersion(result.latestVersion);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(refresh, MONITOR_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const startSession = useCallback(
    async (cwd: string) => {
      setCreating(true);
      setError(null);
      try {
        const dto = await createSession(cwd);
        onOpenSession({ id: dto.id, cwd: dto.cwd });
      } catch (e) {
        reportFailure(e);
      } finally {
        setCreating(false);
      }
    },
    [onOpenSession, reportFailure],
  );

  const openHistory = useCallback(
    async (session: SessionSummaryDto) => {
      try {
        const dto = await openSession(session.path);
        onOpenSession({ id: dto.id, cwd: dto.cwd });
      } catch (e) {
        reportFailure(e, session.id);
      }
    },
    [onOpenSession, reportFailure],
  );

  const openActive = useCallback(
    async (session: ActiveSessionDto) => {
      try {
        await touchSession(session.id);
        onOpenSession({ id: session.id, cwd: session.cwd });
      } catch (e) {
        reportFailure(e, session.id);
      }
    },
    [onOpenSession, reportFailure],
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

  useEffect(() => {
    if (selectedCwd && !groups.some((group) => group.cwd === selectedCwd)) setSelectedCwd(null);
  }, [groups, selectedCwd]);

  return (
    <div className="flex h-full flex-col">
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
            <span className="hidden truncate text-[13px] text-v2-text-text-muted sm:inline">{t("home.workspace")}</span>
          )
        }
        actions={settingsButton}
      />
      <main className="er-home-main min-h-0 flex-1 overflow-y-auto bg-v2-background-bg-base">
        <div className="flex min-h-full w-full flex-col">
          {error && (
            <p
              className="shrink-0 border-b border-v2-status-error/30 bg-v2-status-error/5 px-5 py-3 text-[13px] text-v2-status-error"
              role="alert"
            >
              {error}
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
            onRenameWorkspace={(cwd) => setWorkspaceDialog({ cwd, mode: "rename" })}
            onDeleteWorkspace={(cwd) => setWorkspaceDialog({ cwd, mode: "delete" })}
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
            statusRequest.current += 1;
            selectionRequest.current += 1;
            const ids = new Set(result.sessionIds);
            const oldCwd = workspaceDialog.cwd;
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
            if (!deleted && workspaceDialog.sessionId) {
              try {
                const next = await resumeRelocatedSession(workspaceDialog.sessionId, result.cwd);
                if (mounted.current) onOpenSession({ id: next.id, cwd: next.cwd });
              } catch (failure) {
                if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
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
            setRenamingSession(null);
            setError(null);
            renameSession(session.id, name)
              .then(refresh)
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
            statusRequest.current += 1;
            await deleteSession(deletingSession.id, force);
            // Invalidate every pre-success poll before removing either projection.
            statusRequest.current += 1;
            setStatus(
              (current) =>
                current && {
                  ...current,
                  sessions: current.sessions.filter((session) => session.id !== deletingSession.id),
                  activeSessions: current.activeSessions.filter((session) => session.id !== deletingSession.id),
                },
            );
            refresh();
          }}
        />
      )}
    </div>
  );
}
