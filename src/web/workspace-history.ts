import {
  chmodSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync,
  rmSync, statSync, utimesSync, writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { SessionHistoryConflictError, type SessionHistoryTarget } from "./session-deletion";
import type { SubagentSessionStore } from "./subagent-sessions";
import { createLogger } from "../runtime/logger";

const logger = createLogger("workspace-history");

function readHeader(path: string): { value: Record<string, unknown>; length: number } {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    while (length < 1024 * 1024) {
      const buffer = Buffer.alloc(16 * 1024);
      const count = readSync(fd, buffer, 0, buffer.length, length);
      const newline = buffer.subarray(0, count).indexOf(10);
      chunks.push(buffer.subarray(0, newline < 0 ? count : newline));
      length += newline < 0 ? count : newline + 1;
      if (newline >= 0 || count === 0) {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) break;
        return { value: value as Record<string, unknown>, length };
      }
    }
    throw new Error("Invalid session header");
  } catch {
    throw new SessionHistoryConflictError(`Cannot verify session header: ${path}`);
  } finally {
    closeSync(fd);
  }
}

/** Native listing plus physical completeness, without opening a writable Pi session. */
export async function workspaceHistoryInventory(
  store: SubagentSessionStore,
  sessionsDir: string,
): Promise<SessionHistoryTarget[]> {
  const listed = await store.listAll();
  if (!existsSync(sessionsDir) && listed.length === 0) return [];
  const physical = realpathSync(sessionsDir);
  const byPath = new Map(listed.map((entry) => [entry.path, entry]));
  if (byPath.size !== listed.length || new Set(listed.map((entry) => entry.id)).size !== listed.length) {
    throw new SessionHistoryConflictError("Ambiguous session inventory");
  }
  const seen = new Set<string>();
  let remaining = 100_000;
  for (const bucket of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (--remaining < 0) throw new SessionHistoryConflictError("Session inventory is too large");
    const directory = join(sessionsDir, bucket.name);
    if (bucket.isSymbolicLink()) throw new SessionHistoryConflictError("Linked session directory");
    if (!bucket.isDirectory()) continue;
    if (realpathSync(directory) !== join(physical, bucket.name)) throw new SessionHistoryConflictError("Redirected session directory");
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      if (--remaining < 0) throw new SessionHistoryConflictError("Session inventory is too large");
      if (!file.name.endsWith(".jsonl")) continue;
      const path = join(directory, file.name);
      if (!file.isFile() || file.isSymbolicLink()) throw new SessionHistoryConflictError("Unsafe session history file");
      const listedFile = byPath.get(path);
      const header = readHeader(path).value;
      if (!listedFile || header.type !== "session" || header.id !== listedFile.id || header.cwd !== listedFile.cwd) {
        throw new SessionHistoryConflictError("Session inventory is incomplete or changed");
      }
      seen.add(path);
    }
  }
  if (seen.size !== listed.length) throw new SessionHistoryConflictError("Session inventory is outside its store");
  return listed;
}

