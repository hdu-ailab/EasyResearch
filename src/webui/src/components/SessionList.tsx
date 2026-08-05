import { Activity, History, MessageSquareText } from "lucide-react";
import type { SessionSummaryDto, ActiveSessionDto } from "../../../web/contracts";

export interface SessionListProps {
  history: SessionSummaryDto[];
  active: ActiveSessionDto[];
  onOpenHistory: (session: SessionSummaryDto) => void;
  onOpenActive: (session: ActiveSessionDto) => void;
}

/**
 * Home session lists. Historical sessions are opened through their recorded
 * session file; active sessions reuse their existing registry id.
 */
export function SessionList({ history, active, onOpenHistory, onOpenActive }: SessionListProps) {
  return (
    <div className="flex flex-col gap-3" aria-label="Sessions">
      {active.length > 0 && (
        <div>
          <h3 className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-v2-text-text-faint">
            <Activity size={12} />
            Running
          </h3>
          <ul className="flex flex-col gap-0.5">
            {active.map((session) => (
              <li key={session.id}>
                <button type="button" className="group flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-v2-grey-100" onClick={() => onOpenActive(session)}>
                  <span className="size-2 shrink-0 rounded-full bg-v2-status-success" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-v2-text-text-base">
                    {session.sessionName ?? session.cwd}
                  </span>
                  <span className="truncate font-mono text-[12px] text-v2-text-text-faint">{session.cwd}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
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
