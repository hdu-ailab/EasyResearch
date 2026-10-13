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
  stopSession,
  touchSession,
} from "../api";
import { DeleteSessionDialog } from "../components/DeleteSessionDialog";
import { DirectoryDialog } from "../components/DirectoryDialog";
import { HomeWorkspace } from "../components/HomeWorkspace";
import { RenameSessionDialog } from "../components/RenameSessionDialog";
import { StudioHomeWorkspace } from "../components/studio/StudioHomeWorkspace";
import { Topbar } from "../components/Topbar";
import { useI18n } from "../i18n/useI18n";
import { HomeWorkspace as ClassicHomeWorkspace } from "../legacy/HomeWorkspace";
import { ProductMark as ClassicProductMark, Topbar as ClassicTopbar } from "../legacy/Topbar";
import { useClassicUi, useStudioUi } from "../ui-version";
import { buildHomeProjectGroups } from "./home-view-model";

export interface HomePageProps {
  onOpenSession: (session: { id: string; cwd: string }) => void;
  onOpenSettings: () => void;
  settingsButton: React.ReactNode;
}

const MONITOR_POLL_MS = 5000;

export function HomePage({ onOpenSession, settingsButton }: HomePageProps) {
  const { t } = useI18n();
  const classic = useClassicUi();
  const studio = useStudioUi();
  const HomeTopbar = classic ? ClassicTopbar : Topbar;
  const Workspace = studio ? StudioHomeWorkspace : classic ? ClassicHomeWorkspace : HomeWorkspace;
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
  const [desktopUpdatePhase, setDesktopUpdatePhase] = useState<"downloading" | "restarting" | null>(null);
  const [desktopUpdatePercent, setDesktopUpdatePercent] = useState<number | null>(null);
  const [desktopUpdateError, setDesktopUpdateError] = useState<string | null>(null);
  const [desktopUpdateCheckError, setDesktopUpdateCheckError] = useState<string | null>(null);
  const [desktopUpdateChecking, setDesktopUpdateChecking] = useState(false);
  const statusRequest = useRef(0);
  const updateCheckRequest = useRef(0);

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
    refresh();
    return () => {
      statusRequest.current += 1;
    };
  }, [refresh]);

  const refreshAvailableUpdate = useCallback(() => {
    const current = ++updateCheckRequest.current;
    setDesktopUpdateChecking(true);
    setDesktopUpdateCheckError(null);
    const request =
      window.easyresearchDesktop?.checkForUpdate?.() ?? checkForUpdate().then((result) => result.latestVersion);
    request
      .then((version) => {
        if (current !== updateCheckRequest.current) return;
        setLatestVersion(version);
        setDesktopUpdateChecking(false);
      })
      .catch((cause: unknown) => {
        if (current !== updateCheckRequest.current) return;
        setDesktopUpdateChecking(false);
        if (window.easyresearchDesktop) {
          setDesktopUpdateCheckError(cause instanceof Error ? cause.message : String(cause));
        }
      });
  }, []);

  useEffect(() => {
    refreshAvailableUpdate();
    return () => {
      updateCheckRequest.current += 1;
    };
  }, [refreshAvailableUpdate]);

  useEffect(
    () =>
      window.easyresearchDesktop?.onUpdateProgress?.((progress) => {
        setDesktopUpdatePhase(progress.phase);
        if (progress.percent !== undefined) setDesktopUpdatePercent(progress.percent);
      }),
    [],
  );

  const startDesktopUpdate = useCallback(async () => {
    const start = window.easyresearchDesktop?.startUpdate;
    if (!start || !latestVersion || desktopUpdatePhase) return;
    setDesktopUpdateError(null);
    setDesktopUpdatePhase("downloading");
    setDesktopUpdatePercent(null);
    try {
      await start(latestVersion);
    } catch (cause) {
      setDesktopUpdatePhase(null);
      setDesktopUpdateError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [desktopUpdatePhase, latestVersion]);

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
      try {
        await touchSession(session.id);
        onOpenSession({ id: session.id, cwd: session.cwd });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [onOpenSession],
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
      <HomeTopbar
        home={{ active: true }}
        leading={
          <>
            {classic && <ClassicProductMark />}
            <span className="shrink-0 rounded-md border border-v2-grey-300 bg-v2-background-bg-base px-1 py-0.5 font-mono text-[10px] text-v2-text-text-faint min-[360px]:px-1.5 min-[360px]:text-[11px]">
              v{packageJson.version}
            </span>
          </>
        }
        center={
          latestVersion && window.easyresearchDesktop?.startUpdate ? (
            <button
              type="button"
              disabled={desktopUpdatePhase !== null}
              aria-live="polite"
              onClick={() => void startDesktopUpdate()}
              className="truncate rounded-md px-2 py-1 text-[12px] font-medium text-v2-text-text-accent hover:bg-v2-grey-100 disabled:cursor-wait disabled:opacity-60"
            >
              {desktopUpdatePhase === "downloading"
                ? `${t("home.updateDownloading")}${desktopUpdatePercent === null ? "" : ` ${desktopUpdatePercent}%`}`
                : desktopUpdatePhase === "restarting"
                  ? t("home.updateRestarting")
                  : t("home.updateAction").replace("{version}", latestVersion)}
            </button>
          ) : latestVersion ? (
            <span
              role="status"
              title={`${t("home.updateAvailable")} v${latestVersion}`}
              className="truncate text-[12px] font-medium text-v2-text-text-accent"
            >
              {t("home.updateAvailable")} <span className="font-mono">v{latestVersion}</span>
            </span>
          ) : desktopUpdateChecking && window.easyresearchDesktop?.checkForUpdate ? (
            <span role="status" className="truncate text-[12px] text-v2-text-text-muted">
              {t("home.updateChecking")}
            </span>
          ) : desktopUpdateCheckError && window.easyresearchDesktop?.checkForUpdate ? (
            <button
              type="button"
              disabled={desktopUpdateChecking}
              title={desktopUpdateCheckError}
              onClick={refreshAvailableUpdate}
              className="truncate rounded-md px-2 py-1 text-[12px] font-medium text-v2-status-error hover:bg-v2-grey-100 disabled:cursor-wait"
            >
              {t("home.updateCheckFailed")}
            </button>
          ) : (
            <span className="hidden truncate text-[13px] text-v2-text-text-muted sm:inline">
              {t(studio ? "home.workspace" : "home.tagline")}
            </span>
          )
        }
        actions={settingsButton}
      />
      <main className={`er-home-main min-h-0 flex-1 overflow-y-auto ${classic ? "" : "bg-v2-background-bg-base"}`}>
        <div className={`flex min-h-full w-full flex-col ${classic ? "gap-2 px-2 pb-2 pt-[4px]" : ""}`}>
          {(error || desktopUpdateError || desktopUpdateCheckError) && (
            <p
              className={`shrink-0 border-v2-status-error/30 bg-v2-status-error/5 text-[13px] text-v2-status-error ${classic ? "rounded-md border px-3 py-2" : "border-b px-5 py-3"}`}
              role="alert"
            >
              {desktopUpdateError || desktopUpdateCheckError || error}
            </p>
          )}

          <Workspace
            groups={groups}
            selectedCwd={selectedCwd}
            query={query}
            onQueryChange={setQuery}
            loading={!status}
            creating={creating}
            onSelectProject={setSelectedCwd}
            onChooseDirectory={() => setDialogOpen(true)}
            onCreateInProject={(cwd) => void startSession(cwd)}
            onOpenActive={(session) => void openActive(session)}
            onDisconnectActive={(session) => void disconnectActive(session)}
            onOpenHistory={(session) => void openHistory(session)}
            onRenameSession={(session: ActiveSessionDto | SessionSummaryDto) => setRenamingSession(session)}
            onRenameHistory={(session) => setRenamingSession(session)}
            onDeleteSession={setDeletingSession}
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
