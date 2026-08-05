import { useCallback, useEffect, useState } from "react";
import { FolderSearch } from "lucide-react";
import { createSession, listStatus, openSession } from "../api";
import { ApiError } from "../api";
import { DirectoryPicker } from "../components/DirectoryPicker";
import { SessionList } from "../components/SessionList";
import type { ActiveSessionDto, SessionSummaryDto } from "../../../web/contracts";

export interface HomePageProps {
  homeDir: string;
  onOpenSession: (session: { id: string; cwd: string }) => void;
}

export function HomePage({ homeDir, onOpenSession }: HomePageProps) {
  const [status, setStatus] = useState<{ sessions: SessionSummaryDto[]; activeSessions: ActiveSessionDto[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(() => {
    setError(null);
    listStatus()
      .then(setStatus)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  const startSession = useCallback(
    async (cwd: string) => {
      setCreating(true);
      setError(null);
      try {
        const dto = await createSession(cwd);
        onOpenSession({ id: dto.id, cwd: dto.cwd });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setCreating(false);
      }
    },
    [onOpenSession],
  );

  const openHistory = useCallback(
    async (session: SessionSummaryDto) => {
      try {
        const dto = await openSession(session.path);
        onOpenSession({ id: dto.id, cwd: dto.cwd });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [onOpenSession],
  );

  return (
    <main className="home-page">
      <header className="home-page__header">
        <h1 className="home-page__title">LazyResearch</h1>
        <p className="home-page__subtitle">From idea to paper, one project at a time.</p>
      </header>
      {error && <p className="home-page__error" role="alert">{error}</p>}
      <div className="home-page__grid">
        <section className="home-page__column">
          <h2 className="section-heading">
            <FolderSearch size={15} />
            Start from a directory
          </h2>
          <DirectoryPicker
            homeDir={homeDir}
            onSelect={startSession}
            onNavigate={() => {}}
          />
        </section>
        <section className="home-page__column">
          <h2 className="section-heading">Continue work</h2>
          {!status ? (
            <p className="muted">Loading sessions…</p>
          ) : (
            <SessionList
              history={status.sessions}
              active={status.activeSessions}
              onOpenHistory={openHistory}
              onOpenActive={(session) => onOpenSession({ id: session.id, cwd: session.cwd })}
            />
          )}
        </section>
      </div>
      {creating && <p className="muted">Starting orchestrator session…</p>}
    </main>
  );
}
