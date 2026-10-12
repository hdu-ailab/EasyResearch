import { useI18n } from "../../i18n/useI18n";
import {
  compactParentPath,
  countConnectedSessions,
  directoryName,
  formatRelativeModifiedTime,
  isActuallyRunning,
  isConnected,
  matchesSessionQuery,
  sessionTitle,
} from "../../pages/home-view-model";
import type { HomeWorkspaceProps } from "../HomeWorkspace";

interface SessionRowProps {
  title: string;
  cwd: string;
  modified: string;
  messageCount?: number;
  status?: string;
  running?: boolean;
  disconnecting?: boolean;
  onOpen(): void;
  onRename(): void;
  onDelete(): void;
  onDisconnect?: () => void;
}

function SessionRow({
  title,
  cwd,
  modified,
  messageCount,
  status,
  running,
  disconnecting,
  onOpen,
  onRename,
  onDelete,
  onDisconnect,
}: SessionRowProps) {
  const { t } = useI18n();
  return (
    <li
      className={`er-session-row ${onDisconnect ? "er-session-active" : "er-session-recent"}`}
      data-running={running || undefined}
    >
      <button type="button" className="er-session-open" onClick={onOpen}>
        <span className="er-session-title truncate" title={title}>
          {title}
        </span>
        <span className="er-session-detail" title={onDisconnect ? cwd : undefined}>
          {onDisconnect
            ? directoryName(cwd)
            : `${messageCount ?? 0} ${t(messageCount === 1 ? "sessions.message" : "sessions.messages")}`}
        </span>
      </button>
      {onDisconnect ? (
        <span className="er-session-status" data-running={running || undefined}>
          {status}
        </span>
      ) : (
        <span className="er-session-project" title={cwd}>
          {directoryName(cwd)}
        </span>
      )}
      <span className="er-session-modified">{modified}</span>
      <div className="er-session-actions">
        <button
          type="button"
          className="er-text-button"
          aria-label={`${t("home.rename")}: ${title}`}
          title={t("home.renameTitle")}
          onClick={onRename}
        >
          {t("studio.rename")}
        </button>
        {onDisconnect && (
          <button
            type="button"
            className="er-text-button"
            aria-label={`${t("home.disconnectTitle")}: ${title}`}
            disabled={disconnecting}
            onClick={onDisconnect}
          >
            {disconnecting ? "…" : t("home.disconnect")}
          </button>
        )}
        <button
          type="button"
          className="er-text-button er-danger-action"
          aria-label={`${t("home.deleteSession")}: ${title}`}
          disabled={disconnecting}
          onClick={onDelete}
        >
          {t("studio.delete")}
        </button>
      </div>
    </li>
  );
}

