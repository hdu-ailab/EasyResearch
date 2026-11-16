import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isSubagentSessionName } from "../subagent/session-links";
import { SessionBusyError, SessionLifecycleConflictError, WorkspaceBusyError, UnknownSessionError, type ActiveSessionRegistry, type OpenSessionInput } from "./active-sessions";
import {
  SessionHistoryConflictError,
  prepareSessionDeletion, revalidateDeletionPlan,
  type DeleteSessionHistoryOptions, type SessionHistoryTarget, type DeletionFileGuard,
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
    async deleteSession(
      id: string, force: boolean, files: DeletionFileGuard = (_cwds, run) => run(), expectedCwds?: readonly string[],
    ): Promise<void> {
      const live = registry.list().find((session) => session.id === id);
      const target = live?.sessionFile && !existsSync(live.sessionFile) ? undefined
        : (await store.listAll()).find((session) => session.id === id);
      if (target && live && (live.cwd !== target.cwd || live.sessionFile !== target.path)) {
        throw new SessionLifecycleConflictError();
      }
      if (target) validateHistoricalSession(target, store);
      const prepare = () => prepareSessionDeletion([target!], {
        sessionsDir: input.sessionsDir, store, removeFile: input.removeFile,
        onRemoved: (sessionId) => {
          if (sessionId !== id) registry.publishSessionEvent(sessionId, { type: "session_deleted", sessionId });
        },
      });
      const before = target ? await prepare() : undefined;
      const heldCwds = before?.cwds ?? (live ? [live.cwd] : []);
      const targetCwd = target?.cwd ?? live?.cwd;
      const acknowledged = expectedCwds ?? (targetCwd ? [targetCwd] : []);
      if (force && heldCwds.some((cwd) => !acknowledged.includes(cwd))) {
        throw new SessionBusyError(heldCwds);
      }
      if (target && before && before.cwds.some((cwd) => cwd !== target.cwd)) {
        try {
          return await files(before.cwds, () => registry.withWorkspaceMutation(
            before.cwds.map((cwd) => ({ cwd })), force, async () => {
              try {
                if (registry.list().some((session) => session.id === id)) throw new SessionLifecycleConflictError();
                const after = await prepare();
                revalidateDeletionPlan(before, after);
                after.execute();
                registry.publishSessionEvent(id, { type: "session_deleted", sessionId: id });
              } finally { usage.invalidateUsage(); }
            },
          ));
        } catch (error) {
          if (error instanceof WorkspaceBusyError) throw new SessionBusyError(before.cwds);
          throw error;
        }
      }
      try {
        return await files(heldCwds, () => registry.deleteSession(id, force, {
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
              if (before) {
                const after = await prepare();
                revalidateDeletionPlan(before, after);
                after.execute();
                return;
              }
              const after = await prepareSessionDeletion([target], {
                sessionsDir: input.sessionsDir, store, allowMissingRoot, removeFile: input.removeFile,
              });
              if (after.cwds.some((cwd) => !heldCwds.includes(cwd))) {
                throw new SessionHistoryConflictError("Session deletion requires newly discovered workspace ownership.");
              }
              after.execute();
            } finally {
              // Partial unlink failures also invalidate observational projections.
              usage.invalidateUsage();
            }
          },
        }));
      } catch (error) {
        if (error instanceof SessionBusyError) throw new SessionBusyError(heldCwds);
        throw error;
      }
    },
  };
}
