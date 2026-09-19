import { Activity, Folder, FolderOpen, Pencil, Plus, Power, Search, Trash2 } from "lucide-react";
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
  onDeleteSession: (session: ActiveSessionDto | SessionSummaryDto) => void;
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
  onDeleteSession,
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
        className="group relative flex min-h-[156px] min-w-0 flex-col overflow-hidden rounded-xl border border-v2-grey-200 bg-v2-background-bg-base shadow-[0_1px_2px_rgb(15_23_42_/_0.03)] transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-v2-blue-200 hover:shadow-[var(--v2-elevation-raised)] focus-within:border-v2-blue-300 focus-within:shadow-[var(--v2-elevation-raised)]"
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col items-start gap-3 rounded-t-xl px-4 pb-3 pt-4 text-left"
          onClick={() => onOpenActive(session)}
        >
          <span className="flex w-full min-w-0 items-start gap-3">
            <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-v2-blue-100 text-v2-blue-600">
              <Activity size={15} aria-hidden />
              <span
                className={`absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-v2-background-bg-base ${statusDot[session.status]}`}
                aria-hidden
              />
            </span>
            <span className="min-w-0 flex-1 pt-1">
              <span className="block truncate text-[15px] font-medium text-v2-text-text-base" title={title}>
                {title}
              </span>
            </span>
          </span>
          <span className="mt-auto flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-v2-text-text-faint">
            <span className="flex min-w-0 max-w-full items-center gap-1.5" title={session.cwd}>
              <Folder size={13} className="shrink-0" aria-hidden />
              <span className="truncate">{folder}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-v2-text-text-muted">
              <span className={`size-1.5 rounded-full ${statusDot[session.status]}`} aria-hidden />
              {statusLabel}
            </span>
            {modified && <span className="ml-auto shrink-0">{modified}</span>}
          </span>
        </button>
        <div className="flex items-center justify-end gap-1 border-t border-v2-grey-200/70 bg-v2-grey-100/50 px-2 py-1.5">
          <button
            type="button"
            aria-label={`${t("home.rename")}: ${title}`}
            title={t("home.renameTitle")}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-v2-text-text-faint transition-colors hover:bg-v2-grey-200 hover:text-v2-text-text-base"
            onClick={() => onRenameSession(session)}
          >
            <Pencil size={13} aria-hidden />
          </button>
          <button
            type="button"
            aria-label={`${t("home.disconnectTitle")}: ${title}`}
            title={t("home.disconnectTitle")}
            className="flex min-h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-v2-text-text-faint transition-colors hover:bg-v2-grey-200 hover:text-v2-text-text-base disabled:cursor-wait disabled:opacity-50"
            disabled={disconnecting}
            onClick={() => onDisconnectActive(session)}
          >
            <Power size={13} aria-hidden />
            <span>{disconnecting ? "…" : t("home.disconnect")}</span>
          </button>
          <button
            type="button"
            aria-label={`${t("home.deleteSession")}: ${title}`}
            title={t("home.deleteSession")}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-v2-text-text-faint transition-colors hover:bg-v2-status-error/10 hover:text-v2-status-error disabled:opacity-50"
            disabled={disconnecting}
            onClick={() => onDeleteSession(session)}
          >
            <Trash2 size={13} aria-hidden />
          </button>
        </div>
      </li>
    );
  };

  return (
    <section
      aria-label={t("home.workspace")}
      className="grid w-full min-w-0 flex-1 grid-cols-[minmax(0,1fr)] content-start bg-v2-background-bg-base min-[820px]:grid-cols-[264px_minmax(0,1fr)] min-[820px]:grid-rows-[88px_auto_auto_minmax(0,1fr)]"
    >
      <div className="bg-v2-grey-100 p-5 min-[820px]:col-start-1 min-[820px]:row-start-1 min-[820px]:border-r min-[820px]:border-v2-grey-200">
        <button
          type="button"
          className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#304c90] px-4 text-[14px] font-medium text-v2-grey-50 transition-colors hover:bg-[#4176E6] disabled:opacity-50"
          disabled={creating}
          onClick={onChooseDirectory}
        >
          <Plus size={18} aria-hidden />
          {t("home.newProject")}
        </button>
      </div>
      <header className="min-w-0 px-5 pb-8 pt-8 min-[820px]:col-start-2 min-[820px]:row-start-1 min-[820px]:row-span-2 min-[820px]:px-8 min-[820px]:pt-12 min-[1200px]:px-16">
        <p className="mb-2 text-[12px] font-medium tracking-wide text-v2-text-text-faint">{t("home.workspace")}</p>
        <h1 className="break-words text-[28px] font-semibold tracking-tight text-v2-text-text-base min-[820px]:text-[32px]">
          {selectedCwd === null ? t("home.allProjects") : directoryName(selectedCwd)}
        </h1>
        <p className="mt-2 break-words text-[13px] text-v2-text-text-muted">
          {selectedCwd === null ? t("home.tagline") : <span className="font-mono">{selectedCwd}</span>}
        </p>
        <label className="mt-6 flex h-11 max-w-[640px] items-center gap-3 rounded-lg border border-transparent bg-v2-grey-100 px-4 transition-colors focus-within:border-v2-blue-600 focus-within:bg-v2-background-bg-base">
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
      </header>
      <section
        className="min-w-0 px-5 pb-8 min-[820px]:col-start-2 min-[820px]:row-start-3 min-[820px]:px-8 min-[1200px]:px-16"
        aria-labelledby="active-sessions-heading"
      >
        <div className="mb-2 flex items-center gap-2 border-b border-v2-grey-200 pb-3">
          <Activity size={16} className="text-v2-icon-icon-muted" aria-hidden />
          <h2 id="active-sessions-heading" className="text-[15px] font-semibold text-v2-text-text-base">
            {t("home.activeSessions")}
          </h2>
          <span className="ml-auto text-[13px] font-normal text-v2-text-text-faint">
            {activeCount} {t("home.active")}
          </span>
        </div>
        {loading ? (
          <p className="py-6 text-[14px] text-v2-text-text-faint">{t("home.loadingSessions")}</p>
        ) : visibleActive.length === 0 ? (
          <p className="py-6 text-[14px] text-v2-text-text-muted">
            {selectedCwd === null ? t("home.noAgentsRunning") : t("home.noSessionsForProject")}
          </p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3 pt-2">
            {visibleActive.map(renderActiveSession)}
          </ul>
        )}
      </section>
      <aside
        aria-label={t("home.projects")}
        className="min-w-0 border-y border-v2-grey-200 bg-v2-grey-100 px-3 pb-8 pt-4 min-[820px]:col-start-1 min-[820px]:row-start-2 min-[820px]:row-span-3 min-[820px]:border-y-0 min-[820px]:border-r min-[820px]:pt-2"
      >
        <h2 className="px-3 pb-3 text-[12px] font-medium tracking-wide text-v2-text-text-faint">
          {t("home.projects")}
        </h2>
        <div className="flex max-h-[240px] flex-col gap-1 overflow-y-auto min-[820px]:max-h-none">
          <button
            type="button"
            aria-current={selectedCwd === null ? "true" : undefined}
            className={`flex w-full items-center gap-3 rounded-md border-l-2 px-3 py-3 text-left text-[14px] transition-colors ${selectedCwd === null ? "border-v2-blue-600 bg-v2-blue-100 font-medium text-v2-blue-700" : "border-transparent text-v2-text-text-muted hover:bg-v2-grey-200"}`}
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
              <div key={group.cwd} className="group flex items-center rounded-md hover:bg-v2-grey-200">
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
        className="min-w-0 px-5 pb-12 pt-6 min-[820px]:col-start-2 min-[820px]:row-start-4 min-[820px]:px-8 min-[820px]:pt-0 min-[1200px]:px-16"
        aria-labelledby="recent-sessions-heading"
      >
        <h2
          id="recent-sessions-heading"
          className="mb-2 border-b border-v2-grey-200 pb-3 text-[15px] font-semibold text-v2-text-text-base"
        >
          {t("home.recentSessions")}
        </h2>
        {loading ? (
          <p className="py-6 text-[14px] text-v2-text-text-faint">{t("home.loadingSessions")}</p>
        ) : visibleHistory.length === 0 ? (
          <p className="py-6 text-[14px] text-v2-text-text-muted">{emptyHistory}</p>
        ) : (
          <SessionList
            history={visibleHistory}
            showCwd={selectedCwd === null}
            onOpenHistory={onOpenHistory}
            onRenameSession={onRenameHistory}
            onDeleteSession={onDeleteSession}
          />
        )}
      </section>
    </section>
  );
}
