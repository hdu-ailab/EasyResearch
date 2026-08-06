import { useCallback, useEffect, useState } from "react";
import { Activity, FolderSearch, Settings2, History } from "lucide-react";
import { createSession, listStatus, openSession, restartSession } from "../api";
import { DirectoryDialog } from "../components/DirectoryDialog";
import { SessionList } from "../components/SessionList";
import { ProductMark, Topbar } from "../components/Topbar";
import type { ActiveSessionDto, SessionSummaryDto } from "../../../web/contracts";

export interface HomePageProps {
  onOpenSession: (session: { id: string; cwd: string }) => void;
  onOpenSettings: () => void;
  settingsButton: React.ReactNode;
}

const MONITOR_POLL_MS = 5000;

export function HomePage({ onOpenSession, onOpenSettings, settingsButton }: HomePageProps) {
  const [status, setStatus] = useState<{ sessions: SessionSummaryDto[]; activeSessions: ActiveSessionDto[]; homeDir: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const refresh = useCallback(() => {
    setError(null);
    listStatus()
      .then(setStatus)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(refresh, [refresh]);

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
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setCreating(false);
      }
    },
    [onOpenSession],
  );

  const openHistory = useCallback(
    async (session: SessionSummaryDto) => {
      try {
        const dto = await openSession(session.path);
        onOpenSession({ id: dto.id, cwd: dto.cwd });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [onOpenSession],
  );

  const openActive = useCallback(
    async (session: ActiveSessionDto) => {
      if (session.status === "stopped" || session.status === "error") {
        try {
          const dto = await restartSession(session.id);
          onOpenSession({ id: dto.id, cwd: dto.cwd });
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
        return;
      }
      onOpenSession({ id: session.id, cwd: session.cwd });
    },
    [onOpenSession],
  );

  const running = status?.activeSessions ?? [];

  return (
    <div className="flex h-full flex-col">
      <Topbar
        leading={<ProductMark />}
        center={<span className="truncate text-[13px] text-v2-text-text-muted">From idea to paper, one project at a time.</span>}
        actions={settingsButton}
      />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-4 px-4 py-8">
          {error && (
            <p className="rounded-md border border-v2-status-error/30 bg-v2-status-error/5 px-3 py-2 text-[13px] text-v2-status-error" role="alert">
              {error}
            </p>
          )}

          <section className="rounded-[10px] bg-v2-background-bg-base p-4 shadow-[var(--v2-elevation-raised)]">
            <h2 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-v2-text-text-base">
              <FolderSearch size={14} className="text-v2-icon-icon-muted" />
              Start a project
            </h2>
            <button
              type="button"
              className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-v2-grey-1100 text-[13px] font-medium text-v2-grey-50 transition-opacity hover:opacity-90 disabled:opacity-50"
              onClick={() => setDialogOpen(true)}
            >
              {creating ? "Starting orchestrator session…" : "Choose directory…"}
            </button>
            <p className="mt-3 text-[13px] text-v2-text-text-muted">
              Create a paper project from any existing directory, or resume one below.
            </p>
          </section>

          <section className="rounded-[10px] bg-v2-background-bg-base p-4 shadow-[var(--v2-elevation-raised)]">
            <h2 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-v2-text-text-base">
              <Activity size={14} className="text-v2-icon-icon-muted" />
              Global monitor
              <span className="ml-auto flex items-center gap-1 text-[12px] font-normal text-v2-text-text-faint">
                <span className={`size-1.5 rounded-full ${running.length > 0 ? "bg-v2-status-success" : "bg-v2-grey-300"}`} aria-hidden />
                {running.length} running
              </span>
            </h2>
            {running.length === 0 ? (
              <p className="text-[13px] text-v2-text-text-muted">No agents running right now.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {running.map((session) => {
                  const dead = session.status === "stopped" || session.status === "error";
                  return (
                    <li key={session.id}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-v2-grey-100"
                        onClick={() => void openActive(session)}
                      >
                        <span
                          className={`size-2 rounded-full ${
                            session.status === "error"
                              ? "bg-v2-status-error"
                              : session.status === "running" || session.isStreaming
                                ? "bg-v2-status-success"
                                : "bg-v2-status-warning"
                          }`}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-v2-text-text-base">
                          {session.sessionName ?? session.cwd}
                        </span>
                        <span className="truncate font-mono text-[12px] text-v2-text-text-faint">{session.cwd}</span>
                        {dead ? (
                          <span className="shrink-0 rounded-full bg-v2-status-error/10 px-2 py-0.5 text-[11px] text-v2-status-error" title={session.error}>
                            reconnected on click
                          </span>
                        ) : (
                          <span className="shrink-0 text-[12px] text-v2-text-text-muted">{session.status}</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="rounded-[10px] bg-v2-background-bg-base p-4 shadow-[var(--v2-elevation-raised)]">
            <h2 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-v2-text-text-base">
              <History size={14} className="text-v2-icon-icon-muted" />
              Continue work
            </h2>
            {!status ? (
              <p className="text-[13px] text-v2-text-text-faint">Loading sessions…</p>
            ) : (
              <SessionList
                history={status.sessions}
                onOpenHistory={openHistory}
              />
            )}
          </section>

          <button
            type="button"
            className="flex items-center gap-2 self-center text-[13px] text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted"
            onClick={onOpenSettings}
          >
            <Settings2 size={14} />
            Settings
          </button>
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
    </div>
  );
}
