import { isAbsolute, dirname, join, basename, resolve } from "node:path";
import { existsSync, lstatSync } from "node:fs";
import { matchesWorkspaceScope, type ActiveSessionRegistry } from "./active-sessions";
import { DirectoryService, DirectoryServiceError } from "./directories";
import { deleteSessionHistories } from "./session-deletion";
import type { SubagentSessionStore } from "./subagent-sessions";
import { rebaseWorkspacePath, relocateWorkspaceHistories, workspaceHistoryInventory } from "./workspace-history";
import type { WorkspaceMutationResultDto } from "./contracts";

export class WorkspaceError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly cwd: string) {
    super(message);
  }
}

export function requireWorkspaceDirectory(directories: DirectoryService, cwd: string): string {
  try { return directories.requireCwd(cwd); }
  catch (error) {
    if (error instanceof DirectoryServiceError && (error.status === 404 || error.status === 400)) {
      throw new WorkspaceError(error.status, "WORKSPACE_MISSING", "Workspace folder cannot be found. Was it moved or renamed?", cwd);
    }
    throw error;
  }
}

export class WorkspaceService {
  constructor(private readonly input: {
    store: SubagentSessionStore;
    sessionsDir: string;
    registry: Pick<ActiveSessionRegistry, "list" | "withWorkspaceMutation" | "publishSessionEvent">;
    directories: DirectoryService;
    invalidateUsage: () => void;
  }) {}

  async validate(cwd: string): Promise<{ cwd: string }> {
    await this.known(cwd);
    requireWorkspaceDirectory(this.input.directories, cwd);
    return { cwd };
  }

  async delete(cwd: string, force = false): Promise<WorkspaceMutationResultDto> {
    await this.known(cwd);
    const { registry, store, sessionsDir } = this.input;
    return registry.withWorkspaceMutation([{ cwd }], force, async (stopped) => {
      const histories = (await workspaceHistoryInventory(store, sessionsDir)).filter((entry) => entry.cwd === cwd);
      try {
        const removed = await deleteSessionHistories(histories, {
          sessionsDir, store, preserveSharedChildren: true,
          onRemoved: (sessionId) => registry.publishSessionEvent(sessionId, { type: "session_deleted", sessionId }),
        });
        const ids = [...new Set([...removed, ...stopped.filter((session) => !session.sessionFile || !existsSync(session.sessionFile)).map((session) => session.id)])];
        for (const sessionId of ids) if (!removed.includes(sessionId)) registry.publishSessionEvent(sessionId, { type: "session_deleted", sessionId });
        return { cwd, sessionIds: ids };
      } finally { this.input.invalidateUsage(); }
    });
  }

  async rename(cwd: string, name: string, force = false): Promise<WorkspaceMutationResultDto> {
    await this.known(cwd);
    requireWorkspaceDirectory(this.input.directories, cwd);
    if (!name || name.trim() !== name || name === "." || name === ".." || /[\\/\x00-\x1f]/u.test(name)
      || dirname(cwd) === cwd || matchesWorkspaceScope(this.input.sessionsDir, { cwd, descendants: true })) {
      throw new WorkspaceError(400, "WORKSPACE_NAME_INVALID", "Enter a valid folder name", cwd);
    }
    const destination = join(dirname(cwd), name);
    if (basename(cwd) === name) return { cwd, sessionIds: [] };
    if (existsSync(destination)) {
      const source = lstatSync(cwd);
      const target = lstatSync(destination);
      if (target.isSymbolicLink() || target.dev !== source.dev || target.ino !== source.ino) {
        throw new WorkspaceError(409, "WORKSPACE_DESTINATION_EXISTS", "A folder with this name already exists", cwd);
      }
    }
    return this.move(cwd, destination, force, true);
  }

  async relocate(cwd: string, directory: string, force = false): Promise<WorkspaceMutationResultDto> {
    await this.known(cwd);
    const destination = this.input.directories.requireCwd(directory);
    if (destination !== cwd && matchesWorkspaceScope(destination, { cwd, descendants: true })) {
      throw new WorkspaceError(400, "WORKSPACE_DESTINATION_INVALID", "Choose a folder outside the current workspace", cwd);
    }
    return this.move(cwd, destination, force, false);
  }

  private async move(cwd: string, destination: string, force: boolean, rename: boolean): Promise<WorkspaceMutationResultDto> {
    const { registry, store, sessionsDir } = this.input;
    if (cwd === destination) { requireWorkspaceDirectory(this.input.directories, cwd); return { cwd, sessionIds: [] }; }
    const scope = { cwd, descendants: true };
    return registry.withWorkspaceMutation([scope], force, async (stopped) => {
      if (!rename) this.input.directories.requireCwd(destination);
      const histories = (await workspaceHistoryInventory(store, sessionsDir)).filter((entry) => matchesWorkspaceScope(entry.cwd, scope));
      if (!histories.length && !stopped.some((session) => matchesWorkspaceScope(session.cwd, scope))) {
        throw new WorkspaceError(404, "WORKSPACE_UNKNOWN", "Workspace changed. Refresh and try again.", cwd);
      }
      const rebase = (path: string) => rebaseWorkspacePath(path, cwd, destination);
      try {
        relocateWorkspaceHistories(histories, rebase, rename ? { directoryRename: { source: cwd, destination } } : {});
        const moved = new Map(histories.map((entry) => [entry.id, rebase(entry.cwd)]));
        for (const session of stopped) {
          if (matchesWorkspaceScope(session.cwd, scope)) moved.set(session.id, rebase(session.cwd));
        }
        for (const [sessionId, nextCwd] of moved) {
          registry.publishSessionEvent(sessionId, { type: "session_relocated", sessionId, cwd: nextCwd });
        }
        return { cwd: destination, sessionIds: [...moved.keys()] };
      } finally { this.input.invalidateUsage(); }
    });
  }

  private async known(cwd: string): Promise<void> {
    if (typeof cwd !== "string" || !isAbsolute(cwd) || resolve(cwd) !== cwd) {
      throw new WorkspaceError(400, "WORKSPACE_INVALID", "An exact absolute workspace path is required", cwd);
    }
    if (this.input.registry.list().some((session) => session.cwd === cwd)) return;
    if ((await this.input.store.listAll()).some((session) => session.cwd === cwd)) return;
    throw new WorkspaceError(404, "WORKSPACE_UNKNOWN", "Unknown workspace", cwd);
  }
}
