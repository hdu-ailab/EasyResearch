import { UnknownSessionError } from "./active-sessions";
import type { SessionSummaryDto } from "./contracts";

export interface SessionRenameDeps {
  isConnected: (sessionId: string) => Promise<boolean>;
  setConnectedName: (sessionId: string, name: string) => Promise<void>;
  listAll: () => Promise<SessionSummaryDto[]>;
  openSessionManager: (path: string) => Promise<{ appendSessionInfo(name: string): unknown }>;
}

/**
 * Rename resolution: connected sessions go through the live AgentSession
 * (single writer, `session_info_changed` keeps the DTO and SSE stream in
 * sync); historical sessions append a `session_info` entry directly on the
 * JSONL — the same open-and-append pattern as agent model/thinking
 * overrides. Pi sanitizes (`\r\n` → spaces, trim); an empty name clears.
 */
export function resolveRenameSessionService(deps: SessionRenameDeps) {
  return {
    async rename(sessionId: string, name: string): Promise<void> {
      if (await deps.isConnected(sessionId)) {
        await deps.setConnectedName(sessionId, name);
        return;
      }
      const session = (await deps.listAll()).find((s) => s.id === sessionId);
      if (!session) throw new UnknownSessionError(`Unknown session: ${sessionId}`);
      const manager = await deps.openSessionManager(session.path);
      manager.appendSessionInfo(name);
    },
  };
}
