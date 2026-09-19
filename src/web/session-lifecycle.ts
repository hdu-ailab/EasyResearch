import { lstatSync, readFileSync } from "node:fs";
import { isSubagentSessionName } from "../subagent/session-links";
import { UnknownSessionError, type ActiveSessionRegistry, type OpenSessionInput } from "./active-sessions";
import {
  deleteSessionHistory, SessionHistoryConflictError,
  type DeleteSessionHistoryOptions, type SessionHistoryTarget,
} from "./session-deletion";
import type { SubagentSessionService, SubagentSessionStore } from "./subagent-sessions";

/** Read-only revalidation, called inside the registry gate before persistent Pi.open. */
export function validateHistoricalSession(
  target: SessionHistoryTarget,
  store: SubagentSessionStore,
): void {
  try {
    if (!lstatSync(target.path).isFile()) throw new SessionHistoryConflictError();
    const header = JSON.parse(readFileSync(target.path, "utf8").split("\n", 1)[0]!);
    if (header?.type !== "session" || header.id !== target.id || header.cwd !== target.cwd) {
      throw new SessionHistoryConflictError();
    }
    const manager = store.open(target.path);
    if (manager.getSessionId() !== target.id || manager.getSessionFile() !== target.path
      || manager.getCwd() !== target.cwd) throw new SessionHistoryConflictError();
    if (isSubagentSessionName(manager.getSessionName())) throw new UnknownSessionError("Unknown user session.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new UnknownSessionError("Session history no longer exists.");
    if (error instanceof SyntaxError) throw new SessionHistoryConflictError();
    throw error;
  }
}

export function createSessionHistoryLifecycle(input: {
  registry: ActiveSessionRegistry;
  store: SubagentSessionStore;
  sessionsDir: string;
  usage: Pick<SubagentSessionService, "invalidateUsage">;
  removeFile?: DeleteSessionHistoryOptions["removeFile"];
}) {
  const { registry, store, usage } = input;
  return {
    validateOpen(target: OpenSessionInput): void {
      if (!target.sessionId) throw new SessionHistoryConflictError();
      validateHistoricalSession({ id: target.sessionId, path: target.sessionPath, cwd: target.cwd }, store);
    },
    deleteSession(id: string, force: boolean): Promise<void> {
      return registry.deleteSession(id, force, {
        async resolve(sessionId) {
          const matches = (await store.listAll()).filter((session) => session.id === sessionId);
          if (matches.length === 0) throw new UnknownSessionError("Unknown user session.");
          if (matches.length !== 1) throw new SessionHistoryConflictError();
          const target = matches[0]!;
          validateHistoricalSession(target, store);
          return target;
        },
        async remove(target, allowMissingRoot) {
          try {
            await deleteSessionHistory(target, {
              sessionsDir: input.sessionsDir, store, allowMissingRoot, removeFile: input.removeFile,
            });
          } finally {
            // Partial unlink failures also invalidate observational projections.
            usage.invalidateUsage();
          }
        },
      });
    },
  };
}
