import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dayStamp, resolveLogConfig } from "../runtime/logger";
import { directLocalHttpFetch, type LocalHttpFetch } from "./local-http";
import { serverLeaseTokenState, type RuntimeLease } from "./runtime-lease";
export { DAEMON_CONTROL_PATH, DAEMON_TOKEN_HEADER } from "./daemon-control";
import { DAEMON_CONTROL_PATH, DAEMON_TOKEN_HEADER } from "./daemon-control";

export const DAEMON_TOKEN_ENV = "EASYRESEARCH_DAEMON_TOKEN";
export const DAEMON_RUNTIME_ID_ENV = "EASYRESEARCH_DAEMON_RUNTIME_ID";
export const DAEMON_OWNER_ENV = "EASYRESEARCH_DAEMON_OWNER";
export const DESKTOP_OWNS_RUNTIME_MESSAGE =
  "EasyResearch Desktop owns the shared runtime. Quit it from the tray or menu bar before using the npm CLI.";

export type ServerOwner = "cli" | "desktop";

export interface ServerProcessRecord {
  schema: 1;
  pid: number;
  host: string;
  port: number;
  token: string;
  runtimeId: string;
  owner?: ServerOwner;
}

export interface ServerProcessOptions {
  fetch?: LocalHttpFetch;
  isAlive?: (pid: number) => boolean;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  expectedOwner?: ServerOwner;
  expectedToken?: string;
}

export type ServerProcessEntry =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "legacy"; pid: number }
  | { kind: "owned"; record: ServerProcessRecord };

export function serverPidPath(agentDir: string): string {
  return join(agentDir, "server.pid");
}

export function serverLogPath(agentDir: string): string {
  return join(agentDir, "server.log");
}

/**
 * The file the web-server logger actually writes to: the configured log dir
 * (default <agentDir>/logs) plus the per-day `easyresearch-<date>.log` name.
 */
export function serverLogFile(agentDir: string): string {
  return join(resolveLogConfig(agentDir).logDir, `easyresearch-${dayStamp()}.log`);
}

export function readServerPid(agentDir: string): number | undefined {
  const entry = readServerProcess(agentDir);
  if (entry.kind === "legacy") return entry.pid;
  return entry.kind === "owned" ? entry.record.pid : undefined;
}

