import { Activity, Folder, FolderOpen, Pencil, Plus, Power, Search } from "lucide-react";
import { useState } from "react";
import type { ActiveSessionDto, SessionSummaryDto } from "../../../web/contracts";
import { useI18n } from "../i18n/useI18n";
import {
  compactParentPath,
  countConnectedSessions,
  directoryName,
  formatRelativeModifiedTime,
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
  const { language, t } = useI18n();
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

  const renderActiveSession = (session: (typeof visibleActive)[number]) => {
    const running = isActuallyRunning(session);
    const statusLabel = running
      ? t("home.runningStatus")
      : session.status === "starting"
        ? t("home.startingStatus")
        : t("home.idleStatus");
    const disconnecting = disconnectingSessionId === session.id;
    const title = sessionTitle(session);
    const folder = directoryName(session.cwd);
    const modified = formatRelativeModifiedTime(session.modified, language);

    return (
      <li
        key={session.id}
        className="group relative flex min-w-0 border-t border-v2-grey-200 transition-colors hover:bg-v2-grey-100"
      >
        <button
          type="button"
          className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-y-1 px-5 py-3.5 text-left min-[820px]:grid-cols-[minmax(0,1.55fr)_minmax(0,0.9fr)_minmax(56px,72px)_minmax(72px,92px)] min-[820px]:items-center min-[820px]:gap-x-2 min-[820px]:px-4 min-[820px]:py-4"
          onClick={() => onOpenActive(session)}
        >
          <span className="flex min-w-0 items-center gap-3">
            <span className={`size-2 shrink-0 rounded-full ${statusDot[session.status]}`} aria-hidden />
            <span className="min-w-0 truncate text-[14px] font-medium text-v2-text-text-base" title={title}>
              {title}
            </span>
          </span>
          <span
            className="hidden min-w-0 items-center gap-2 text-[13px] text-v2-text-text-faint min-[820px]:flex"
            title={session.cwd}
          >
            <Folder size={15} className="shrink-0" aria-hidden />
            <span className="truncate">{folder}</span>
          </span>
          <span className="hidden min-w-0 truncate text-[13px] text-v2-text-text-muted min-[820px]:block">
            {statusLabel}
          </span>
          <span className="hidden min-w-0 truncate text-[13px] text-v2-text-text-faint min-[820px]:block">
            {modified}
          </span>
          <span className="flex min-w-0 items-center gap-2 pl-5 text-[12px] text-v2-text-text-faint min-[820px]:hidden">
            <span className="truncate" title={session.cwd}>
              {folder}
            </span>
            <span aria-hidden>·</span>
            <span>{statusLabel}</span>
            {modified && (
              <>
                <span aria-hidden>·</span>
                <span>{modified}</span>
              </>
            )}
          </span>
        </button>
        <button
          type="button"
          aria-label={`${t("home.rename")}: ${title}`}
          title={t("home.renameTitle")}
          className="flex size-8 shrink-0 self-center items-center justify-center rounded-md text-v2-text-text-faint transition-colors hover:bg-v2-grey-200 hover:text-v2-text-text-base"
          onClick={() => onRenameSession(session)}
        >
          <Pencil size={13} aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`${t("home.disconnectTitle")}: ${title}`}
          title={t("home.disconnectTitle")}
          className="mr-2 flex min-h-8 shrink-0 self-center items-center gap-1 rounded-md px-2 text-[12px] text-v2-text-text-faint transition-colors hover:bg-v2-grey-200 hover:text-v2-text-text-base disabled:cursor-wait disabled:opacity-50 min-[820px]:mr-4"
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
      className="home-workspace mx-auto grid w-full max-w-[1600px] overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] min-[820px]:grid-cols-[minmax(280px,25%)_minmax(0,1fr)] min-[820px]:grid-rows-[80px_auto_minmax(0,1fr)]"
    >
      <div className="p-4 min-[820px]:col-start-1 min-[820px]:row-start-1 min-[820px]:border-r min-[820px]:border-v2-grey-200">
        <button
          type="button"
          className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-v2-blue-600 px-4 text-[14px] font-medium text-v2-grey-50 transition-colors hover:bg-v2-blue-700 disabled:opacity-50"
          disabled={creating}
          onClick={onChooseDirectory}
        >
          <Plus size={18} aria-hidden />
          {t("home.newProject")}
        </button>
      </div>
      <div className="border-t border-v2-grey-200 p-4 min-[820px]:col-start-2 min-[820px]:row-start-1 min-[820px]:border-t-0">
        <label className="flex h-12 items-center gap-3 rounded-lg border border-v2-grey-300 bg-v2-background-bg-base px-4 transition-colors focus-within:border-v2-blue-600">
          <Search size={17} className="shrink-0 text-v2-icon-icon-muted" aria-hidden />
          <input
            type="search"
            aria-label={t("home.searchSessions")}
            placeholder={t("home.searchPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <section
        className="border-t border-v2-grey-200 min-[820px]:col-start-2 min-[820px]:row-start-2"
        aria-labelledby="active-sessions-heading"
      >
        <div className="flex items-center gap-2 px-5 py-4 min-[820px]:px-6">
          <Activity size={16} className="text-v2-icon-icon-muted" aria-hidden />
          <h2 id="active-sessions-heading" className="text-[14px] font-semibold text-v2-text-text-base">
            {t("home.activeSessions")}
          </h2>
          <span className="ml-auto text-[13px] font-normal text-v2-text-text-faint">
            {activeCount} {t("home.active")}
          </span>
        </div>
        {loading ? (
          <p className="border-t border-v2-grey-200 px-6 py-4 text-[13px] text-v2-text-text-faint">
            {t("home.loadingSessions")}
          </p>
        ) : visibleActive.length === 0 ? (
          <p className="border-t border-v2-grey-200 px-6 py-4 text-[13px] text-v2-text-text-muted">
            {selectedCwd === null ? t("home.noAgentsRunning") : t("home.noSessionsForProject")}
          </p>
        ) : (
          <ul>{visibleActive.map(renderActiveSession)}</ul>
        )}
      </section>
      <aside
        aria-label={t("home.projects")}
        className="border-t border-v2-grey-200 p-3 min-[820px]:col-start-1 min-[820px]:row-start-2 min-[820px]:row-span-2 min-[820px]:border-r min-[820px]:border-t-0"
      >
        <div className="flex flex-col gap-1">
          <button
            type="button"
            aria-current={selectedCwd === null ? "true" : undefined}
            className={`flex w-full items-center gap-3 rounded-md border-l-2 px-3 py-3 text-left text-[14px] transition-colors ${selectedCwd === null ? "border-v2-blue-600 bg-v2-blue-100 font-medium text-v2-blue-700" : "border-transparent text-v2-text-text-muted hover:bg-v2-grey-100"}`}
            onClick={() => onSelectProject(null)}
          >
            {selectedCwd === null ? <FolderOpen size={17} aria-hidden /> : <Folder size={17} aria-hidden />}
            {t("home.allProjects")}
          </button>
          {groups.map((group) => {
            const selected = selectedCwd === group.cwd;
            const name = directoryName(group.cwd);
            const parent = compactParentPath(group.cwd);
            return (
              <div key={group.cwd} className="group flex items-center rounded-md hover:bg-v2-grey-100">
                <button
                  type="button"
                  aria-label={group.cwd}
                  aria-current={selected ? "true" : undefined}
                  title={group.cwd}
                  className={`flex min-w-0 flex-1 items-center gap-3 rounded-l-md border-l-2 px-3 py-2.5 text-left transition-colors ${selected ? "border-v2-blue-600 bg-v2-blue-100 text-v2-blue-700" : "border-transparent text-v2-text-text-muted"}`}
                  onClick={() => onSelectProject(group.cwd)}
                >
                  {selected ? (
                    <FolderOpen size={17} className="shrink-0" aria-hidden />
                  ) : (
                    <Folder size={17} className="shrink-0 text-v2-icon-icon-base" aria-hidden />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className={`truncate text-[14px] ${selected ? "font-medium" : "text-v2-text-text-base"}`}>
                      {name}
                    </span>
                    <span className="truncate font-mono text-[12px] text-v2-text-text-faint">{parent}</span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`${t("home.newSession")} ${group.cwd}`}
                  title={`${t("home.newSession")} ${group.cwd}`}
                  className={`flex size-9 shrink-0 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:text-v2-icon-icon-base disabled:opacity-50 ${selected ? "bg-v2-blue-100" : ""}`}
                  disabled={creating}
                  onClick={() => onCreateInProject(group.cwd)}
                >
                  <Plus size={16} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      </aside>
      <section
        className="min-w-0 border-t border-v2-grey-200 min-[820px]:col-start-2 min-[820px]:row-start-3"
        aria-labelledby="recent-sessions-heading"
      >
        <h2
          id="recent-sessions-heading"
          className="px-5 py-4 text-[14px] font-semibold text-v2-text-text-base min-[820px]:px-6"
        >
          {t("home.recentSessions")}
        </h2>
        {loading ? (
          <p className="border-t border-v2-grey-200 px-6 py-4 text-[13px] text-v2-text-text-faint">
            {t("home.loadingSessions")}
          </p>
        ) : visibleHistory.length === 0 ? (
          <p className="border-t border-v2-grey-200 px-6 py-4 text-[13px] text-v2-text-text-muted">{emptyHistory}</p>
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