function fingerprint(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new SessionHistoryConflictError("Session history was replaced");
  return `${realpathSync(path)}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/** Reserve a new directory name so a concurrent creator cannot be overwritten. */
export function renameWorkspaceDirectory(source: string, destination: string): void {
  const original = lstatSync(source);
  if (!original.isDirectory() || original.isSymbolicLink()) throw new Error("Workspace must be an ordinary directory");
  if (existsSync(destination)) {
    const target = lstatSync(destination);
    // A case-only rename on a case-insensitive filesystem names the same directory.
    if (!target.isSymbolicLink() && target.dev === original.dev && target.ino === original.ino) {
      renameSync(source, destination);
      return;
    }
    throw new Error("A folder with this name already exists");
  }
  // Windows rename already rejects an existing destination directory.
  if (process.platform === "win32") { renameSync(source, destination); return; }
  mkdirSync(destination);
  const reservation = lstatSync(destination);
  try {
    renameSync(source, destination);
  } catch (error) {
    const current = lstatSync(destination);
    if (current.dev === reservation.dev && current.ino === reservation.ino) {
      try { rmdirSync(destination); } catch { /* Do not remove files added by another process. */ }
    }
    throw error;
  }
}

/** Header-only relocation keeps every UUID, child/fork path and transcript byte. */
export function relocateWorkspaceHistories(
  histories: readonly SessionHistoryTarget[],
  destination: (cwd: string) => string,
  options: {
    directoryRename?: { source: string; destination: string };
    publish?: (source: string, destination: string) => void;
  } = {},
): void {
  const stages: Array<{ path: string; directory: string; backup: string; updated: string; stamp: string; published: boolean; publishedStamp?: string }> = [];
  let directoryRenamed = false;
  let retainBackups = false;
  try {
    for (const history of histories) {
      const stamp = fingerprint(history.path);
      const header = readHeader(history.path);
      if (header.value.id !== history.id || header.value.cwd !== history.cwd) {
        throw new SessionHistoryConflictError("Session identity changed before relocation");
      }
      const directory = mkdtempSync(join(dirname(history.path), ".workspace-relocation-"));
      const backup = join(directory, "original");
      const updated = join(directory, "updated");
      const stage = { path: history.path, directory, backup, updated, stamp, published: false };
      stages.push(stage);
      copyFileSync(history.path, backup, constants.COPYFILE_EXCL);
      const source = openSync(backup, "r");
      let target: number | undefined;
      try {
        target = openSync(updated, "wx", 0o600);
        const bytes = Buffer.from(`${JSON.stringify({ ...header.value, cwd: destination(history.cwd) })}\n`);
        const write = (data: Buffer) => {
          for (let offset = 0; offset < data.length;) offset += writeSync(target!, data, offset, data.length - offset);
        };
        write(bytes);
        const buffer = Buffer.alloc(64 * 1024);
        let position = header.length;
        for (;;) {
          const count = readSync(source, buffer, 0, buffer.length, position);
          if (!count) break;
          write(buffer.subarray(0, count));
          position += count;
        }
      } finally { closeSync(source); if (target !== undefined) closeSync(target); }
      const stat = statSync(history.path);
      chmodSync(updated, stat.mode & 0o777);
      utimesSync(updated, stat.atime, stat.mtime);
      if (fingerprint(history.path) !== stamp) throw new SessionHistoryConflictError("Session changed during relocation preparation");
    }
    if (options.directoryRename) {
      renameWorkspaceDirectory(options.directoryRename.source, options.directoryRename.destination);
      directoryRenamed = true;
    }
    for (const stage of stages) {
      if (fingerprint(stage.path) !== stage.stamp) throw new SessionHistoryConflictError("Session changed during relocation");
      (options.publish ?? renameSync)(stage.updated, stage.path);
      stage.published = true;
      stage.publishedStamp = fingerprint(stage.path);
    }
  } catch (error) {
    const failures: unknown[] = [error];
    for (const stage of stages.toReversed()) {
      if (!stage.published) continue;
      try {
        if (fingerprint(stage.path) !== stage.publishedStamp) throw new SessionHistoryConflictError("Relocated history changed before rollback");
        renameSync(stage.backup, stage.path);
      } catch (failure) { failures.push(failure); }
    }
    if (directoryRenamed && options.directoryRename) {
      try { renameWorkspaceDirectory(options.directoryRename.destination, options.directoryRename.source); }
      catch (failure) { failures.push(failure); }
    }
    if (failures.length > 1) {
      retainBackups = true;
      throw new AggregateError(failures, "Workspace relocation rollback failed; original histories are retained beside their session files");
    }
    throw error;
  } finally {
    if (!retainBackups) for (const stage of stages) {
      try { rmSync(stage.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
      catch { logger.warn("workspace temporary-file cleanup failed", { path: stage.directory }); }
    }
  }
}

export function rebaseWorkspacePath(path: string, source: string, destination: string): string {
  const suffix = relative(source, path);
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) {
    throw new SessionHistoryConflictError("Workspace path is outside relocation scope");
  }
  return join(destination, suffix);
}
