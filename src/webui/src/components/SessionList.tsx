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
    <section className="session-list" aria-label="Sessions">
      {active.length > 0 && (
        <div className="session-list__group">
          <h2 className="session-list__heading">
            <Activity size={14} />
            Running
          </h2>
          <ul>
            {active.map((session) => (
              <li key={session.id}>
                <button type="button" className="session-row" onClick={() => onOpenActive(session)}>
                  <span className="session-row__dot" aria-hidden />
                  <span className="session-row__name">{session.sessionName ?? session.cwd}</span>
                  <span className="session-row__cwd">{session.cwd}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="session-list__group">
        <h2 className="session-list__heading">
          <History size={14} />
          History
        </h2>
        {history.length === 0 ? (
          <p className="session-list__empty">No sessions yet. Pick a project directory to start one.</p>
        ) : (
          <ul>
            {history.map((session) => (
              <li key={session.id}>
                <button type="button" className="session-row" onClick={() => onOpenHistory(session)}>
                  <span className="session-row__name">{session.name ?? session.id.slice(0, 8)}</span>
                  <span className="session-row__meta">
                    <MessageSquareText size={12} />
                    {session.messageCount} messages
                  </span>
                  <span className="session-row__cwd">{session.cwd}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
