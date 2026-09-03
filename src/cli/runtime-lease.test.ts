import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireServerLease,
  acquireTransitionLease,
  serverLeasePath,
  transitionLeasePath,
} from "./runtime-lease";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-runtime-lease-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runtime leases", () => {
  it("atomically publishes a non-empty lease directory and releases only its token record", async () => {
    const first = await acquireServerLease(root, "cli", "token-a", {
      isAlive: () => true,
    });

    expect(statSync(serverLeasePath(root)).isDirectory()).toBe(true);
    expect(readdirSync(serverLeasePath(root))).toHaveLength(1);

    await expect(acquireServerLease(root, "desktop", "token-b", {
      isAlive: () => true,
      timeoutMs: 0,
    })).rejects.toThrow(/live EasyResearch server lease/i);

    expect(first.release()).toBe(true);
    expect(existsSync(serverLeasePath(root))).toBe(false);
  });

  it("recovers a directory lease only after proving its process is dead", async () => {
    const stale = await acquireServerLease(root, "cli", "dead-token");
    expect(statSync(serverLeasePath(root)).isDirectory()).toBe(true);
    if (!statSync(serverLeasePath(root)).isDirectory()) return;
    const [recordName] = readdirSync(serverLeasePath(root));
    if (!recordName) throw new Error("expected persisted lease record");
    writeFileSync(join(serverLeasePath(root), recordName), JSON.stringify({
      schema: 1,
      kind: "server",
      owner: "cli",
      pid: 4242,
      token: "dead-token",
    }));

    const lease = await acquireServerLease(root, "desktop", "new-token", {
      isAlive: (pid) => pid !== 4242,
    });

    expect(readOnlyLeaseRecord(serverLeasePath(root))).toMatchObject({
      owner: "desktop",
      pid: process.pid,
      token: "new-token",
    });
    expect(stale.release()).toBe(false);
    expect(lease.release()).toBe(true);
  });

  it("fails closed with manual recovery for a stale schema-1 file lease", async () => {
    const path = serverLeasePath(root);
    writeFileSync(path, JSON.stringify({
      schema: 1,
      kind: "server",
      owner: "cli",
      pid: 4242,
      token: "legacy-token",
    }));

    await expect(acquireServerLease(root, "desktop", "new-token", {
      isAlive: () => false,
    })).rejects.toThrow(/cannot verify.*remove it manually/is);

    expect(statSync(path).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ token: "legacy-token" });
  });

  it("keeps a live persisted schema-1 file lease fail-closed", async () => {
    const path = serverLeasePath(root);
    writeFileSync(path, JSON.stringify({
      schema: 1,
      kind: "server",
      owner: "cli",
      pid: 4242,
      token: "legacy-token",
    }));

    await expect(acquireServerLease(root, "desktop", "new-token", {
      isAlive: () => true,
    })).rejects.toThrow(/live EasyResearch server lease/i);

    expect(statSync(path).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ token: "legacy-token" });
  });

  it("never unlinks an old-format replacement that appears during its liveness check", async () => {
    const path = serverLeasePath(root);
    writeFileSync(path, JSON.stringify({
      schema: 1,
      kind: "server",
      owner: "cli",
      pid: 4242,
      token: "legacy-token",
    }));
    const replacement = {
      schema: 1,
      kind: "server",
      owner: "cli",
      pid: 4343,
      token: "old-replacement-token",
    } as const;
    let replaced = false;

    await expect(acquireServerLease(root, "desktop", "new-token", {
      isAlive: () => {
        if (!replaced) {
          unlinkSync(path);
          writeFileSync(path, JSON.stringify(replacement), { flag: "wx" });
          replaced = true;
        }
        return false;
      },
    })).rejects.toThrow(/cannot verify.*remove it manually/is);

    expect(replaced).toBe(true);
    expect(statSync(path).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(replacement);
  });

  it("safely recovers an empty lease directory when Windows rename cannot replace it", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const path = serverLeasePath(root);
    mkdirSync(path);
    vi.doMock("node:fs", () => ({
      ...actualFs,
      renameSync: ((oldPath, newPath) => {
        if (String(newPath) === path && actualFs.existsSync(path)) {
          throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
        }
        return actualFs.renameSync(oldPath, newPath);
      }) as typeof actualFs.renameSync,
    }));
    vi.resetModules();
    try {
      const runtimeLease = await import("./runtime-lease");

      const lease = await runtimeLease.acquireServerLease(root, "cli", "fresh-token");

      expect(readOnlyLeaseRecord(path)).toMatchObject({ token: "fresh-token" });
      expect(lease.release()).toBe(true);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("fails closed instead of recovering a wrong-kind lease directory", async () => {
    const stale = await acquireTransitionLease(root, "cli");
    const transitionPath = transitionLeasePath(root);
    const serverPath = serverLeasePath(root);
    renameDirectory(transitionPath, serverPath);

    await expect(acquireServerLease(root, "cli", "fresh-token", {
      isAlive: () => false,
    })).rejects.toThrow(/cannot verify|manually/i);

    expect(readOnlyLeaseRecord(serverPath)).toMatchObject({ kind: "transition" });
    expect(stale.release()).toBe(false);
  });

  it("does not let an older handle release a successor lease", async () => {
    const first = await acquireServerLease(root, "cli", "token-a");
    const path = serverLeasePath(root);
    expect(statSync(path).isDirectory()).toBe(true);
    if (!statSync(path).isDirectory()) return;
    const [recordName] = readdirSync(path);
    if (!recordName) throw new Error("expected persisted lease record");
    unlinkSync(join(path, recordName));
    rmdirSync(path);
    const second = await acquireServerLease(root, "desktop", "token-b");

    expect(first.release()).toBe(false);
    expect(readOnlyLeaseRecord(path)).toMatchObject({
      token: "token-b",
    });
    expect(second.release()).toBe(true);
  });

  it("never moves the canonical live lease out of its namespace during release", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const path = serverLeasePath(root);
    vi.doMock("node:fs", () => ({
      ...actualFs,
      renameSync: ((oldPath, newPath) => {
        if (String(oldPath) === path) {
          throw new Error("canonical lease was temporarily hidden");
        }
        return actualFs.renameSync(oldPath, newPath);
      }) as typeof actualFs.renameSync,
    }));
    vi.resetModules();
    try {
      const runtimeLease = await import("./runtime-lease");
      const lease = await runtimeLease.acquireServerLease(root, "cli", "token-a");

      expect(() => lease.release()).not.toThrow();
      expect(existsSync(path)).toBe(false);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("fails closed for a malformed unverifiable lease", async () => {
    writeFileSync(transitionLeasePath(root), "not-json");

    await expect(acquireTransitionLease(root, "cli", { timeoutMs: 0 }))
      .rejects.toThrow(/cannot verify/i);
    expect(readFileSync(transitionLeasePath(root), "utf8")).toBe("not-json");
  });

  it("waits for a live transition owner and acquires after release", async () => {
    const first = await acquireTransitionLease(root, "cli");
    let waits = 0;

    const second = acquireTransitionLease(root, "desktop", {
      isAlive: () => true,
      timeoutMs: 1_000,
      wait: async () => {
        waits += 1;
        first.release();
      },
    });

    await expect(second).resolves.toMatchObject({ token: expect.any(String) });
    expect(waits).toBe(1);
  });

  it("waits for a live schema-1 transition file and upgrades after its owner releases it", async () => {
    const path = transitionLeasePath(root);
    writeFileSync(path, JSON.stringify({
      schema: 1,
      kind: "transition",
      owner: "cli",
      pid: 4242,
      token: "legacy-token",
    }));
    let waits = 0;

    const lease = await acquireTransitionLease(root, "desktop", {
      isAlive: (pid) => pid === 4242,
      timeoutMs: 1_000,
      wait: async () => {
        waits += 1;
        unlinkSync(path);
      },
    });

    expect(waits).toBe(1);
    expect(statSync(path).isDirectory()).toBe(true);
    expect(readOnlyLeaseRecord(path)).toMatchObject({
      kind: "transition",
      owner: "desktop",
      pid: process.pid,
    });
    expect(lease.release()).toBe(true);
  });

  it("rejects live transition contention immediately when timeout is zero", async () => {
    const first = await acquireTransitionLease(root, "cli");
    let waits = 0;

    await expect(acquireTransitionLease(root, "cli", {
      isAlive: () => true,
      timeoutMs: 0,
      wait: async () => {
        waits += 1;
      },
    })).rejects.toThrow(/transition is still active/i);

    expect(waits).toBe(0);
    expect(first.release()).toBe(true);
  });

  it("reserves fail-closed handoff custody before publishing a child pid", async () => {
    const lease = await acquireTransitionLease(root, "cli");
    const transferable = lease as typeof lease & {
      reserveHandoff(token: string): {
        readonly transferred: boolean;
        commit(pid: number): void;
        cancel(): boolean;
        relinquish(): void;
      };
    };

    expect(typeof transferable.reserveHandoff).toBe("function");
    if (typeof transferable.reserveHandoff !== "function") return;
    const handoff = transferable.reserveHandoff("surviving-child-token");

    expect(transferable.held).toBe(true);
    await expect(acquireTransitionLease(root, "desktop", {
      isAlive: () => false,
      timeoutMs: 0,
    })).rejects.toThrow(/cannot verify|manually/i);

    handoff.commit(4242);
    expect(handoff.transferred).toBe(true);
    expect(transferable.held).toBe(true);
    expect(readOnlyLeaseRecord(transitionLeasePath(root))).toMatchObject({
      kind: "transition",
      owner: "cli",
      pid: 4242,
      token: "surviving-child-token",
    });
    await expect(acquireTransitionLease(root, "desktop", {
      isAlive: (pid) => pid === 4242,
      timeoutMs: 0,
    })).rejects.toThrow(/process 4242/i);
    expect(lease.release()).toBe(true);
  });

  it("can relinquish a committed handoff to a child that survives parent cleanup", async () => {
    const lease = await acquireTransitionLease(root, "cli");
    const transferable = lease as typeof lease & {
      reserveHandoff(token: string): {
        commit(pid: number): void;
        relinquish(): void;
      };
    };

    expect(typeof transferable.reserveHandoff).toBe("function");
    if (typeof transferable.reserveHandoff !== "function") return;
    const handoff = transferable.reserveHandoff("surviving-child-token");
    handoff.commit(4242);
    handoff.relinquish();

    expect(lease.held).toBe(false);
    expect(lease.release()).toBe(false);
    expect(readOnlyLeaseRecord(transitionLeasePath(root))).toMatchObject({
      pid: 4242,
      token: "surviving-child-token",
    });
  });

  it("keeps the parent lease releasable when pre-spawn handoff reservation fails", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.doMock("node:fs", () => ({
      ...actualFs,
      openSync: ((path, flags, mode) => {
        if (String(path).includes(".handoff-")) {
          throw Object.assign(new Error("handoff write denied"), { code: "EACCES" });
        }
        return actualFs.openSync(path, flags, mode);
      }) as typeof actualFs.openSync,
    }));
    vi.resetModules();
    try {
      const runtimeLease = await import("./runtime-lease");
      const lease = await runtimeLease.acquireTransitionLease(root, "cli");

      expect(() => lease.reserveHandoff("surviving-child-token"))
        .toThrow("handoff write denied");
      expect(lease.held).toBe(true);
      expect(lease.release()).toBe(true);
      expect(existsSync(runtimeLease.transitionLeasePath(root))).toBe(false);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});

function readOnlyLeaseRecord(path: string): Record<string, unknown> {
  const entries = readdirSync(path);
  expect(entries).toHaveLength(1);
  return JSON.parse(readFileSync(join(path, entries[0]!), "utf8")) as Record<string, unknown>;
}

function renameDirectory(oldPath: string, newPath: string): void {
  const [recordName] = readdirSync(oldPath);
  if (!recordName) throw new Error("expected persisted lease record");
  mkdirSync(newPath);
  const content = readFileSync(join(oldPath, recordName));
  writeFileSync(join(newPath, recordName), content);
  unlinkSync(join(oldPath, recordName));
  rmdirSync(oldPath);
}
