import { randomUUID } from "node:crypto";
import { realpathSync, statSync, watch as nativeWatch } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Logger } from "../runtime/logger";
import type { FileWatcherEvent } from "./contracts";

export type { FileWatcherEvent, FileWatcherEventKind } from "./contracts";

export class UnknownFileWatchLeaseError extends Error {}
export class FileWatchPathError extends Error {}

export interface FileWatcher {
  acquireLease(): string;
  replaceLease(leaseId: string, revision: number, directories: readonly string[]): boolean;
  releaseLease(leaseId: string): void;
  close(): Promise<void>;
}

export interface FileWatcherFactory {
  create(options: { cwd: string; onEvent: (event: FileWatcherEvent) => void }): FileWatcher;
}

interface NativeWatcher {
  on(event: "error", listener: (error: Error) => void): NativeWatcher;
  close(): void;
}

type NativeWatchListener = (event: "rename" | "change", filename: string | Buffer | null) => void;

export type WatchImplementation = (
  path: string,
  options: { recursive: false },
  listener: NativeWatchListener,
) => NativeWatcher;

interface LeaseState {
  revision: number;
  directories: Set<string>;
}

interface PendingEvent {
  directory: string;
  timer: ReturnType<typeof setTimeout>;
}

const STABILITY_THRESHOLD_MS = 200;

