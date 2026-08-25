import { Folder, MessageSquareText, Pencil } from "lucide-react";
import type { SessionSummaryDto } from "../../../web/contracts";
import { useI18n } from "../i18n/useI18n";
import { directoryName, formatRelativeModifiedTime, sessionTitle } from "../pages/home-view-model";

export interface SessionListProps {
  history: SessionSummaryDto[];
  showCwd?: boolean;
  onOpenHistory: (session: SessionSummaryDto) => void;
  onRenameSession: (session: SessionSummaryDto) => void;
}

/** Home history ledger. Historical sessions open through their recorded session file. */
export function SessionList({ history, showCwd = true, onOpenHistory, onRenameSession }: SessionListProps) {
  const { language, t } = useI18n();
  return (
    <section aria-label={t("sessions.ariaLabel")}>
      {history.length === 0 ? (
        <p className="border-t border-v2-grey-200 px-6 py-4 text-[13px] text-v2-text-text-muted">
          {t("sessions.noSessions")}
        </p>
      ) : (
        <ul>
          {history.map((session) => {
            const title = sessionTitle(session);
            const folder = directoryName(session.cwd);
            const modified = formatRelativeModifiedTime(session.modified, language);
            const messageLabel = `${session.messageCount} ${t(session.messageCount === 1 ? "sessions.message" : "sessions.messages")}`;
            return (
              <li
                key={session.id}
                className="group relative flex min-w-0 border-t border-v2-grey-200 transition-colors hover:bg-v2-grey-100"
              >
                <button
                  type="button"
                  className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-y-1 px-5 py-3.5 text-left lg:grid-cols-[minmax(0,1.55fr)_minmax(140px,0.9fr)_84px_104px] lg:items-center lg:gap-x-5 lg:px-6 lg:py-4"
                  onClick={() => onOpenHistory(session)}
                >
                  <span className="min-w-0 truncate text-[14px] font-medium text-v2-text-text-base" title={title}>
                    {title}
                  </span>
                  <span
                    className="hidden min-w-0 items-center gap-2 text-[13px] text-v2-text-text-faint lg:flex"
                    title={showCwd ? session.cwd : undefined}
                  >
                    {showCwd && (
                      <>
                        <Folder size={15} className="shrink-0" aria-hidden />
                        <span className="truncate">{folder}</span>
                      </>
                    )}
                  </span>
                  <span className="hidden shrink-0 items-center gap-1.5 text-[13px] text-v2-text-text-faint lg:flex">
                    <MessageSquareText size={14} aria-hidden />
                    <span aria-hidden>{session.messageCount}</span>
                    <span className="sr-only">{messageLabel}</span>
                  </span>
                  <span className="hidden shrink-0 text-[13px] text-v2-text-text-faint lg:block">{modified}</span>
                  <span className="flex min-w-0 items-center gap-2 text-[12px] text-v2-text-text-faint lg:hidden">
                    {showCwd && (
                      <>
                        <span className="truncate" title={session.cwd}>
                          {folder}
                        </span>
                        <span aria-hidden>·</span>
                      </>
                    )}
                    <span className="flex items-center gap-1">
                      <MessageSquareText size={12} aria-hidden />
                      <span aria-hidden>{session.messageCount}</span>
                      <span className="sr-only">{messageLabel}</span>
                    </span>
                    <span aria-hidden>·</span>
                    <span>{modified}</span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`${t("home.rename")}: ${title}`}
                  title={t("home.renameTitle")}
                  className="mr-2 flex size-8 shrink-0 self-center items-center justify-center rounded-md text-v2-text-text-faint transition-colors hover:bg-v2-grey-200 hover:text-v2-text-text-base lg:mr-4"
                  onClick={() => onRenameSession(session)}
                >
                  <Pencil size={13} aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
