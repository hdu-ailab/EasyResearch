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
        <p className="py-6 text-[14px] text-v2-text-text-muted">{t("sessions.noSessions")}</p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3 pt-2">
          {history.map((session) => {
            const title = sessionTitle(session);
            const folder = directoryName(session.cwd);
            const modified = formatRelativeModifiedTime(session.modified, language);
            const messageLabel = `${session.messageCount} ${t(session.messageCount === 1 ? "sessions.message" : "sessions.messages")}`;
            return (
              <li
                key={session.id}
                className="group relative flex min-h-[148px] min-w-0 flex-col overflow-hidden rounded-xl border border-v2-grey-200 bg-v2-background-bg-base shadow-[0_1px_2px_rgb(15_23_42_/_0.03)] transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-v2-blue-200 hover:shadow-[var(--v2-elevation-raised)] focus-within:border-v2-blue-300 focus-within:shadow-[var(--v2-elevation-raised)]"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 flex-col items-start gap-3 rounded-t-xl px-4 pb-3 pt-4 text-left"
                  onClick={() => onOpenHistory(session)}
                >
                  <span className="flex w-full min-w-0 items-start gap-3">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-v2-blue-100 text-v2-blue-600">
                      <MessageSquareText size={15} aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 pt-1">
                      <span className="block truncate text-[15px] font-medium text-v2-text-text-base" title={title}>
                        {title}
                      </span>
                    </span>
                  </span>
                  <span className="mt-auto flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-v2-text-text-faint">
                    {showCwd && (
                      <span className="flex min-w-0 max-w-full items-center gap-1.5" title={session.cwd}>
                        <Folder size={13} className="shrink-0" aria-hidden />
                        <span className="truncate">{folder}</span>
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <MessageSquareText size={12} aria-hidden />
                      <span aria-hidden>{session.messageCount}</span>
                      <span className="sr-only">{messageLabel}</span>
                    </span>
                    <span className="ml-auto shrink-0">{modified}</span>
                  </span>
                </button>
                <div className="flex justify-end border-t border-v2-grey-200/70 bg-v2-grey-100/50 px-2 py-1.5">
                  <button
                    type="button"
                    aria-label={`${t("home.rename")}: ${title}`}
                    title={t("home.renameTitle")}
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-v2-text-text-faint transition-colors hover:bg-v2-grey-200 hover:text-v2-text-text-base"
                    onClick={() => onRenameSession(session)}
                  >
                    <Pencil size={13} aria-hidden />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
