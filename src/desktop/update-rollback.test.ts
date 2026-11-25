import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureDesktopRollbackDirectories } from "./update-rollback";
import { runUpdateCustody } from "./update-worker";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-rollback-"))); roots.push(root);
  const parent = join(root, "安装目录 with spaces"); await mkdir(parent);
  const original = join(parent, "EasyResearch"), backup = `${original}.update-backup`, quarantine = `${original}.update-failed`;
  for (const path of [original, backup, quarantine]) await mkdir(path);
  await writeFile(join(original, "app"), "failed candidate");
  await writeFile(join(backup, "app"), "accepted backup");
  return { root, parent, original, backup, quarantine, displaced: join(quarantine, "installation") };
}
const denied = (code = "EPERM") => Object.assign(new Error("held Windows directory"), { code });
function clock() {
  let time = 0;
  return { now: () => time, wait: vi.fn(async (ms: number) => { time += ms; }), elapsed: () => time };
}

it("retries transient Windows locks on both real directory moves and restores the exact backup", async () => {
  const f = await fixture(), timing = clock();
  const calls = new Map<string, number>();
  const move = vi.fn(async (from: string, to: string) => {
    const count = (calls.get(from) ?? 0) + 1; calls.set(from, count);
    if (count <= 2) throw denied(count === 1 ? "EPERM" : "EBUSY");
    await rename(from, to);
  });
  const moves = await captureDesktopRollbackDirectories(f.original, f.backup, f.quarantine, { platform: "win32", rename: move, ...timing });
  await moves.quarantineCurrent(); await moves.restoreBackup();
  expect(calls.get(f.original)).toBe(3); expect(calls.get(f.backup)).toBe(3);
  expect(await readFile(join(f.original, "app"), "utf8")).toBe("accepted backup");
  expect(await readFile(join(f.displaced, "app"), "utf8")).toBe("failed candidate");
  await expect(lstat(f.backup)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["quarantine", "restore"])("bounds persistent %s denial and retains recovery bytes", async phase => {
  const f = await fixture(), timing = clock(), error = denied();
  const move = vi.fn(async (from: string, to: string) => {
    if (phase === "quarantine" || from === f.backup) throw error;
    await rename(from, to);
  });
  const moves = await captureDesktopRollbackDirectories(f.original, f.backup, f.quarantine, { platform: "win32", rename: move, ...timing });
  if (phase === "restore") await moves.quarantineCurrent();
  await expect(phase === "restore" ? moves.restoreBackup() : moves.quarantineCurrent()).rejects.toBe(error);
  expect(timing.elapsed()).toBe(2000);
  expect(move.mock.calls.filter(([from]) => from === (phase === "restore" ? f.backup : f.original)).length).toBeLessThanOrEqual(21);
  expect(await readFile(join(f.backup, "app"), "utf8")).toBe("accepted backup");
  expect(await readFile(join(phase === "restore" ? f.displaced : f.original, "app"), "utf8")).toBe("failed candidate");
});

it.each([["linux", "EPERM"], ["darwin", "EBUSY"], ["win32", "EACCES"], ["win32", "ENOENT"], ["win32", "EIO"]] as const)(
  "does not retry %s %s or reinterpret a disappeared captured source", async (platform, code) => {
    const f = await fixture(), timing = clock(), error = denied(code), move = vi.fn(async () => { throw error; });
    const moves = await captureDesktopRollbackDirectories(f.original, f.backup, f.quarantine, { platform, rename: move, ...timing });
    await expect(moves.quarantineCurrent()).rejects.toBe(error);
    expect(move).toHaveBeenCalledOnce(); expect(timing.wait).not.toHaveBeenCalled();
  });

it("permits a source absent at capture, but requires its continued absence before restoring", async () => {
  const f = await fixture(); await rm(f.original, { recursive: true });
  const moves = await captureDesktopRollbackDirectories(f.original, f.backup, f.quarantine);
  await moves.quarantineCurrent(); await moves.restoreBackup();
  expect(await readFile(join(f.original, "app"), "utf8")).toBe("accepted backup");
  await expect(lstat(f.displaced)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not overwrite an installation that appears after capturing initial absence", async () => {
  const f = await fixture(); await rm(f.original, { recursive: true });
  const move = vi.fn(rename);
  const moves = await captureDesktopRollbackDirectories(f.original, f.backup, f.quarantine, { rename: move });
  await moves.quarantineCurrent();
  await mkdir(f.original); await writeFile(join(f.original, "app"), "foreign installation");
  await expect(moves.restoreBackup()).rejects.toThrow(/occupied/);
  expect(move).not.toHaveBeenCalled();
  expect(await readFile(join(f.original, "app"), "utf8")).toBe("foreign installation");
  expect(await readFile(join(f.backup, "app"), "utf8")).toBe("accepted backup");
});

it.each(["quarantine", "restore"])("retains the failed custody outcome and backup after persistent %s denial", async phase => {
  const f = await fixture(), timing = clock(), error = denied();
  const report = vi.fn(async () => {}), recover = vi.fn(async () => {}), startSuccessor = vi.fn(async () => {});
  await expect(runUpdateCustody({
    prepare: async () => {}, awaitCommit: async () => true, waitForHostExit: async () => {},
    install: async admitted => { admitted(); }, verify: async () => { throw new Error("installed version mismatch"); },
    rollback: async () => {
      const moves = await captureDesktopRollbackDirectories(f.original, f.backup, f.quarantine, { platform: "win32", ...timing,
        rename: async (from, to) => { if (phase === "quarantine" || from === f.backup) throw error; await rename(from, to); },
      });
      await moves.quarantineCurrent(); await moves.restoreBackup();
    },
    recover, startSuccessor, report, release: async () => {},
  })).rejects.toBe(error);
  expect(report).toHaveBeenLastCalledWith("failed", expect.objectContaining({
    installerAdmitted: true, hostExited: true, rollback: "pending", recoveryComplete: false,
  }));
  expect(recover).not.toHaveBeenCalled(); expect(startSuccessor).not.toHaveBeenCalled();
  expect(await readFile(join(f.backup, "app"), "utf8")).toBe("accepted backup");
});

it.each(["source", "backup", "quarantine", "parent", "destination", "vanished-source", "appeared-source"] as const)(
  "refuses %s changes before the first quarantine attempt", async change => {
    const f = await fixture();
    if (change === "appeared-source") await rm(f.original, { recursive: true });
    const move = vi.fn(rename);
    const moves = await captureDesktopRollbackDirectories(f.original, f.backup, f.quarantine, { rename: move });
    if (change === "destination") await mkdir(f.displaced);
    else if (change === "appeared-source") await mkdir(f.original);
    else {
      const path = change === "parent" ? f.parent : change === "backup" ? f.backup : change === "quarantine" ? f.quarantine : f.original;
      await rename(path, `${path}.preserved`);
      if (change !== "vanished-source") await mkdir(path);
    }
    await expect(moves.quarantineCurrent()).rejects.toThrow();
    expect(move).not.toHaveBeenCalled();
  });

it.each(["source", "backup", "quarantine", "parent", "destination"] as const)(
  "revalidates %s after a denied quarantine move, without adopting replacements", async change => {
    const f = await fixture(), timing = clock(), move = vi.fn(async () => { throw denied(); });
    const moves = await captureDesktopRollbackDirectories(f.original, f.backup, f.quarantine, { platform: "win32", rename: move, now: timing.now,
      wait: async ms => {
        await timing.wait(ms);
        if (change === "destination") { await mkdir(f.displaced); return; }
        const path = change === "parent" ? f.parent : change === "backup" ? f.backup : change === "quarantine" ? f.quarantine : f.original;
        await rename(path, `${path}.preserved`); await mkdir(path);
      },
    });
    await expect(moves.quarantineCurrent()).rejects.toThrow();
    expect(move).toHaveBeenCalledOnce();
  });

it.each(["source", "backup", "quarantine", "parent", "destination"] as const)(
  "revalidates %s before restoration and on a restoration retry", async change => {
    for (const duringRetry of [false, true]) {
      const f = await fixture(), timing = clock();
      const replace = async () => {
        if (change === "destination") { await mkdir(f.original); return; }
        const path = change === "parent" ? f.parent : change === "backup" ? f.backup : change === "quarantine" ? f.quarantine : f.displaced;
        await rename(path, `${path}.preserved`); await mkdir(path);
      };
      const move = vi.fn(async (from: string, to: string) => { if (from === f.backup) throw denied(); await rename(from, to); });
      const moves = await captureDesktopRollbackDirectories(f.original, f.backup, f.quarantine, { platform: "win32", rename: move, now: timing.now,
        wait: async ms => { await timing.wait(ms); await replace(); },
      });
      await moves.quarantineCurrent();
      if (!duringRetry) await replace();
      await expect(moves.restoreBackup()).rejects.toThrow();
      expect(move.mock.calls.filter(([from]) => from === f.backup)).toHaveLength(duringRetry ? 1 : 0);
    }
  });

it("does not issue another rename after revalidation consumes the remaining retry deadline", async () => {
  const f = await fixture(), error = denied(); let time = 0;
  const move = vi.fn(async () => { throw error; });
  const moves = await captureDesktopRollbackDirectories(f.original, f.backup, f.quarantine, { platform: "win32", rename: move,
    now: () => time, wait: async () => { time = 2001; },
  });
  await expect(moves.quarantineCurrent()).rejects.toBe(error); expect(move).toHaveBeenCalledOnce();
});

it.each(["source", "backup", "quarantine", "parent", "destination"] as const)("rejects a linked %s without touching its target", async change => {
  const f = await fixture(), foreign = join(f.root, "foreign"); await mkdir(foreign); await writeFile(join(foreign, "keep"), "user work");
  const move = vi.fn(rename);
  const moves = await captureDesktopRollbackDirectories(f.original, f.backup, f.quarantine, { rename: move });
  const path = change === "parent" ? f.parent : change === "backup" ? f.backup : change === "quarantine" ? f.quarantine : change === "destination" ? f.displaced : f.original;
  if (change !== "destination") await rename(path, `${path}.preserved`);
  await symlink(foreign, path, process.platform === "win32" ? "junction" : "dir");
  await expect(moves.quarantineCurrent()).rejects.toThrow();
  expect(move).not.toHaveBeenCalled(); expect(await readFile(join(foreign, "keep"), "utf8")).toBe("user work");
});

it("refuses an occupied quarantine destination even when it is an empty regular file", async () => {
  const f = await fixture(), move = vi.fn(rename);
  const moves = await captureDesktopRollbackDirectories(f.original, f.backup, f.quarantine, { rename: move });
  await writeFile(f.displaced, "");
  await expect(moves.quarantineCurrent()).rejects.toThrow(/occupied/);
  expect(move).not.toHaveBeenCalled(); expect((await lstat(f.displaced)).isFile()).toBe(true);
});
