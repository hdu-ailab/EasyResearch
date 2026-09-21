import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { checkAbort, ensure, MEMORY_LIMITS, MemoryError, safeError } from "./policy.js";

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameFile(a: Stats, b: Stats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export interface DirectoryGuard {
  readonly path: string;
  assert(): Promise<void>;
}

/** Only the supplied root may be a symlink. Every child is identity checked. */
export async function directoryAnchor(root: string, parts: string[], create: boolean, signal?: AbortSignal): Promise<DirectoryGuard | undefined> {
  try {
    checkAbort(signal);
    ensure(isAbsolute(root) && parts.every(part => /^[^/\\\0:]+$/.test(part) && part !== "." && part !== ".."), "UNSAFE_PATH", "Invalid memory directory boundary.");
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    let physical: string;
    try { physical = await realpath(root); } catch (error) {
      if (hasCode(error, "ENOENT") && !create) return undefined;
      throw error;
    }
    const anchors: { path: string; stat: Stats }[] = [];
    const rootStat = await lstat(physical);
    ensure(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "UNSAFE_PATH", "Memory root must be a directory.");
    anchors.push({ path: physical, stat: rootStat });
    const assert = async () => {
      // Identity validation also serves cleanup, which must survive cancellation.
      ensure(await realpath(root) === physical, "UNSAFE_PATH", "Memory directory identity changed.");
      for (const anchor of anchors) {
        const current = await lstat(anchor.path);
        ensure(current.isDirectory() && !current.isSymbolicLink() && sameIdentity(current, anchor.stat), "UNSAFE_PATH", "Memory directory identity changed or was redirected.");
      }
    };
    let path = physical;
    for (const part of parts) {
      checkAbort(signal);
      await assert();
      path = join(path, part);
      if (create) {
        try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
      }
      let stat: Stats;
      try { stat = await lstat(path); } catch (error) {
        if (hasCode(error, "ENOENT") && !create) return undefined;
        throw error;
      }
      ensure(stat.isDirectory() && !stat.isSymbolicLink(), "UNSAFE_PATH", "Memory directory was redirected or is not a directory.");
      anchors.push({ path, stat });
    }
    await assert();
    checkAbort(signal);
    return { path, assert: async () => { try { await assert(); } catch (error) { throw safeError(error); } } };
  } catch (error) { throw safeError(error); }
}

export function memoryDirectory(agentDir: string, parts: string[], create: boolean, signal?: AbortSignal): Promise<DirectoryGuard | undefined> {
  return directoryAnchor(agentDir, ["research-memory", ...parts], create, signal);
}

export interface ReadBudget { bytes: number; entries: number }
export function readBudget(): ReadBudget { return { bytes: MEMORY_LIMITS.scanBytes, entries: MEMORY_LIMITS.scanEntries }; }

/** opendir avoids allocating an unbounded readdir result before applying limits. */
export async function listNames(directory: DirectoryGuard, max: number, budget: ReadBudget, signal?: AbortSignal): Promise<string[]> {
  try {
    await directory.assert();
    const names: string[] = [];
    const dir = await opendir(directory.path);
    for await (const item of dir) {
      checkAbort(signal);
      ensure(--budget.entries >= 0 && names.length < max, "LIMIT", "Memory directory scan exceeds its bound.");
      names.push(item.name);
    }
    await directory.assert();
    return names.sort();
  } catch (error) { throw safeError(error); }
}

export async function readBoundedFile(directory: DirectoryGuard, name: string, max: number, signal?: AbortSignal, singleLink = false): Promise<Buffer> {
  try {
    checkAbort(signal);
    ensure(!/[\\/\0]/.test(name) && name !== "." && name !== "..", "UNSAFE_PATH", "Invalid memory file boundary.");
    await directory.assert();
    const path = join(directory.path, name);
    const initial = await lstat(path);
    ensure(initial.isFile() && !initial.isSymbolicLink() && (!singleLink || initial.nlink === 1), "UNSAFE_PATH", "Evidence and revisions must be eligible regular files.");
    ensure(initial.size <= max, "LIMIT", "Memory file exceeds its byte limit.");
    // NONBLOCK also prevents a raced replacement with a FIFO from hanging open().
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const before = await handle.stat();
      ensure(before.isFile() && sameFile(initial, before) && (!singleLink || before.nlink === 1), "UNSAFE_PATH", "Memory file identity changed.");
      checkAbort(signal);
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        checkAbort(signal);
        const chunk = Buffer.allocUnsafe(Math.min(65_536, max - total + 1));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        ensure(total <= max, "LIMIT", "Memory file exceeds its byte limit.");
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      const current = await lstat(path);
      ensure(after.isFile() && current.isFile() && !current.isSymbolicLink() && sameFile(before, after) && sameFile(after, current) && total === after.size && (!singleLink || after.nlink === 1), "EVIDENCE", "Memory file changed while reading; retry with stable evidence.");
      await directory.assert();
      checkAbort(signal);
      return Buffer.concat(chunks, total);
    } finally { await handle.close(); }
  } catch (error) {
    if (hasCode(error, "ENOENT")) throw new MemoryError("NOT_FOUND", "Memory or evidence file was not found in this scope.");
    throw safeError(error);
  }
}

/** The link is the linearization point. Nothing ever rewrites a published name. */
export async function publishRevision(directory: DirectoryGuard, revision: number, serialized: string, signal?: AbortSignal): Promise<void> {
  let draft: string | undefined;
  let owned: Stats | undefined;
  try {
    checkAbort(signal);
    ensure(Number.isSafeInteger(revision) && revision > 0 && revision <= MEMORY_LIMITS.revisions, "LIMIT", "Memory history exceeds its revision bound.");
    ensure(Buffer.byteLength(serialized) <= MEMORY_LIMITS.recordBytes, "LIMIT", "Memory snapshot exceeds its byte limit.");
    await directory.assert();
    const draftPath = join(directory.path, `.draft-${randomUUID()}`);
    const handle = await open(draftPath, "wx", 0o600);
    draft = draftPath;
    try {
      owned = await handle.stat();
      await directory.assert();
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await directory.assert();
    const current = await lstat(draftPath);
    ensure(owned && current.isFile() && !current.isSymbolicLink() && sameIdentity(current, owned), "UNSAFE_PATH", "Memory draft identity changed.");
    checkAbort(signal);
    try { await link(draftPath, join(directory.path, `${revision}.json`)); } catch (error) {
      if (hasCode(error, "EEXIST")) throw new MemoryError("CONFLICT", "Memory revision conflict; get the current revision and retry.");
      throw error;
    }
    // Cancellation after the link does not turn a committed mutation into failure.
  } catch (error) { throw safeError(error); }
  finally {
    if (draft && owned) {
      try {
        // Never traverse a redirected directory or remove a foreign draft. Cleanup
        // is best effort: a crash/abort may leave an inert uniquely named draft.
        await directory.assert();
        const current = await lstat(draft);
        if (current.isFile() && !current.isSymbolicLink() && sameIdentity(current, owned)) await unlink(draft);
      } catch { /* An inert draft cannot become a revision. */ }
    }
  }
}
