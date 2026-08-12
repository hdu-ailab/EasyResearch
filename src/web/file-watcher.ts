import { resolve, relative, sep, join, isAbsolute } from "node:path";
import { watch as chokidarWatch, type ChokidarOptions, type FSWatcher } from "chokidar";
import type { Logger } from "../runtime/logger";
import type { FileWatcherEvent, FileWatcherEventKind } from "./contracts";

export type { FileWatcherEvent, FileWatcherEventKind } from "./contracts";

export interface FileWatcher {
  close(): Promise<void>;
}

export interface FileWatcherFactory {
  create(options: { cwd: string; onEvent: (event: FileWatcherEvent) => void }): FileWatcher;
}

export type WatchImplementation = (path: string, options: ChokidarOptions) => FSWatcher;

const WATCH_EVENTS: Array<["add" | "addDir" | "change" | "unlink" | "unlinkDir", FileWatcherEventKind]> = [
  ["add", "add"],
  ["addDir", "add"],
  ["change", "change"],
  ["unlink", "unlink"],
  ["unlinkDir", "unlink"],
];

const noopFileWatcher: FileWatcher = { close: async () => {} };

export function createNoopFileWatcherFactory(): FileWatcherFactory {
  return { create: () => noopFileWatcher };
}

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

export function createFileWatcherFactory(
  logger: Logger,
  watchImpl: WatchImplementation = chokidarWatch as WatchImplementation,
): FileWatcherFactory {
  return {
    create({ cwd, onEvent }) {
      const root = resolve(cwd);
      let watcher: FSWatcher;
      try {
        watcher = watchImpl(root, {
          ignoreInitial: true,
          ignored: (candidate) => {
            const path = resolve(String(candidate));
            return isGitPath(root, path);
          },
          awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
        });
      } catch (error) {
        logger.warn("file watcher unavailable", { cwd: root, error: errorText(error) });
        return noopFileWatcher;
      }

      let closed = false;
      const emit = (candidate: string, event: FileWatcherEventKind) => {
        if (closed) return;
        const file = resolve(candidate);
        if (!isWithin(root, file) || isGitPath(root, file)) return;
        onEvent({ type: "file.watcher.updated", properties: { file, event } });
      };

      for (const [watchEvent, event] of WATCH_EVENTS) {
        watcher.on(watchEvent, (candidate) => emit(String(candidate), event));
      }
      watcher.on("error", (error) => {
        logger.warn("file watcher error", { cwd: root, error: errorText(error) });
      });

      return {
        close: async () => {
          if (closed) return;
          closed = true;
          await watcher.close();
        },
      };
    },
  };
}
