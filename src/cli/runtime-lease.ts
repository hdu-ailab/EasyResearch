import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
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
  release(): boolean;
}

interface RuntimeLeaseOptions {
  isAlive?: (pid: number) => boolean;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

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
  mkdirSync(join(path, ".."), { recursive: true });
  const isAlive = options.isAlive ?? isProcessAlive;
  const wait = options.wait ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? (desired.kind === "transition" ? 10_000 : 0);
  const deadline = now() + timeoutMs;

  while (true) {
    if (tryCreateLease(path, desired)) return createLeaseHandle(path, desired.token);

    const current = readLease(path);
    if (!current) {
      throw new Error(`Cannot verify EasyResearch ${desired.kind} lease at ${path}. Remove it manually only after confirming no EasyResearch process is running.`);
    }
    if (!isAlive(current.pid)) {
      removeLease(path, current.token);
      continue;
    }
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
}

function tryCreateLease(path: string, record: RuntimeLeaseRecord): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    try {
      unlinkSync(path);
    } catch {
      // The original write error is authoritative.
    }
    throw error;
  } finally {
    closeSync(fd);
  }
  return true;
}

function createLeaseHandle(path: string, token: string): RuntimeLease {
  let released = false;
  return {
    path,
    token,
    release() {
      if (released) return false;
      const removed = removeLease(path, token);
      if (removed) released = true;
      return removed;
    },
  };
}

function removeLease(path: string, expectedToken: string): boolean {
  if (!existsSync(path)) return false;
  const current = readLease(path);
  if (!current || current.token !== expectedToken) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function readLease(path: string): RuntimeLeaseRecord | undefined {
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
