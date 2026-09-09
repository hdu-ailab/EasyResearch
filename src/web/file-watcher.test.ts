import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, watch as nativeWatch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../runtime/logger";
import {
  createFileWatcherFactory,
  type FileWatcher,
  type FileWatcherEvent,
  type WatchImplementation,
} from "./file-watcher";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const roots: string[] = [];
const managers: FileWatcher[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
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

function observeWorkspace(root: string) {
  const active = new Map<ReturnType<typeof nativeWatch>, string>();
  const requestedPaths: string[] = [];
  const watch: WatchImplementation = (path, options, listener) => {
    requestedPaths.push(path);
    const handle = nativeWatch(path, options, listener);
    active.set(handle, path);
    return {
      on(event, callback) { handle.on(event, callback); return this; },
      close() { active.delete(handle); handle.close(); },
    };
  };
  const events: FileWatcherEvent[] = [];
  const warn = vi.fn();
  const manager = createFileWatcherFactory({ ...noopLogger, warn }, watch).create({
    cwd: root,
    onEvent: (event) => events.push(event),
  });
  managers.push(manager);
  return {
    manager, events, warn, requestedPaths,
    activePaths: () => [...active.values()].sort(),
    async changed(file: string) {
      await vi.waitFor(() => expect(events.some((event) => event.properties.file === file)).toBe(true), { timeout: 2_000 });
    },
  };
}

const settleEvents = () => new Promise((resolve) => setTimeout(resolve, 350));

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
    watch, handles,
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
  it.each(["rename", "delete"])("rebinds a %s/recreated directory on a newer same-path lease revision", async (mode) => {
    const { root, src } = workspace();
    const observed = observeWorkspace(root);
    const lease = observed.manager.acquireLease();
    observed.manager.replaceLease(lease, 1, [root, src]);

    if (mode === "rename") renameSync(src, `${src}.old`);
    else rmSync(src, { recursive: true });
    mkdirSync(src);
    // No native callback has run yet: the accepted revision must revalidate identity itself.
    expect(observed.manager.replaceLease(lease, 2, [root, src])).toBe(true);
    await settleEvents();
    observed.events.length = 0;
    const fresh = join(src, "fresh.txt");
    writeFileSync(fresh, "new inode");
    await observed.changed(fresh);
    expect(observed.activePaths()).toEqual([root, src].sort());

    if (mode === "rename") {
      await settleEvents();
      observed.events.length = 0;
      writeFileSync(join(`${src}.old`, "ghost.txt"), "old inode");
      await settleEvents();
      expect(observed.events).toEqual([]);
    }
    observed.manager.releaseLease(lease);
    expect(observed.activePaths()).toEqual([]);
  });

  it.each(["rename", "delete"])("automatically recovers a %s/recreated expanded parent and its leased descendants", async (mode) => {
    const { root, src, nested } = workspace();
    const observed = observeWorkspace(root);
    const first = observed.manager.acquireLease();
    const second = observed.manager.acquireLease();
    observed.manager.replaceLease(first, 1, [root, src]);
    observed.manager.replaceLease(second, 1, [root, src, nested]);

    if (mode === "rename") renameSync(src, `${src}.old`);
    else rmSync(src, { recursive: true });
    mkdirSync(nested, { recursive: true });
    await observed.changed(root);
    await settleEvents();
    observed.events.length = 0;
    const fresh = join(nested, "fresh.txt");
    writeFileSync(fresh, "new descendant inode");
    await observed.changed(fresh);
    expect(observed.activePaths()).toEqual([root, src, nested].sort());
    expect(observed.requestedPaths.every((path) => [root, src, nested].includes(path))).toBe(true);

    observed.manager.releaseLease(first);
    expect(observed.activePaths()).toEqual([root, src, nested].sort());
    if (mode === "rename") {
      await settleEvents();
      observed.events.length = 0;
      writeFileSync(join(`${src}.old`, "nested", "ghost.txt"), "old descendant inode");
      await settleEvents();
      expect(observed.events).toEqual([]);
    }
    observed.manager.releaseLease(second);
    expect(observed.activePaths()).toEqual([]);
  });

  it("recovers directories recreated later through the existing leased parents without a lease update", async () => {
    const { root, src, nested } = workspace();
    const observed = observeWorkspace(root);
    const lease = observed.manager.acquireLease();
    observed.manager.replaceLease(lease, 1, [root, src, nested]);

    rmSync(src, { recursive: true });
    await observed.changed(root);
    expect(observed.activePaths()).toEqual([root]);
    observed.events.length = 0;
    mkdirSync(src);
    await observed.changed(root);
    expect(observed.activePaths()).toEqual([root, src].sort());
    observed.events.length = 0;
    mkdirSync(nested);
    await observed.changed(src);
    expect(observed.activePaths()).toEqual([root, src, nested].sort());
    await settleEvents();
    observed.events.length = 0;
    const fresh = join(nested, "fresh.txt");
    writeFileSync(fresh, "recovered after absence");
    await observed.changed(fresh);
  });

  it.skipIf(process.platform === "win32").each(["rename", "delete"])("recovers an immediately %s/recreated cwd without watching its outside parent", async (mode) => {
    const { root, src, nested } = workspace();
    const observed = observeWorkspace(root);
    const lease = observed.manager.acquireLease();
    observed.manager.replaceLease(lease, 1, [root, src, nested]);

    if (mode === "rename") {
      roots.push(`${root}.old`);
      renameSync(root, `${root}.old`);
    } else {
      rmSync(root, { recursive: true });
    }
    mkdirSync(nested, { recursive: true });
    await observed.changed(root);
    await settleEvents();
    observed.events.length = 0;
    const fresh = join(nested, "fresh.txt");
    writeFileSync(fresh, "new root inode");
    await observed.changed(fresh);
    expect(observed.activePaths()).toEqual([root, src, nested].sort());
    expect(observed.requestedPaths.every((path) => [root, src, nested].includes(path))).toBe(true);
    if (mode === "rename") {
      await settleEvents();
      observed.events.length = 0;
      writeFileSync(join(`${root}.old`, "src", "nested", "ghost.txt"), "old root inode");
      await settleEvents();
      expect(observed.events).toEqual([]);
    }
  });

  it.skipIf(process.platform === "win32")("reports loss of the cwd anchor and retries the unchanged set on a newer revision", async () => {
    const { root, src, nested } = workspace();
    const observed = observeWorkspace(root);
    const lease = observed.manager.acquireLease();
    observed.manager.replaceLease(lease, 1, [root, src, nested]);

    roots.push(`${root}.old`);
    renameSync(root, `${root}.old`);
    await vi.waitFor(() => expect(observed.activePaths()).toEqual([]));
    expect(observed.warn).toHaveBeenCalledWith("file watcher unavailable", expect.objectContaining({
      cwd: root,
      recovery: expect.stringMatching(/newer lease revision.*no parent outside the session cwd/i),
    }));
    mkdirSync(nested, { recursive: true });
    expect(observed.manager.replaceLease(lease, 2, [root, src, nested])).toBe(true);
    const fresh = join(nested, "fresh.txt");
    writeFileSync(fresh, "explicit anchor recovery");
    await observed.changed(fresh);
    expect(observed.requestedPaths.every((path) => [root, src, nested].includes(path))).toBe(true);
    await observed.manager.close();
    expect(observed.activePaths()).toEqual([]);
  });

  it("keeps a symlink-cwd spelling while recovering replaced directories", async () => {
    const { root, src } = workspace();
    const alias = join(workspace().root, "project-link");
    symlinkSync(root, alias, "junction");
    const watchedSrc = join(alias, "src");
    const observed = observeWorkspace(alias);
    const lease = observed.manager.acquireLease();
    observed.manager.replaceLease(lease, 1, [alias, watchedSrc]);
    renameSync(src, `${src}.old`);
    mkdirSync(src);
    await observed.changed(alias);
    await settleEvents();
    observed.events.length = 0;
    writeFileSync(join(src, "fresh.txt"), "lexical cwd");
    await observed.changed(join(watchedSrc, "fresh.txt"));
    expect(observed.activePaths()).toEqual([alias, watchedSrc].sort());
    expect(observed.events.every((event) => event.properties.file.startsWith(alias))).toBe(true);
  });

  it.each(["revision", "callback", "timer"])("drops retired callbacks and queued writes when replacement is detected by %s", async (detection) => {
    vi.useFakeTimers();
    const { root, src } = workspace();
    const fake = fakeNativeWatch();
    const emit = vi.fn<(event: FileWatcherEvent) => void>();
    const manager = createFileWatcherFactory(noopLogger, fake.watch as unknown as WatchImplementation).create({ cwd: root, onEvent: emit });
    managers.push(manager);
    const lease = manager.acquireLease();
    manager.replaceLease(lease, 1, [root, src]);
    const retired = fake.handles.find((handle) => handle.path === src)!;
    fake.emit(src, "change", "queued.txt");
    renameSync(src, `${src}.old`);
    mkdirSync(src);
    if (detection === "revision") manager.replaceLease(lease, 2, [root, src]);
    if (detection === "callback") retired.listener("change", "ghost.txt");
    if (detection === "timer") await vi.advanceTimersByTimeAsync(200);
    expect(retired.closed).toBe(true);
    retired.listener("change", "late-ghost.txt");
    retired.errorListener?.(new Error("late retired error"));
    await vi.advanceTimersByTimeAsync(400);
    expect(emit.mock.calls.map(([event]) => event.properties.file)).toEqual([src]);
    expect(fake.activePaths()).toEqual([root, src].sort());

    emit.mockClear();
    fake.emit(src, "change", "fresh.txt");
    await vi.advanceTimersByTimeAsync(200);
    expect(emit.mock.calls.map(([event]) => event.properties.file)).toEqual([join(src, "fresh.txt")]);
    fake.emit(src, "change", "after-close.txt");
    await manager.close();
    retired.listener("rename", null);
    await vi.advanceTimersByTimeAsync(400);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(fake.activePaths()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks descendants when a parent invalidation has no filename", async () => {
    vi.useFakeTimers();
    const { root, src } = workspace();
    const fake = fakeNativeWatch();
    const emit = vi.fn<(event: FileWatcherEvent) => void>();
    const manager = createFileWatcherFactory(noopLogger, fake.watch as unknown as WatchImplementation).create({ cwd: root, onEvent: emit });
    managers.push(manager);
    const lease = manager.acquireLease();
    manager.replaceLease(lease, 1, [root, src]);
    const retired = fake.handles.find((handle) => handle.path === src)!;
    renameSync(src, `${src}.old`);
    mkdirSync(src);
    fake.emit(root, "change", null);
    expect(retired.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(emit.mock.calls.map(([event]) => event.properties.file).sort()).toEqual([root, src].sort());
  });

  it("refuses an out-of-cwd symlink replacement and recovers only the restored contained directory", async () => {
    vi.useFakeTimers();
    const { root, src } = workspace();
    const outside = workspace().root;
    const fake = fakeNativeWatch();
    const emit = vi.fn<(event: FileWatcherEvent) => void>();
    const warn = vi.fn();
    const manager = createFileWatcherFactory({ ...noopLogger, warn }, fake.watch as unknown as WatchImplementation).create({ cwd: root, onEvent: emit });
    managers.push(manager);
    const lease = manager.acquireLease();
    manager.replaceLease(lease, 1, [root, src]);
    fake.emit(src, "change", "queued.txt");
    renameSync(src, `${src}.old`);
    symlinkSync(outside, src, "junction");
    fake.emit(root, "rename", "src");
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.activePaths()).toEqual([root]);
    expect(emit.mock.calls.map(([event]) => event.properties.file)).toEqual([root]);
    expect(warn).toHaveBeenCalledWith("file watcher unavailable", expect.objectContaining({ error: expect.stringMatching(/outside the session cwd/i) }));
    expect(() => manager.replaceLease(lease, 2, [root, src])).toThrow(/outside the session cwd/i);

    rmSync(src);
    mkdirSync(src);
    fake.emit(root, "rename", "src");
    expect(fake.activePaths()).toEqual([root, src].sort());
    expect(fake.watch.mock.calls.map(([path]) => path)).toEqual([root, src, src]);
  });

  it("retries a failed replacement from a later parent event and never revives released leases", async () => {
    vi.useFakeTimers();
    const { root, src } = workspace();
    const fake = fakeNativeWatch();
    const manager = createFileWatcherFactory(noopLogger, fake.watch as unknown as WatchImplementation).create({ cwd: root, onEvent: () => {} });
    managers.push(manager);
    const lease = manager.acquireLease();
    manager.replaceLease(lease, 1, [root, src]);
    renameSync(src, `${src}.old`);
    mkdirSync(src);
    fake.watch.mockImplementationOnce(() => { throw new Error("watch temporarily unavailable"); });
    expect(manager.replaceLease(lease, 2, [root, src])).toBe(true);
    expect(fake.activePaths()).toEqual([root]);
    fake.emit(root, "rename", "src");
    expect(fake.activePaths()).toEqual([root, src].sort());
    fake.fail(src, new Error("watch failed"));
    expect(fake.activePaths()).toEqual([root]);
    expect(manager.replaceLease(lease, 3, [root, src])).toBe(true);
    expect(fake.activePaths()).toEqual([root, src].sort());

    manager.releaseLease(lease);
    for (const handle of fake.handles) handle.listener("rename", null);
    await vi.advanceTimersByTimeAsync(400);
    expect(fake.activePaths()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains recovery invalidations across owners but discards them after the last lease drops the paths", async () => {
    vi.useFakeTimers();
    const { root, src, nested } = workspace();
    const fake = fakeNativeWatch();
    const emit = vi.fn<(event: FileWatcherEvent) => void>();
    const manager = createFileWatcherFactory(noopLogger, fake.watch as unknown as WatchImplementation).create({ cwd: root, onEvent: emit });
    managers.push(manager);
    const first = manager.acquireLease();
    const second = manager.acquireLease();
    manager.replaceLease(first, 1, [root, src, nested]);
    manager.replaceLease(second, 1, [root, src, nested]);

    renameSync(src, `${src}.old`);
    fake.emit(root, "rename", "src");
    await vi.advanceTimersByTimeAsync(200);
    emit.mockClear();
    manager.releaseLease(first);
    mkdirSync(nested, { recursive: true });
    manager.replaceLease(second, 2, [root, src, nested]);
    await vi.advanceTimersByTimeAsync(200);
    expect(emit.mock.calls.map(([event]) => event.properties.file).sort()).toEqual([src, nested].sort());

    rmSync(src, { recursive: true });
    fake.emit(root, "rename", "src");
    await vi.advanceTimersByTimeAsync(200);
    manager.replaceLease(second, 3, [root]);
    emit.mockClear();
    mkdirSync(nested, { recursive: true });
    manager.replaceLease(second, 4, [root, src, nested]);
    await vi.advanceTimersByTimeAsync(200);
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not stat unrelated leased directories for a burst of named file creations", async () => {
    vi.useFakeTimers();
    const { root } = workspace();
    const siblings = Array.from({ length: 256 }, (_, index) => join(root, `directory-${index}`));
    for (const directory of siblings) mkdirSync(directory);
    const fake = fakeNativeWatch();
    const emit = vi.fn<(event: FileWatcherEvent) => void>();
    const manager = createFileWatcherFactory(noopLogger, fake.watch as unknown as WatchImplementation).create({ cwd: root, onEvent: emit });
    managers.push(manager);
    manager.replaceLease(manager.acquireLease(), 1, [root, ...siblings]);
    vi.mocked(statSync).mockClear();
    for (let index = 0; index < 512; index += 1) {
      const filename = `created-${index}.txt`;
      writeFileSync(join(root, filename), "file creation does not replace a sibling directory");
      fake.emit(root, "rename", filename);
    }
    await vi.advanceTimersByTimeAsync(200);
    const unrelated = new Set(siblings);
    expect(vi.mocked(statSync).mock.calls.filter(([path]) => unrelated.has(String(path)))).toHaveLength(0);
    expect(emit.mock.calls.map(([event]) => event.properties.file)).toEqual([root]);
  });

  it.each([false, true])("recovers linked directory spellings when their target changes through another name (absence=%s)", async (absent) => {
    vi.useFakeTimers();
    const { root, src, nested } = workspace();
    const linked = join(root, "linked");
    const linkedNested = join(linked, "nested");
    symlinkSync(src, linked, "junction");
    const fake = fakeNativeWatch();
    const emit = vi.fn<(event: FileWatcherEvent) => void>();
    const manager = createFileWatcherFactory(noopLogger, fake.watch as unknown as WatchImplementation).create({ cwd: root, onEvent: emit });
    managers.push(manager);
    manager.replaceLease(manager.acquireLease(), 1, [root, linked, linkedNested]);
    const retired = fake.handles.find((handle) => handle.path === linkedNested)!;
    renameSync(src, `${src}.old`);
    if (absent) {
      fake.emit(root, "rename", "src");
      expect(fake.activePaths()).toEqual([root]);
    }
    mkdirSync(nested, { recursive: true });
    fake.emit(root, "rename", "src");
    expect(retired.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(emit.mock.calls.map(([event]) => event.properties.file).sort()).toEqual([root, linked, linkedNested].sort());
    expect(fake.activePaths()).toEqual([root, linked, linkedNested].sort());
  });

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

  it("keeps unchanged handles across newer revisions and ignores git and escaped native paths", async () => {
    vi.useFakeTimers();
    const { root } = workspace();
    const git = join(root, ".git");
    mkdirSync(git);
    const fake = fakeNativeWatch();
    const emit = vi.fn<(event: FileWatcherEvent) => void>();
    const manager = createFileWatcherFactory(noopLogger, fake.watch as unknown as WatchImplementation).create({ cwd: root, onEvent: emit });
    managers.push(manager);
    const lease = manager.acquireLease();
    manager.replaceLease(lease, 1, [root, git]);
    const handles = [...fake.handles];
    writeFileSync(join(root, "new.txt"), "directory metadata changes are not identity changes");
    manager.replaceLease(lease, 2, [root, git]);
    expect(fake.handles).toEqual(handles);
    expect(fake.activePaths()).toEqual([root]);
    fake.emit(root, "rename", ".git");
    fake.emit(root, "change", Buffer.from(".git/HEAD"));
    fake.emit(root, "change", "../outside.txt");
    await vi.advanceTimersByTimeAsync(400);
    expect(emit).not.toHaveBeenCalled();
    expect(fake.handles).toEqual(handles);
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
