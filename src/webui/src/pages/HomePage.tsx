import { useCallback, useEffect, useState } from "react";
import type { ActiveSessionDto, SessionSummaryDto } from "../../../web/contracts";
import { createSession, listStatus, openSession, stopSession, touchSession } from "../api";
import { DirectoryDialog } from "../components/DirectoryDialog";
import { HomeWorkspace } from "../components/HomeWorkspace";
import { ProductMark, Topbar } from "../components/Topbar";
import { useI18n } from "../i18n/useI18n";
import { buildHomeProjectGroups } from "./home-view-model";

export interface HomePageProps {
  onOpenSession: (session: { id: string; cwd: string }) => void;
  onOpenSettings: () => void;
  settingsButton: React.ReactNode;
}

const MONITOR_POLL_MS = 5000;

export function HomePage({ onOpenSession, settingsButton }: HomePageProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<{
    sessions: SessionSummaryDto[];
    activeSessions: ActiveSessionDto[];
    homeDir: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [disconnectingSessionId, setDisconnectingSessionId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setError(null);
    listStatus()
      .then(setStatus)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    const timer = setInterval(refresh, MONITOR_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

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

  const openActive = useCallback(
    async (session: ActiveSessionDto) => {
      try {
        await touchSession(session.id);
        onOpenSession({ id: session.id, cwd: session.cwd });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [onOpenSession],
  );

  const disconnectActive = useCallback(
    async (session: ActiveSessionDto) => {
      setDisconnectingSessionId(session.id);
      setError(null);
      try {
        await stopSession(session.id);
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setDisconnectingSessionId(null);
      }
    },
    [refresh],
  );

  const groups = buildHomeProjectGroups(status?.sessions ?? [], status?.activeSessions ?? []);

  useEffect(() => {
    if (selectedCwd && !groups.some((group) => group.cwd === selectedCwd)) setSelectedCwd(null);
  }, [groups, selectedCwd]);

  return (
    <div className="flex h-full flex-col">
      <Topbar
        home={{ active: true }}
        leading={<ProductMark />}
        center={
          <span className="hidden truncate text-[13px] text-v2-text-text-muted sm:inline">{t("home.tagline")}</span>
        }
        actions={settingsButton}
      />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full w-full flex-col gap-2 px-2 pb-2 pt-[4px]">
          {error && (
            <p
              className="rounded-md border border-v2-status-error/30 bg-v2-status-error/5 px-3 py-2 text-[13px] text-v2-status-error"
              role="alert"
            >
              {error}
            </p>
          )}

          <HomeWorkspace
            groups={groups}
            selectedCwd={selectedCwd}
            loading={!status}
            creating={creating}
            onSelectProject={setSelectedCwd}
            onChooseDirectory={() => setDialogOpen(true)}
            onCreateInProject={(cwd) => void startSession(cwd)}
            onOpenActive={(session) => void openActive(session)}
            onDisconnectActive={(session) => void disconnectActive(session)}
            onOpenHistory={(session) => void openHistory(session)}
            disconnectingSessionId={disconnectingSessionId}
          />
        </div>
      </main>
      {dialogOpen && (
        <DirectoryDialog
          homeDir={status?.homeDir ?? "/"}
          onClose={() => setDialogOpen(false)}
          onSelect={(path) => {
            setDialogOpen(false);
            void startSession(path);
          }}
        />
      )}
    </div>
  );
}
