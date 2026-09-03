import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ServerOwner } from "./server-process";

export interface RuntimeLeaseRecord {
  schema: 1;
  kind: "transition" | "server";
  owner: ServerOwner;
  pid: number;
  token: string;
}

export interface RuntimeLease {
  readonly path: string;
  readonly token: string;
  readonly held: boolean;
  reserveHandoff(token: string): RuntimeLeaseHandoff;
  release(): boolean;
}

export interface RuntimeLeaseHandoff {
  readonly token: string;
  readonly transferred: boolean;
  commit(pid: number): void;
  cancel(): boolean;
  relinquish(): void;
}

export type RuntimeLeaseTokenState = "held" | "released" | "unverifiable";

interface RuntimeLeaseOptions {
  isAlive?: (pid: number) => boolean;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

type LeaseSnapshot =
  | { kind: "missing" }
  | { kind: "empty-directory" }
  | { kind: "invalid" }
  | { kind: "legacy-file"; record: RuntimeLeaseRecord }
  | { kind: "directory"; record: RuntimeLeaseRecord };

export function transitionLeasePath(agentDir: string): string {
  return join(agentDir, "server.transition.lease");
}

export function serverLeasePath(agentDir: string): string {
  return join(agentDir, "server.lease");
}

export function acquireTransitionLease(
  agentDir: string,
  owner: ServerOwner,
  options: RuntimeLeaseOptions = {},
): Promise<RuntimeLease> {
  return acquireRuntimeLease(
    transitionLeasePath(agentDir),
    { schema: 1, kind: "transition", owner, pid: process.pid, token: randomUUID() },
    options,
  );
}

export function acquireServerLease(
  agentDir: string,
  owner: ServerOwner,
  token: string,
  options: RuntimeLeaseOptions = {},
): Promise<RuntimeLease> {
  if (!token) throw new Error("EasyResearch server lease requires a non-empty ownership token.");
  return acquireRuntimeLease(
    serverLeasePath(agentDir),
    { schema: 1, kind: "server", owner, pid: process.pid, token },
    options,
  );
}

async function acquireRuntimeLease(
  path: string,
  desired: RuntimeLeaseRecord,
  options: RuntimeLeaseOptions,
): Promise<RuntimeLease> {
  mkdirSync(dirname(path), { recursive: true });
  const isAlive = options.isAlive ?? isProcessAlive;
  const wait = options.wait ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? (desired.kind === "transition" ? 10_000 : 0);
  const deadline = now() + timeoutMs;

  while (true) {
    if (tryPublishLeaseDirectory(path, desired)) return createLeaseHandle(path, desired);

    const current = readLease(path);
    if (current.kind === "missing") continue;
    if (current.kind === "empty-directory") {
      removeEmptyDirectory(path);
      continue;
    }
    if (current.kind === "invalid") throw unverifiableLeaseError(path, desired.kind);
    if (current.record.kind !== desired.kind) throw unverifiableLeaseError(path, desired.kind);
    if (current.kind === "legacy-file" && !isAlive(current.record.pid)) {
      throw unverifiableLeaseError(path, desired.kind);
    }
    if (current.kind === "directory" && !isAlive(current.record.pid)) {
      removeDirectoryLease(path, current.record.token);
      continue;
    }
    await rejectOrWaitForLiveLease(current.record, desired, path, deadline, now, wait, options);
  }
}

async function rejectOrWaitForLiveLease(
  current: RuntimeLeaseRecord,
  desired: RuntimeLeaseRecord,
  _path: string,
  deadline: number,
  now: () => number,
  wait: (milliseconds: number) => Promise<void>,
  options: RuntimeLeaseOptions,
): Promise<void> {
  if (desired.kind === "server") {
    throw new Error(
      `Cannot acquire live EasyResearch server lease owned by ${current.owner} process ${current.pid}.`,
    );
  }
  if (now() >= deadline) {
    throw new Error(
      `Another EasyResearch runtime transition is still active in process ${current.pid}.`,
    );
  }
  await wait(options.pollIntervalMs ?? 100);
}

function tryPublishLeaseDirectory(path: string, record: RuntimeLeaseRecord): boolean {
  const staging = `${path}.tmp-${process.pid}-${randomUUID()}`;
  mkdirSync(staging, { mode: 0o700 });
  try {
    writeLeaseRecord(join(staging, leaseRecordName(record.token)), record);
    try {
      // A complete non-empty directory appears in one rename; a live directory
      // is never moved aside or replaced.
      renameSync(staging, path);
      return true;
    } catch (error) {
      if (pathExists(path)) return false;
      throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function createLeaseHandle(path: string, record: RuntimeLeaseRecord): RuntimeLease {
  let held = true;
  let currentRecord = record;
  let activeHandoff: { token: string; guardPath: string } | undefined;
  return {
    path,
    get token() {
      return currentRecord.token;
    },
    get held() {
      return held;
    },
    reserveHandoff(token: string) {
      if (!held) throw new Error("EasyResearch runtime lease ownership was already released.");
      if (currentRecord.kind !== "transition") {
        throw new Error("Only an EasyResearch transition lease can reserve a child handoff.");
      }
      if (!token || token === currentRecord.token) {
        throw new Error("EasyResearch transition handoff requires a fresh child token.");
      }
      if (activeHandoff) {
        throw new Error("EasyResearch transition handoff was already reserved.");
      }
      const guardPath = join(path, `.handoff-${process.pid}-${randomUUID()}`);
      writeExclusiveFile(guardPath, "handoff\n");
      const parentRecord = currentRecord;
      const parentRecordPath = join(path, leaseRecordName(parentRecord.token));
      const current = readLeaseRecord(parentRecordPath);
      if (!sameLeaseRecord(current, parentRecord)) {
        unlinkIfPresent(guardPath);
        throw new Error("EasyResearch lost transition ownership before child handoff.");
      }
      activeHandoff = { token, guardPath };
      let state: "reserved" | "transferred" | "cancelled" | "relinquished" = "reserved";
      let childPid: number | undefined;
      return {
        token,
        get transferred() {
          return state === "transferred" || state === "relinquished";
        },
        commit(pid: number) {
          if (state === "cancelled") {
            throw new Error("EasyResearch transition handoff was already cancelled.");
          }
          if (state === "relinquished") {
            if (pid === childPid) return;
            throw new Error("EasyResearch transition handoff was already relinquished.");
          }
          if (!Number.isSafeInteger(pid) || pid <= 0) {
            throw new Error("EasyResearch transition handoff requires a live child pid.");
          }
          if (state === "transferred") {
            if (pid === childPid) return;
            throw new Error("EasyResearch transition handoff already names another child.");
          }

          const successor: RuntimeLeaseRecord = { ...parentRecord, pid, token };
          const childRecordPath = join(path, leaseRecordName(token));
          const existingChild = readLeaseRecord(childRecordPath);
          if (existingChild && !sameLeaseRecord(existingChild, successor)) {
            throw new Error("EasyResearch found conflicting child transition ownership.");
          }
          if (!existingChild) writeLeaseRecord(childRecordPath, successor);

          const existingParent = readLeaseRecord(parentRecordPath);
          if (existingParent) {
            if (!sameLeaseRecord(existingParent, parentRecord)) {
              throw new Error("EasyResearch lost parent transition ownership during child handoff.");
            }
            unlinkSync(parentRecordPath);
          }

          // Every interrupted step before this point leaves the handoff guard
          // beside at least one ownership record, so acquisition fails closed.
          unlinkSync(guardPath);
          currentRecord = successor;
          activeHandoff = undefined;
          childPid = pid;
          state = "transferred";
        },
        cancel() {
          if (state !== "reserved") return false;
          const childRecordPath = join(path, leaseRecordName(token));
          const existingParent = readLeaseRecord(parentRecordPath);
          if (existingParent && !sameLeaseRecord(existingParent, parentRecord)) {
            throw new Error("EasyResearch lost parent transition ownership during handoff cancellation.");
          }
          if (!existingParent) writeLeaseRecord(parentRecordPath, parentRecord);

          const existingChild = readLeaseRecord(childRecordPath);
          if (existingChild) {
            if (existingChild.token !== token) {
              throw new Error("EasyResearch found conflicting child transition ownership.");
            }
            unlinkSync(childRecordPath);
          }
          unlinkIfPresent(guardPath);
          activeHandoff = undefined;
          state = "cancelled";
          return true;
        },
        relinquish() {
          if (state === "relinquished") return;
          if (state !== "transferred") {
            throw new Error("EasyResearch cannot relinquish an incomplete transition handoff.");
          }
          held = false;
          state = "relinquished";
        },
      };
    },
    release() {
      if (!held || activeHandoff) return false;
      const removed = removeDirectoryLease(path, currentRecord.token);
      if (removed) held = false;
      return removed;
    },
  };
}

export function serverLeaseTokenState(
  agentDir: string,
  expectedToken: string,
): RuntimeLeaseTokenState {
  const current = readLease(serverLeasePath(agentDir));
  if (current.kind === "missing" || current.kind === "empty-directory") return "released";
  if (current.kind === "invalid" || current.record.kind !== "server") return "unverifiable";
  return current.record.token === expectedToken ? "held" : "released";
}

function removeDirectoryLease(path: string, expectedToken: string): boolean {
  const recordPath = join(path, leaseRecordName(expectedToken));
  const current = readLeaseRecord(recordPath);
  if (!current || current.token !== expectedToken) return false;
  try {
    unlinkSync(recordPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  removeEmptyDirectory(path);
  return true;
}

function removeEmptyDirectory(path: string): boolean {
  try {
    rmdirSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    if (code === "EPERM" || code === "EACCES") {
      try {
        if (readdirSync(path).length > 0) return false;
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") return true;
      }
    }
    throw error;
  }
}

function readLease(path: string): LeaseSnapshot {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "invalid" };
  }
  if (stat.isFile()) {
    const record = readLeaseRecord(path);
    return record ? { kind: "legacy-file", record } : { kind: "invalid" };
  }
  if (!stat.isDirectory()) return { kind: "invalid" };

  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return { kind: "invalid" };
  }
  if (entries.length === 0) return { kind: "empty-directory" };
  if (entries.length !== 1 || !entries[0]?.startsWith("owner-")) return { kind: "invalid" };
  const recordPath = join(path, entries[0]);
  const record = readLeaseRecord(recordPath);
  if (!record || entries[0] !== leaseRecordName(record.token)) return { kind: "invalid" };
  return { kind: "directory", record };
}

function readLeaseRecord(path: string): RuntimeLeaseRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Partial<RuntimeLeaseRecord>;
  if (
    record.schema !== 1
    || (record.kind !== "transition" && record.kind !== "server")
    || (record.owner !== "cli" && record.owner !== "desktop")
    || !Number.isSafeInteger(record.pid)
    || (record.pid ?? 0) <= 0
    || typeof record.token !== "string"
    || record.token.length === 0
  ) {
    return undefined;
  }
  return record as RuntimeLeaseRecord;
}

function sameLeaseRecord(
  left: RuntimeLeaseRecord | undefined,
  right: RuntimeLeaseRecord,
): boolean {
  return left?.schema === right.schema
    && left.kind === right.kind
    && left.owner === right.owner
    && left.pid === right.pid
    && left.token === right.token;
}

function writeLeaseRecord(path: string, record: RuntimeLeaseRecord): void {
  writeExclusiveFile(path, `${JSON.stringify(record)}\n`);
}

function writeExclusiveFile(path: string, content: string): void {
  let fd: number;
  fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
}

function leaseRecordName(token: string): string {
  return `owner-${createHash("sha256").update(token).digest("hex")}.json`;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function unverifiableLeaseError(path: string, kind: RuntimeLeaseRecord["kind"]): Error {
  return new Error(
    `Cannot verify EasyResearch ${kind} lease at ${path}. Remove it manually only after confirming no EasyResearch process is running.`,
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
