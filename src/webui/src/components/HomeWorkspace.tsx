import { Activity, Folder, FolderOpen, Pencil, Plus, Power, Search } from "lucide-react";
import { useState } from "react";
import type { ActiveSessionDto, SessionSummaryDto } from "../../../web/contracts";
import { useI18n } from "../i18n/useI18n";
import {
  countConnectedSessions,
  type HomeProjectGroup,
  isActuallyRunning,
  isConnected,
  matchesSessionQuery,
  sessionTitle,
} from "../pages/home-view-model";
import { SessionList } from "./SessionList";

export interface HomeWorkspaceProps {
  groups: HomeProjectGroup[];
  selectedCwd: string | null;
  loading: boolean;
  creating: boolean;
  onSelectProject: (cwd: string | null) => void;
  onChooseDirectory: () => void;
  onCreateInProject: (cwd: string) => void;
  onOpenActive: (session: ActiveSessionDto) => void;
  onDisconnectActive: (session: ActiveSessionDto) => void;
  onOpenHistory: (session: SessionSummaryDto) => void;
  onRenameSession: (session: ActiveSessionDto | SessionSummaryDto) => void;
  onRenameHistory: (session: SessionSummaryDto) => void;
  disconnectingSessionId?: string | null;
}

const statusDot: Record<ActiveSessionDto["status"], string> = {
  starting: "bg-v2-grey-500",
  ready: "bg-v2-grey-500",
  running: "bg-v2-status-success",
  stopped: "bg-v2-grey-500",
  error: "bg-v2-status-error",
};

