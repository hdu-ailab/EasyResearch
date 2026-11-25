import type { BigIntStats } from "node:fs";
import { lstat, realpath, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Only the two owned rollback moves. The caller retains transition custody. */
export async function captureDesktopRollbackDirectories(original: string, backup: string, quarantine: string, io: {
  rename?: (from: string, to: string) => Promise<void>;
  platform?: NodeJS.Platform;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
} = {}) {
  const platform = io.platform ?? process.platform;
  const samePath = (a: string, b: string) => platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const parent = dirname(original), displaced = join(quarantine, "installation");
  if (![original, backup, quarantine].every(path => isAbsolute(path) && samePath(resolve(path), path))
    || dirname(backup) !== parent || dirname(quarantine) !== parent
    || new Set([original, backup, quarantine].map(path => platform === "win32" ? path.toLowerCase() : path)).size !== 3) {
    throw new Error("Invalid Desktop rollback directories.");
  }
  const directory = async (path: string, stat?: BigIntStats): Promise<BigIntStats> => {
    stat ??= await lstat(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(path), path)) {
      throw new Error("Desktop rollback directory identity changed.");
    }
    return stat;
  };
  const parentIdentity = await directory(parent);
  const backupIdentity = await directory(backup);
  const quarantineIdentity = await directory(quarantine);
  let sourceIdentity: BigIntStats | undefined;
  try { sourceIdentity = await lstat(original, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (sourceIdentity) await directory(original, sourceIdentity);
  const unchanged = async (path: string, expected: BigIntStats) => {
    const current = await directory(path);
    if (current.dev !== expected.dev || current.ino !== expected.ino || current.birthtimeNs !== expected.birthtimeNs) {
      throw new Error("Desktop rollback directory identity changed.");
    }
  };
  const absent = async (path: string) => {
    try { await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    throw new Error("Desktop rollback destination is occupied.");
  };
  let quarantined = false, restored = false;
  const validate = async () => {
    await unchanged(parent, parentIdentity);
    await unchanged(quarantine, quarantineIdentity);
    await unchanged(backup, backupIdentity);
    if (sourceIdentity) await unchanged(quarantined ? displaced : original, sourceIdentity);
    else { await absent(original); await absent(displaced); }
    // An initially absent source is not interchangeable with a captured source
    // that disappears. Every destination must still be absent on every attempt.
    await absent(quarantined ? original : displaced);
  };
  const move = async (from: string, to: string) => {
    const now = io.now ?? (() => performance.now());
    const deadline = now() + 2000;
    let lastError: unknown;
    for (let attempt = 0; ; attempt++) {
      await validate();
      if (attempt > 0 && now() >= deadline) throw lastError;
      try { await (io.rename ?? rename)(from, to); return; }
      catch (error) {
        lastError = error;
        if (platform !== "win32" || !["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")
          || attempt >= 20 || now() >= deadline) throw error;
        await (io.wait ?? (milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds))))(Math.min(100, deadline - now()));
      }
    }
  };
  return {
    async quarantineCurrent(): Promise<void> {
      if (quarantined || restored) throw new Error("Desktop rollback move already completed.");
      if (sourceIdentity) await move(original, displaced);
      else await validate();
      quarantined = true;
    },
    async restoreBackup(): Promise<void> {
      if (!quarantined || restored) throw new Error("Invalid Desktop rollback move order.");
      await move(backup, original);
      restored = true;
    },
  };
}