export function serverOwner(record: ServerProcessRecord): ServerOwner {
  return record.owner ?? "cli";
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function writeServerPid(agentDir: string, pid: number): void {
  writeServerProcessFile(agentDir, `${pid}\n`);
}

export function writeServerProcess(agentDir: string, record: ServerProcessRecord): void {
  if (!isServerProcessRecord(record)) throw new Error("Invalid daemon ownership record");
  writeServerProcessFile(agentDir, `${JSON.stringify(record)}\n`);
}

function writeServerProcessFile(agentDir: string, content: string): void {
  const path = serverPidPath(agentDir);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export function removeServerPid(
  agentDir: string,
  expectedToken: string,
  serverLease?: RuntimeLease,
): boolean {
  if (
    !serverLease
    || !serverLease.held
    || serverLease.token !== expectedToken
    || serverLease.path !== join(agentDir, "server.lease")
  ) {
    return false;
  }
  const path = serverPidPath(agentDir);
  if (!existsSync(path)) return false;
  const entry = readServerProcessFile(path);
  if (entry.kind !== "owned" || entry.record.token !== expectedToken) return false;
  try {
    // The matching non-empty server lease prevents any legitimate replacement
    // publisher until this exact record has been removed.
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function inspectServerProcess(
  agentDir: string,
  currentRuntimeId: string,
  requestedHost: string,
  requestedPort: number,
  options: ServerProcessOptions = {},
): Promise<"none" | "current" | "stale" | "desktop"> {
  const entry = readServerProcess(agentDir);
  if (entry.kind === "missing") return "none";
  if (entry.kind === "invalid") {
    throw unverifiedDaemonError("malformed server.pid record");
  }

  const isAlive = options.isAlive ?? isProcessAlive;
  if (entry.kind === "legacy") {
    throw unverifiedDaemonError(`legacy PID ${entry.pid}`);
  }

  const { record } = entry;
  try {
    const runningRuntimeId = await probeServerProcess(record, options.fetch ?? directLocalHttpFetch);
    if (serverOwner(record) === "desktop") return "desktop";
    return runningRuntimeId === currentRuntimeId
        && record.host === requestedHost
        && record.port === requestedPort
      ? "current"
      : "stale";
  } catch (error) {
    if (!isAlive(record.pid)) {
      return "none";
    }
    throw unverifiedDaemonError(`PID ${record.pid}`, error);
  }
}

export async function stopServerProcess(
  agentDir: string,
  options: ServerProcessOptions = {},
): Promise<boolean> {
  const entry = readServerProcess(agentDir);
  if (entry.kind === "missing") return false;
  if (
    options.expectedToken !== undefined
    && (entry.kind !== "owned" || entry.record.token !== options.expectedToken)
  ) {
    return false;
  }
  if (entry.kind === "invalid") {
    throw unverifiedDaemonError("malformed server.pid record");
  }

  const isAlive = options.isAlive ?? isProcessAlive;
  if (entry.kind === "legacy") {
    throw unverifiedDaemonError(`legacy PID ${entry.pid}`);
  }

  const { record } = entry;
  const expectedOwner = options.expectedOwner ?? "cli";
  const actualOwner = serverOwner(record);
  if (actualOwner !== expectedOwner) {
    if (actualOwner === "desktop") {
      throw new Error(DESKTOP_OWNS_RUNTIME_MESSAGE);
    }
    throw new Error(`EasyResearch ${actualOwner} owns the shared runtime; expected ${expectedOwner}.`);
  }
  const fetchControl = options.fetch ?? directLocalHttpFetch;
  let response: Response;
  try {
    response = await fetchControl(serverControlUrl(record), {
      method: "POST",
      headers: { [DAEMON_TOKEN_HEADER]: record.token },
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
  } catch (error) {
    if (!isAlive(record.pid)) {
      return false;
    }
    throw unverifiedDaemonError(`PID ${record.pid}`, error);
  }
  if (!response.ok) throw unverifiedDaemonError(`PID ${record.pid}`);

  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? 5_000;
  const deadline = now() + timeoutMs;
  while (true) {
    const current = readServerProcess(agentDir);
    const recordReleased = current.kind !== "owned" || current.record.token !== record.token;
    if (recordReleased && serverLeaseTokenState(agentDir, record.token) === "released") {
      return true;
    }
    if (now() >= deadline) break;
    await wait(100);
  }
  throw new Error(
    `EasyResearch daemon PID ${record.pid} accepted shutdown but did not release its ownership record and server lease within ${timeoutMs}ms.`,
  );
}

export function readServerProcess(agentDir: string): ServerProcessEntry {
  return readServerProcessFile(serverPidPath(agentDir));
}

function readServerProcessFile(path: string): ServerProcessEntry {
  if (!existsSync(path)) return { kind: "missing" };
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch {
    return { kind: "invalid" };
  }
  if (/^[1-9]\d*$/u.test(value)) {
    const pid = Number(value);
    return Number.isSafeInteger(pid) ? { kind: "legacy", pid } : { kind: "invalid" };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isServerProcessRecord(parsed)
      ? { kind: "owned", record: parsed }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function isServerProcessRecord(value: unknown): value is ServerProcessRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ServerProcessRecord>;
  return record.schema === 1
    && Number.isSafeInteger(record.pid)
    && (record.pid ?? 0) > 0
    && typeof record.host === "string"
    && record.host.length > 0
    && Number.isInteger(record.port)
    && (record.port ?? 0) >= 1
    && (record.port ?? 0) <= 65535
    && typeof record.token === "string"
    && record.token.length > 0
    && typeof record.runtimeId === "string"
    && record.runtimeId.length > 0
    && (record.owner === undefined || record.owner === "cli" || record.owner === "desktop");
}

async function probeServerProcess(
  record: ServerProcessRecord,
  fetchControl: LocalHttpFetch,
): Promise<string> {
  const response = await fetchControl(serverControlUrl(record), {
    method: "GET",
    headers: { [DAEMON_TOKEN_HEADER]: record.token },
    redirect: "error",
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`daemon control returned HTTP ${response.status}`);
  const body = await response.json() as { runtimeId?: unknown };
  if (typeof body.runtimeId !== "string" || body.runtimeId.length === 0) {
    throw new Error("daemon control returned an invalid runtime identity");
  }
  return body.runtimeId;
}

function serverControlUrl(record: ServerProcessRecord): string {
  const host = record.host === "0.0.0.0" || record.host === "::" ? "127.0.0.1" : record.host;
  const authority = host.includes(":") ? `[${host}]` : host;
  return `http://${authority}:${record.port}${DAEMON_CONTROL_PATH}`;
}

function unverifiedDaemonError(identity: string, cause?: unknown): Error {
  return new Error(
    `Cannot verify EasyResearch daemon ownership for ${identity}. No process was terminated. Stop the previous service manually, remove the stale server.pid file, and retry.`,
    cause === undefined ? undefined : { cause },
  );
}
