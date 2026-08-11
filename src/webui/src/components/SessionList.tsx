import { History, MessageSquareText } from "lucide-react";
import type { SessionSummaryDto } from "../../../web/contracts";
import { useI18n } from "../i18n/useI18n";
import { sessionTitle } from "../pages/home-view-model";

export interface SessionListProps {
  history: SessionSummaryDto[];
  showCwd?: boolean;
  onOpenHistory: (session: SessionSummaryDto) => void;
}

/**
 * Home history list. Historical sessions are opened through their recorded
 * session file. Active sessions are listed separately in the home workspace,
 * which shows only running sessions; idle/stopped sessions are reopened from
 * this history list.
 */
export function SessionList({ history, showCwd = true, onOpenHistory }: SessionListProps) {
  const { t } = useI18n();
  return (
    <section className="flex flex-col gap-3" aria-label={t("sessions.ariaLabel")}>
      <div>
        <h3 className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-v2-text-text-faint">
          <History size={12} />
          {t("sessions.history")}
        </h3>
        {history.length === 0 ? (
          <p className="px-2 py-1 text-[13px] text-v2-text-text-muted">{t("sessions.noSessions")}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {history.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className="group flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-v2-grey-100"
                  onClick={() => onOpenHistory(session)}
                >
                  <span
                    className="min-w-0 flex-1 truncate text-[13px] font-medium text-v2-text-text-base"
                    title={sessionTitle(session)}
                  >
                    {sessionTitle(session)}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-[12px] text-v2-text-text-faint">
                    <MessageSquareText size={12} />
                    {session.messageCount}
                  </span>
                  {showCwd && (
                    <span className="max-w-[220px] truncate font-mono text-[12px] text-v2-text-text-faint">
                      {session.cwd}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
