import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../runtime/logger";
import {
  createFileWatcherFactory,
  type FileWatcherEvent,
  type WatchImplementation,
} from "./file-watcher";

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): { root: string; src: string; nested: string } {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-file-watch-"));
  const src = join(root, "src");
  const nested = join(src, "nested");
  mkdirSync(nested, { recursive: true });
  roots.push(root);
  return { root, src, nested };
}

function fakeNativeWatch() {
  type Listener = (event: "rename" | "change", filename: string | Buffer | null) => void;
  interface Handle {
    path: string;
    listener: Listener;
    errorListener?: (error: Error) => void;
    closed: boolean;
    close: ReturnType<typeof vi.fn>;
    on(event: string, callback: (error: Error) => void): Handle;
  }

  const handles: Handle[] = [];
  const watch = vi.fn((path: string, _options: object, listener: Listener) => {
    const handle: Handle = {
      path,
      listener,
      closed: false,
      close: vi.fn(() => {
        handle.closed = true;
      }),
      on(event, callback) {
        if (event === "error") handle.errorListener = callback;
        return handle;
      },
    };
    handles.push(handle);
    return handle;
  });

  return {
    watch,
    activePaths: () => handles.filter((handle) => !handle.closed).map((handle) => handle.path).sort(),
    emit(path: string, event: "rename" | "change", filename: string | Buffer | null) {
      handles.find((handle) => handle.path === path && !handle.closed)?.listener(event, filename);
    },
    fail(path: string, error: Error) {
      handles.find((handle) => handle.path === path && !handle.closed)?.errorListener?.(error);
    },
  };
}

describe("demand-driven file watcher", () => {
  it("starts with zero native watchers and watches only leased directories non-recursively", () => {
    const { root, src } = workspace();
    const fake = fakeNativeWatch();
    const watcher = createFileWatcherFactory(noopLogger, fake.watch as unknown as WatchImplementation).create({
      cwd: root,
      onEvent: () => {},
    });

    expect(fake.activePaths()).toEqual([]);

    const lease = watcher.acquireLease();
    expect(watcher.replaceLease(lease, 1, [root, src])).toBe(true);
    expect(fake.activePaths()).toEqual([root, src].sort());
    expect(fake.watch.mock.calls.every(([, options]) => (options as { recursive?: boolean }).recursive !== true)).toBe(true);
  });

  it("closes collapsed directories and their hidden descendants on full-set replacement", () => {
    const { root, src, nested } = workspace();
    const fake = fakeNativeWatch();
    const watcher = createFileWatcherFactory(noopLogger, fake.watch as unknown as WatchImplementation).create({
      cwd: root,
      onEvent: () => {},
    });
    const lease = watcher.acquireLease();

    watcher.replaceLease(lease, 1, [root, src, nested]);
    watcher.replaceLease(lease, 2, [root]);

    expect(fake.activePaths()).toEqual([root]);
  });

  it("keeps the union across SSE leases and releases only the disconnected owner", () => {
    const { root, src, nested } = workspace();
    const fake = fakeNativeWatch();
    const watcher = createFileWatcherFactory(noopLogger, fake.watch as unknown as WatchImplementation).create({
      cwd: root,
      onEvent: () => {},
    });
    const first = watcher.acquireLease();
    const second = watcher.acquireLease();

    watcher.replaceLease(first, 1, [root, src]);
    watcher.replaceLease(second, 1, [root, nested]);
    expect(fake.activePaths()).toEqual([nested, root, src].sort());

    watcher.releaseLease(first);
    expect(fake.activePaths()).toEqual([nested, root].sort());

    watcher.releaseLease(second);
    expect(fake.activePaths()).toEqual([]);
  });

  it("ignores stale replacements so an older request cannot reopen collapsed directories", () => {
    const { root, src } = workspace();
    const fake = fakeNativeWatch();
    const watcher = createFileWatcherFactory(noopLogger, fake.watch as unknown as WatchImplementation).create({
      cwd: root,
      onEvent: () => {},
    });
    const lease = watcher.acquireLease();

    expect(watcher.replaceLease(lease, 2, [root])).toBe(true);
    expect(watcher.replaceLease(lease, 1, [root, src])).toBe(false);
    expect(fake.activePaths()).toEqual([root]);
  });

  it("coalesces direct writes by file and rename activity by watched directory", async () => {
    vi.useFakeTimers();
    const { root } = workspace();
    const fake = fakeNativeWatch();
    const emit = vi.fn<(event: FileWatcherEvent) => void>();
    const watcher = createFileWatcherFactory(noopLogger, fake.watch as unknown as WatchImplementation).create({
      cwd: root,
      onEvent: emit,
    });
    const lease = watcher.acquireLease();
    watcher.replaceLease(lease, 1, [root]);

    fake.emit(root, "change", "paper.md");
    fake.emit(root, "change", "paper.md");
    fake.emit(root, "rename", "replacement.tmp");
    await vi.advanceTimersByTimeAsync(199);
    expect(emit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: "file.watcher.updated", properties: { file: join(root, "paper.md"), event: "change" } },
      { type: "file.watcher.updated", properties: { file: root, event: "change" } },
    ]);
  });

  it("rejects out-of-cwd directories without disturbing the accepted lease set", () => {
    const { root } = workspace();
    const outside = workspace().root;
    const fake = fakeNativeWatch();
    const watcher = createFileWatcherFactory(noopLogger, fake.watch as unknown as WatchImplementation).create({
      cwd: root,
      onEvent: () => {},
    });
    const lease = watcher.acquireLease();
    watcher.replaceLease(lease, 1, [root]);

    expect(() => watcher.replaceLease(lease, 2, [root, outside])).toThrow(/outside the session cwd/i);
    expect(fake.activePaths()).toEqual([root]);
  });

  it("treats native watcher errors as non-fatal and closes all resources once", async () => {
    const { root } = workspace();
    const fake = fakeNativeWatch();
    const warn = vi.fn();
    const watcher = createFileWatcherFactory({ ...noopLogger, warn }, fake.watch as unknown as WatchImplementation).create({
      cwd: root,
      onEvent: () => {},
    });
    const lease = watcher.acquireLease();
    watcher.replaceLease(lease, 1, [root]);

    fake.fail(root, new Error("watch failed"));
    expect(fake.activePaths()).toEqual([]);
    expect(warn).toHaveBeenCalledWith("file watcher error", expect.objectContaining({ cwd: root }));

    await Promise.all([watcher.close(), watcher.close()]);
    expect(fake.activePaths()).toEqual([]);
  });
});