export function HomeWorkspace({
  groups,
  selectedCwd,
  loading,
  creating,
  onSelectProject,
  onChooseDirectory,
  onCreateInProject,
  onOpenActive,
  onDisconnectActive,
  onOpenHistory,
  onRenameSession,
  onRenameHistory,
  disconnectingSessionId = null,
}: HomeWorkspaceProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const selectedGroups = selectedCwd === null ? groups : groups.filter((group) => group.cwd === selectedCwd);
  const visibleActive = selectedGroups
    .flatMap((group) => group.active)
    .filter(isConnected)
    .filter((session) => matchesSessionQuery(session, query));
  const visibleHistory = selectedGroups
    .flatMap((group) => group.history)
    .filter((session) => matchesSessionQuery(session, query));
  const activeCount = countConnectedSessions(selectedGroups.flatMap((group) => group.active));
  const emptyHistory = selectedCwd === null ? t("sessions.noSessions") : t("home.noSessionsForProject");

  const renderActiveSession = (session: ActiveSessionDto) => {
    const running = isActuallyRunning(session);
    const statusLabel = running
      ? t("home.runningStatus")
      : session.status === "starting"
        ? t("home.startingStatus")
        : t("home.idleStatus");
    const disconnecting = disconnectingSessionId === session.id;
    return (
      <li key={session.id} className="flex min-w-0 items-center gap-1 rounded-md p-0.5 hover:bg-v2-grey-100">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-1.5 py-1.5 text-left transition-colors"
          onClick={() => onOpenActive(session)}
        >
          <span className={`size-2 shrink-0 rounded-full ${statusDot[session.status]}`} aria-hidden />
          <span
            className="min-w-0 flex-1 truncate text-[13px] font-medium text-v2-text-text-base"
            title={sessionTitle(session)}
          >
            {sessionTitle(session)}
          </span>
          {selectedCwd === null && (
            <span className="max-w-[220px] truncate font-mono text-[12px] text-v2-text-text-faint">{session.cwd}</span>
          )}
          <span className="shrink-0 text-[12px] text-v2-text-text-muted">{statusLabel}</span>
        </button>
        <button
          type="button"
          aria-label={`${t("home.rename")}: ${sessionTitle(session)}`}
          title={t("home.renameTitle")}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-v2-text-text-faint transition-colors hover:bg-v2-grey-200 hover:text-v2-text-text-base"
          onClick={() => onRenameSession(session)}
        >
          <Pencil size={13} aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`${t("home.disconnectTitle")}: ${sessionTitle(session)}`}
          title={t("home.disconnectTitle")}
          className="flex min-h-8 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] text-v2-text-text-faint transition-colors hover:bg-v2-grey-200 hover:text-v2-text-text-base disabled:cursor-wait disabled:opacity-50"
          disabled={disconnecting}
          onClick={() => onDisconnectActive(session)}
        >
          <Power size={13} aria-hidden />
          <span className="hidden sm:inline">{disconnecting ? "…" : t("home.disconnect")}</span>
        </button>
      </li>
    );
  };

  return (
    <section
      aria-label={t("home.workspace")}
      className="mx-auto grid w-full max-w-[1080px] overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] lg:grid-cols-[280px_minmax(0,1fr)]"
    >
      <div className="p-3 lg:col-start-1 lg:row-start-1 lg:border-r lg:border-v2-grey-200">
        <button
          type="button"
          className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-v2-grey-1100 px-3 text-[13px] font-medium text-v2-grey-50 transition-opacity hover:opacity-90 disabled:opacity-50"
          disabled={creating}
          onClick={onChooseDirectory}
        >
          <Plus size={14} aria-hidden />
          {t("home.newProject")}
        </button>
      </div>
      <div className="border-t border-v2-grey-200 p-3 lg:col-start-2 lg:row-start-1 lg:border-t-0">
        <label className="flex h-9 items-center gap-2 rounded-md border border-v2-grey-300 bg-v2-background-bg-base px-3 focus-within:border-v2-blue-600">
          <Search size={14} className="shrink-0 text-v2-icon-icon-muted" aria-hidden />
          <input
            type="search"
            aria-label={t("home.searchSessions")}
            placeholder={t("home.searchPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <section
        className="border-t border-v2-grey-200 p-3 lg:col-start-2 lg:row-start-2"
        aria-labelledby="active-sessions-heading"
      >
        <h2
          id="active-sessions-heading"
          className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-v2-text-text-base"
        >
          <Activity size={14} className="text-v2-icon-icon-muted" aria-hidden />
          {t("home.activeSessions")}
          <span className="ml-auto text-[12px] font-normal text-v2-text-text-faint">
            {activeCount} {t("home.active")}
          </span>
        </h2>
        {loading ? (
          <p className="px-2 py-2 text-[13px] text-v2-text-text-faint">{t("home.loadingSessions")}</p>
        ) : visibleActive.length === 0 ? (
          <p className="px-2 py-2 text-[13px] text-v2-text-text-muted">
            {selectedCwd === null ? t("home.noAgentsRunning") : t("home.noSessionsForProject")}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">{visibleActive.map(renderActiveSession)}</ul>
        )}
      </section>
      <aside
        aria-label={t("home.projects")}
        className="border-t border-v2-grey-200 p-3 lg:col-start-1 lg:row-start-2 lg:row-span-2 lg:border-r lg:border-t-0"
      >
        <div>
          <button
            type="button"
            aria-current={selectedCwd === null ? "true" : undefined}
            className={`flex w-full items-center gap-2 border-l-2 px-2 py-2 text-left text-[13px] transition-colors ${selectedCwd === null ? "border-v2-blue-600 bg-v2-blue-100 font-medium text-v2-blue-700" : "border-transparent text-v2-text-text-muted hover:bg-v2-grey-100"}`}
            onClick={() => onSelectProject(null)}
          >
            {selectedCwd === null ? <FolderOpen size={14} aria-hidden /> : <Folder size={14} aria-hidden />}
            {t("home.allProjects")}
          </button>
          {groups.map((group) => {
            const selected = selectedCwd === group.cwd;
            return (
              <div key={group.cwd} className="group flex items-center">
                <button
                  type="button"
                  aria-current={selected ? "true" : undefined}
                  className={`flex min-w-0 flex-1 items-center gap-2 border-l-2 px-2 py-2 text-left text-[13px] transition-colors ${selected ? "border-v2-blue-600 bg-v2-blue-100 font-medium text-v2-blue-700" : "border-transparent text-v2-text-text-muted hover:bg-v2-grey-100"}`}
                  onClick={() => onSelectProject(group.cwd)}
                >
                  {selected ? (
                    <FolderOpen size={14} className="shrink-0" aria-hidden />
                  ) : (
                    <Folder size={14} className="shrink-0" aria-hidden />
                  )}
                  <span className="truncate font-mono text-[12px]">{group.cwd}</span>
                </button>
                <button
                  type="button"
                  aria-label={`${t("home.newSession")} ${group.cwd}`}
                  title={`${t("home.newSession")} ${group.cwd}`}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-grey-100 hover:text-v2-icon-icon-base disabled:opacity-50"
                  disabled={creating}
                  onClick={() => onCreateInProject(group.cwd)}
                >
                  <Plus size={14} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      </aside>
      <section
        className="min-w-0 border-t border-v2-grey-200 p-3 lg:col-start-2 lg:row-start-3"
        aria-labelledby="recent-sessions-heading"
      >
        <h2 id="recent-sessions-heading" className="mb-2 text-[13px] font-semibold text-v2-text-text-base">
          {t("home.recentSessions")}
        </h2>
        {loading ? (
          <p className="px-2 py-2 text-[13px] text-v2-text-text-faint">{t("home.loadingSessions")}</p>
        ) : visibleHistory.length === 0 ? (
          <p className="px-2 py-2 text-[13px] text-v2-text-text-muted">{emptyHistory}</p>
        ) : (
          <SessionList
            history={visibleHistory}
            showCwd={selectedCwd === null}
            onOpenHistory={onOpenHistory}
            onRenameSession={onRenameHistory}
          />
        )}
      </section>
    </section>
  );
}