function isWithin(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function isGitPath(root: string, target: string): boolean {
  const git = join(root, ".git");
  return target === git || target.startsWith(`${git}${sep}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function aggregateDirectories(leases: Iterable<LeaseState>): Set<string> {
  const directories = new Set<string>();
  for (const lease of leases) {
    for (const directory of lease.directories) directories.add(directory);
  }
  return directories;
}

function createNoopFileWatcher(): FileWatcher {
  const leases = new Map<string, LeaseState>();
  let closed = false;
  return {
    acquireLease() {
      if (closed) throw new Error("File watcher is closed");
      const leaseId = randomUUID();
      leases.set(leaseId, { revision: -1, directories: new Set() });
      return leaseId;
    },
    replaceLease(leaseId, revision, directories) {
      const lease = leases.get(leaseId);
      if (!lease) throw new UnknownFileWatchLeaseError(`Unknown file watch lease: ${leaseId}`);
      if (revision <= lease.revision) return false;
      lease.revision = revision;
      lease.directories = new Set(directories);
      return true;
    },
    releaseLease(leaseId) {
      leases.delete(leaseId);
    },
    async close() {
      if (closed) return;
      closed = true;
      leases.clear();
    },
  };
}

export function createNoopFileWatcherFactory(): FileWatcherFactory {
  return { create: () => createNoopFileWatcher() };
}

export function createFileWatcherFactory(
  logger: Logger,
  watchImpl: WatchImplementation = nativeWatch as unknown as WatchImplementation,
): FileWatcherFactory {
  return {
    create({ cwd, onEvent }) {
      const root = resolve(cwd);
      const realRoot = realpathSync(root);
      const leases = new Map<string, LeaseState>();
      const watchers = new Map<string, NativeWatcher>();
      const pendingEvents = new Map<string, PendingEvent>();
      let closed = false;
      let closePromise: Promise<void> | undefined;

      const clearPendingForDirectory = (directory: string): void => {
        for (const [key, pending] of pendingEvents) {
          if (pending.directory !== directory) continue;
          clearTimeout(pending.timer);
          pendingEvents.delete(key);
        }
      };

      const stopDirectory = (directory: string): void => {
        clearPendingForDirectory(directory);
        const watcher = watchers.get(directory);
        if (!watcher) return;
        watchers.delete(directory);
        try {
          watcher.close();
        } catch (error) {
          logger.warn("file watcher close failed", { cwd: directory, error: errorText(error) });
        }
      };

      const schedule = (directory: string, file: string): void => {
        const key = `${directory}\0${file}`;
        const previous = pendingEvents.get(key);
        if (previous) clearTimeout(previous.timer);
        const timer = setTimeout(() => {
          pendingEvents.delete(key);
          if (closed || !watchers.has(directory)) return;
          onEvent({ type: "file.watcher.updated", properties: { file, event: "change" } });
        }, STABILITY_THRESHOLD_MS);
        pendingEvents.set(key, { directory, timer });
      };

      const eventPath = (directory: string, filename: string | Buffer | null): string | undefined => {
        if (filename === null) return undefined;
        const value = Buffer.isBuffer(filename) ? filename.toString() : filename;
        if (!value) return undefined;
        const candidate = resolve(directory, value);
        if (!isWithin(directory, candidate) || !isWithin(root, candidate) || isGitPath(root, candidate)) return undefined;
        return candidate;
      };

      const startDirectory = (directory: string): void => {
        if (closed || watchers.has(directory)) return;
        let watcher: NativeWatcher;
        try {
          watcher = watchImpl(directory, { recursive: false }, (event, filename) => {
            if (closed || watchers.get(directory) !== watcher) return;
            const file = eventPath(directory, filename);
            if (file === undefined && filename !== null) return;
            schedule(directory, event === "change" && file ? file : directory);
          });
          watchers.set(directory, watcher);
          watcher.on("error", (error) => {
            if (watchers.get(directory) !== watcher) return;
            logger.warn("file watcher error", { cwd: directory, error: errorText(error) });
            stopDirectory(directory);
          });
        } catch (error) {
          logger.warn("file watcher unavailable", { cwd: directory, error: errorText(error) });
        }
      };

      const reconcile = (): void => {
        const desired = aggregateDirectories(leases.values());
        for (const directory of [...watchers.keys()]) {
          if (!desired.has(directory)) stopDirectory(directory);
        }
        for (const directory of desired) startDirectory(directory);
      };

      const normalizeDirectories = (directories: readonly string[]): Set<string> => {
        const normalized = new Set<string>();
        for (const input of directories) {
          const directory = resolve(input);
          if (!isWithin(root, directory)) {
            throw new FileWatchPathError(`File watch directory is outside the session cwd: ${directory}`);
          }
          if (isGitPath(root, directory)) continue;
          let realDirectory: string;
          try {
            if (!statSync(directory).isDirectory()) {
              throw new FileWatchPathError(`File watch path is not a directory: ${directory}`);
            }
            realDirectory = realpathSync(directory);
          } catch (error) {
            if (error instanceof FileWatchPathError) throw error;
            throw new FileWatchPathError(`File watch path is not a readable directory: ${directory}`);
          }
          if (!isWithin(realRoot, realDirectory)) {
            throw new FileWatchPathError(`File watch directory is outside the session cwd: ${directory}`);
          }
          normalized.add(directory);
        }
        return normalized;
      };

      return {
        acquireLease() {
          if (closed) throw new Error("File watcher is closed");
          const leaseId = randomUUID();
          leases.set(leaseId, { revision: -1, directories: new Set() });
          return leaseId;
        },
        replaceLease(leaseId, revision, directories) {
          const lease = leases.get(leaseId);
          if (!lease) throw new UnknownFileWatchLeaseError(`Unknown file watch lease: ${leaseId}`);
          if (!Number.isSafeInteger(revision) || revision < 0) {
            throw new FileWatchPathError("File watch revision must be a non-negative safe integer");
          }
          if (revision <= lease.revision) return false;
          const normalized = normalizeDirectories(directories);
          lease.revision = revision;
          lease.directories = normalized;
          reconcile();
          return true;
        },
        releaseLease(leaseId) {
          if (!leases.delete(leaseId)) return;
          reconcile();
        },
        close() {
          if (closePromise) return closePromise;
          closePromise = Promise.resolve().then(() => {
            if (closed) return;
            closed = true;
            leases.clear();
            for (const directory of [...watchers.keys()]) stopDirectory(directory);
            for (const pending of pendingEvents.values()) clearTimeout(pending.timer);
            pendingEvents.clear();
          });
          return closePromise;
        },
      };
    },
  };
}
