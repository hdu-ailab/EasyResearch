import { EventEmitter } from "node:events";
import { watch as nativeWatch, type FSWatcher as NativeWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { watch, type ChokidarOptions, type FSWatcher } from "chokidar";

const EVENTS = ["add", "change", "unlink", "addDir", "unlinkDir"] as const;

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function identity(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Parent handles observe names only. Chokidar never receives a project/HOME scan root. */
export function watchConfigurationResources(
  initialAnchors: readonly string[],
  options: ChokidarOptions,
  resourceRoots: readonly string[],
) {
  const events = new EventEmitter();
  const roots = [...new Set(resourceRoots.map((path) => resolve(path)))];
  const anchors = new Set(initialAnchors.map((path) => resolve(path)));
  const targets = new Set([...anchors, ...roots]);
  const parents = new Map<string, { watcher: NativeWatcher; identity: string }>();
  const children = new Map<string, { watcher: FSWatcher; identity: string }>();
  const retired = new Set<FSWatcher>();
  const dependencies = new Set<string>();
  const cancelReady = new Set<() => void>();
  let closed = false;
  let work = Promise.resolve();
  let closing: Promise<void> | undefined;

  const enqueue = (operation: () => Promise<void>) => {
    work = work.then(async () => {
      if (!closed) await operation();
    }).catch((error) => {
      if (!closed) events.emit("error", error);
    });
  };

  const retire = async (root: string) => {
    const child = children.get(root);
    if (!child) return;
    children.delete(root);
    retired.add(child.watcher);
    await child.watcher.close();
    retired.delete(child.watcher);
  };

  const reconcile = async (): Promise<void> => {
    for (const watcher of retired) {
      await watcher.close();
      retired.delete(watcher);
    }
    // Watch only parents of known roots/aliases. No directory listing is needed,
    // and filename-less native events only recheck this same finite set.
    const parentPaths = new Set([...targets].map(dirname));
    for (const parent of parentPaths) {
      const current = await identity(parent);
      if (closed) return;
      const previous = parents.get(parent);
      if (previous?.identity === current) continue;
      if (previous) {
        previous.watcher.close();
        parents.delete(parent);
      }
      if (!current) continue;
      const watcher = nativeWatch(parent, { recursive: false }, (_event, filename) => {
        if (closed || parents.get(parent)?.watcher !== watcher) return;
        const name = filename === null ? undefined : filename.toString();
        if (name !== undefined && name !== basename(name)) return;
        const candidates = [...targets].filter((target) => dirname(target) === parent
          && (name === undefined || basename(target) === name));
        if (candidates.length === 0) return;
        enqueue(async () => {
          await reconcile();
          for (const target of candidates) {
            const exists = await identity(target);
            if (closed) return;
            events.emit(exists ? "addDir" : "unlinkDir", target);
          }
        });
      });
      parents.set(parent, { watcher, identity: current });
      watcher.on("error", (error) => {
        if (!closed && parents.get(parent)?.watcher === watcher) events.emit("error", error);
      });
    }

    for (const root of roots) {
      const current = await identity(root);
      if (closed) return;
      if (children.get(root)?.identity === current) continue;
      await retire(root);
      if (!current || closed) continue;
      const ignored = options.ignored;
      const watcher = watch(root, {
        ...options,
        // Chokidar may try to watch a missing root's parent. Reject that fallback
        // before it can enumerate unrelated mounts; native handles own recovery.
        ignored: (path, stat) => !within(root, resolve(path))
          || (typeof ignored === "function" && ignored(path, stat)),
      });
      children.set(root, { watcher, identity: current });
      const active = () => !closed && children.get(root)?.watcher === watcher;
      for (const event of EVENTS) watcher.on(event, (path) => {
        if (active()) events.emit(event, path);
      });
      await new Promise<void>((ready, reject) => {
        let settled = false;
        const cancel = () => { settled = true; cancelReady.delete(cancel); ready(); };
        cancelReady.add(cancel);
        watcher.once("ready", cancel);
        watcher.on("error", (error) => {
          cancelReady.delete(cancel);
          if (!settled) {
            settled = true;
            reject(error);
          } else if (active()) events.emit("error", error);
        });
        for (const path of dependencies) if (within(root, path)) watcher.add(path);
      });
    }
  };

  const result = {
    on(event: string, listener: (...args: unknown[]) => void) {
      events.on(event, listener);
      return result;
    },
    add(paths: string | readonly string[]) {
      const additions = (typeof paths === "string" ? [paths] : paths).map((path) => resolve(path));
      enqueue(async () => {
        for (const path of additions) {
          if (roots.some((root) => within(root, path))) {
            dependencies.add(path);
            for (const [root, child] of children) if (within(root, path)) child.watcher.add(path);
          } else {
            // The manager's staged exact-cwd alias confirmation is metadata-only.
            anchors.add(path);
            targets.add(path);
            await reconcile();
            const exists = await identity(path);
            if (!closed) events.emit(exists ? "add" : "unlink", path);
          }
        }
      });
      return result;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      for (const cancel of cancelReady) cancel();
      const attempt = (async () => {
        await work;
        const failures: unknown[] = [];
        for (const [path, parent] of parents) {
          try {
            parent.watcher.close();
            parents.delete(path);
          } catch (error) { failures.push(error); }
        }
        for (const [path, child] of children) {
          retired.add(child.watcher);
          children.delete(path);
        }
        for (const watcher of retired) {
          try {
            await watcher.close();
            retired.delete(watcher);
          } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, "Configuration watcher cleanup failed.");
      })();
      closing = attempt;
      void attempt.catch(() => { if (closing === attempt) closing = undefined; });
      return attempt;
    },
  };
  enqueue(async () => {
    await reconcile();
    if (!closed) events.emit("ready");
  });
  return result;
}