/** Presentation only: HomePage retains every operation, dialog, selection and request. */
export function StudioHomeWorkspace(props: HomeWorkspaceProps) {
  const { t, language } = useI18n();
  const { groups, selectedCwd, query, loading, creating } = props;
  const selectedGroups = selectedCwd === null ? groups : groups.filter((group) => group.cwd === selectedCwd);
  const active = selectedGroups.flatMap((group) => group.active).filter(isConnected);
  const visibleActive = active.filter((session) => matchesSessionQuery(session, query));
  const history = selectedGroups
    .flatMap((group) => group.history)
    .filter((session) => matchesSessionQuery(session, query));
  const activeCount = countConnectedSessions(active);
  return (
    <section className="er-home-layout" aria-label={t("home.workspace")}>
      <select
        className="er-mobile-project-filter"
        aria-label={t("home.projects")}
        value={selectedCwd ?? ""}
        onChange={(event) => props.onSelectProject(event.target.value || null)}
      >
        <option value="">
          {t("home.allProjects")} · {groups.length}
        </option>
        {groups.map((group) => (
          <option key={group.cwd} value={group.cwd}>
            {group.cwd}
          </option>
        ))}
      </select>
      <div className="er-project-create">
        <button type="button" className="er-outlined-button" disabled={creating} onClick={props.onChooseDirectory}>
          {t("home.newProject")}
        </button>
      </div>
      <aside className="er-project-rail" aria-label={t("home.projects")}>
        <button
          type="button"
          className="er-all-projects"
          aria-current={selectedCwd === null ? "true" : undefined}
          onClick={() => props.onSelectProject(null)}
        >
          <span>{t("home.allProjects")}</span>
          <span className="er-count">{groups.length}</span>
        </button>
        {groups.map((group) => (
          <div className="er-project-row" key={group.cwd} data-selected={group.cwd === selectedCwd || undefined}>
            <button
              type="button"
              className="er-project-select"
              aria-label={group.cwd}
              title={group.cwd}
              aria-current={group.cwd === selectedCwd ? "true" : undefined}
              onClick={() => props.onSelectProject(group.cwd)}
            >
              <span>{directoryName(group.cwd)}</span>
              <small>{compactParentPath(group.cwd)}</small>
            </button>
            <button
              type="button"
              className="er-text-button"
              aria-label={`${t("home.newSession")} ${group.cwd}`}
              title={`${t("home.newSession")} ${group.cwd}`}
              disabled={creating}
              onClick={() => props.onCreateInProject(group.cwd)}
            >
              <span className="er-session-create-short">{t("studio.newSession")}</span>
              <span className="er-session-create-long">{t("home.newSession")}</span>
            </button>
          </div>
        ))}
      </aside>
      <div className="er-home-content">
        <header className="er-home-heading">
          <div>
            <h1>{t("studio.homeTitle")}</h1>
            <p title={selectedCwd ?? undefined}>
              {selectedCwd ??
                t("studio.projectSummary")
                  .replace("{projects}", String(groups.length))
                  .replace("{sessions}", String(activeCount))}
            </p>
          </div>
          <input
            type="search"
            aria-label={t("home.searchSessions")}
            placeholder={t("home.searchPlaceholder")}
            value={query}
            onChange={(event) => props.onQueryChange(event.target.value)}
          />
        </header>
        <section aria-labelledby="studio-active-heading">
          <div className="er-section-heading">
            <h2 id="studio-active-heading">{t("home.activeSessions")}</h2>
            <span className="er-count">{visibleActive.length}</span>
          </div>
          {loading ? (
            <p className="er-empty-row">{t("home.loadingSessions")}</p>
          ) : visibleActive.length === 0 ? (
            <p className="er-empty-row">{t(selectedCwd ? "home.noSessionsForProject" : "home.noAgentsRunning")}</p>
          ) : (
            <ul className="er-active-ledger">
              {visibleActive.map((session) => (
                <SessionRow
                  key={session.id}
                  title={sessionTitle(session)}
                  cwd={session.cwd}
                  modified={formatRelativeModifiedTime(session.modified, language)}
                  running={isActuallyRunning(session)}
                  status={t(
                    isActuallyRunning(session)
                      ? "home.runningStatus"
                      : session.status === "starting"
                        ? "home.startingStatus"
                        : "home.idleStatus",
                  )}
                  disconnecting={props.disconnectingSessionId === session.id}
                  onOpen={() => props.onOpenActive(session)}
                  onRename={() => props.onRenameSession(session)}
                  onDelete={() => props.onDeleteSession(session)}
                  onDisconnect={() => props.onDisconnectActive(session)}
                />
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="studio-recent-heading">
          <div className="er-section-heading">
            <h2 id="studio-recent-heading">{t("home.recentSessions")}</h2>
            <span className="er-count">{history.length}</span>
          </div>
          {loading ? (
            <p className="er-empty-row">{t("home.loadingSessions")}</p>
          ) : history.length === 0 ? (
            <p className="er-empty-row">{t(selectedCwd ? "home.noSessionsForProject" : "sessions.noSessions")}</p>
          ) : (
            <ul className="er-recent-ledger">
              {history.map((session) => (
                <SessionRow
                  key={session.id}
                  title={sessionTitle(session)}
                  cwd={session.cwd}
                  modified={formatRelativeModifiedTime(session.modified, language)}
                  messageCount={session.messageCount}
                  onOpen={() => props.onOpenHistory(session)}
                  onRename={() => props.onRenameHistory(session)}
                  onDelete={() => props.onDeleteSession(session)}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
