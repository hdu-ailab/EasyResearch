import { History, MessageSquareText } from "lucide-react";
import type { SessionSummaryDto } from "../../../web/contracts";

export interface SessionListProps {
  history: SessionSummaryDto[];
  onOpenHistory: (session: SessionSummaryDto) => void;
}

/**
 * Home history list. Historical sessions are opened through their recorded
 * session file. Active (running) sessions are listed in the Global monitor on
 * the home page, which auto-restarts dead sessions before opening.
 */
export function SessionList({ history, onOpenHistory }: SessionListProps) {
  return (
    <div className="flex flex-col gap-3" aria-label="Sessions">
      <div>
        <h3 className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-v2-text-text-faint">
          <History size={12} />
          History
        </h3>
        {history.length === 0 ? (
          <p className="px-2 py-1 text-[13px] text-v2-text-text-muted">
            No sessions yet. Pick a project directory to start one.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {history.map((session) => (
              <li key={session.id}>
                <button type="button" className="group flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-v2-grey-100" onClick={() => onOpenHistory(session)}>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-v2-text-text-base">
                    {session.name ?? session.id.slice(0, 8)}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-[12px] text-v2-text-text-faint">
                    <MessageSquareText size={12} />
                    {session.messageCount}
                  </span>
                  <span className="max-w-[220px] truncate font-mono text-[12px] text-v2-text-text-faint">{session.cwd}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
