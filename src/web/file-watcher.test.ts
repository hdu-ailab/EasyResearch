import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../runtime/logger";
import {
  createFileWatcherFactory,
  type FileWatcherEvent,
  type FileWatcherEventKind,
  type WatchImplementation,
} from "./file-watcher";

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function fakeChokidarWatch() {
  const callbacks = new Map<string, (path: string) => void>();
  const close = vi.fn(async () => {});
  const watch = vi.fn(() => ({
    on(event: string, callback: (path: string) => void) {
      callbacks.set(event, callback);
      return this;
    },
    close,
  }));
  return {
    watch,
    close,
    emit(event: string, path: string) {
      callbacks.get(event)?.(path);
    },
  };
}

describe("file watcher", () => {
  it("maps add, addDir, change, unlink, and unlinkDir to the SSE contract", () => {
    const emit = vi.fn<(event: FileWatcherEvent) => void>();
    const fake = fakeChokidarWatch();
    createFileWatcherFactory(noopLogger, fake.watch as unknown as WatchImplementation).create({ cwd: "/p", onEvent: emit });

    fake.emit("add", "/p/new.txt");
    fake.emit("addDir", "/p/new-dir");
    fake.emit("change", "/p/new.txt");
    fake.emit("unlink", "/p/old.txt");
    fake.emit("unlinkDir", "/p/old-dir");

    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: "file.watcher.updated", properties: { file: "/p/new.txt", event: "add" } },
      { type: "file.watcher.updated", properties: { file: "/p/new-dir", event: "add" } },
      { type: "file.watcher.updated", properties: { file: "/p/new.txt", event: "change" } },
      { type: "file.watcher.updated", properties: { file: "/p/old.txt", event: "unlink" } },
      { type: "file.watcher.updated", properties: { file: "/p/old-dir", event: "unlink" } },
    ] satisfies Array<{ type: "file.watcher.updated"; properties: { file: string; event: FileWatcherEventKind } }>);
  });

  it("ignores .git paths and paths outside the watched cwd", () => {
    const emit = vi.fn<(event: FileWatcherEvent) => void>();
    const fake = fakeChokidarWatch();
    createFileWatcherFactory(noopLogger, fake.watch as unknown as WatchImplementation).create({ cwd: "/p", onEvent: emit });

    fake.emit("add", "/p/.git/index");
    fake.emit("add", "/p/../outside.txt");

    expect(emit).not.toHaveBeenCalled();
  });

  it("closes chokidar only once", async () => {
    const fake = fakeChokidarWatch();
    const watcher = createFileWatcherFactory(noopLogger, fake.watch as unknown as WatchImplementation).create({ cwd: "/p", onEvent: () => {} });

    await Promise.all([watcher.close(), watcher.close()]);

    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("keeps watcher startup errors non-fatal", () => {
    const warn = vi.fn();
    const watch = vi.fn(() => {
      throw new Error("watch unavailable");
    });

    const watcher = createFileWatcherFactory({ ...noopLogger, warn }, watch as unknown as WatchImplementation).create({ cwd: "/p", onEvent: () => {} });

    expect(warn).toHaveBeenCalledWith("file watcher unavailable", expect.objectContaining({ cwd: "/p" }));
    expect(watcher.close()).resolves.toBeUndefined();
  });
});
