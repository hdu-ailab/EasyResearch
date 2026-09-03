import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import {
  reconstructChildEnvironment,
  type EnvironmentMap,
  type InheritedProxyEnvironment,
} from "../runtime/network-policy";
import {
  DAEMON_CONTROL_PATH,
  DAEMON_OWNER_ENV,
  DAEMON_RUNTIME_ID_ENV,
  DAEMON_TOKEN_HEADER,
  DAEMON_TOKEN_ENV,
  readServerProcess,
  serverOwner,
  stopServerProcess,
} from "./server-process";
import { directLocalHttpFetch, type LocalHttpFetch } from "./local-http";
import type { RuntimeLease, RuntimeLeaseHandoff } from "./runtime-lease";

export const SUCCESSOR_READY_TIMEOUT_MS = 10_000;
export const SUCCESSOR_CLEANUP_TIMEOUT_MS = 2_000;

export interface DaemonLaunchSpec {
  backend: "node" | "bun";
  detached: true;
  platform: NodeJS.Platform;
  command: string;
  args: string[];
  environment: EnvironmentMap;
  stderrPath: string;
}

export interface OwnedDaemonChild {
  readonly pid: number;
  unref(): void;
  terminate(): void;
  forceTerminate(): void;
  waitForExit(timeoutMs: number): Promise<boolean>;
}

export interface SpawnCliDaemonOptions {
  agentDir: string;
  daemonExecutable: string;
  sourceExecutable: string;
  sourceEntry: string;
  embedded: boolean;
  platform: NodeJS.Platform;
  host: string;
  port: number;
  runtimeId: string;
  previousToken?: string;
  environment: EnvironmentMap;
  transitionLease: RuntimeLease;
}

export interface SpawnCliDaemonDependencies {
  randomToken?: () => string;
  launch?: (spec: DaemonLaunchSpec) => Promise<OwnedDaemonChild>;
}

export interface CliDaemonSuccessorReadinessOptions {
  agentDir: string;
  host: string;
  port: number;
  runtimeId: string;
  token: string;
  oldBootId?: string;
  oldPid?: number;
  expectedPid?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface CliDaemonSuccessorReadinessDependencies {
  fetch?: LocalHttpFetch;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface StartCliDaemonSuccessorOptions
  extends Omit<SpawnCliDaemonOptions, "environment"> {
  oldBootId: string;
  oldPid?: number;
  currentEnvironment: Readonly<EnvironmentMap>;
  startupBaseline: InheritedProxyEnvironment;
  readyTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface StartCliDaemonSuccessorDependencies
  extends SpawnCliDaemonDependencies, CliDaemonSuccessorReadinessDependencies {}

export interface StartCliDaemonOptions extends SpawnCliDaemonOptions {
  oldBootId?: string;
  oldPid?: number;
  readyTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  signal?: AbortSignal;
}

export async function spawnCliDaemon(
  options: SpawnCliDaemonOptions,
  dependencies: SpawnCliDaemonDependencies = {},
): Promise<{ token: string; child: OwnedDaemonChild; handoff: RuntimeLeaseHandoff }> {
  const prepared = prepareCliDaemonLaunch(options, dependencies.randomToken ?? randomUUID);
  const handoff = options.transitionLease.reserveHandoff(prepared.token);
  try {
    const child = await (dependencies.launch ?? launchDaemon)(prepared.spec);
    return { token: prepared.token, child, handoff };
  } catch (error) {
    try {
      handoff.cancel();
    } catch (cancelError) {
      throw new AggregateError(
        [error, cancelError],
        "EasyResearch daemon spawn and transition handoff cleanup failed.",
      );
    }
    throw error;
  }
}

function prepareCliDaemonLaunch(
  options: SpawnCliDaemonOptions,
  randomToken: () => string,
): { token: string; spec: DaemonLaunchSpec } {
  const token = randomToken();
  if (!token || token === options.previousToken) {
    throw new Error("EasyResearch daemon launch requires a fresh ownership token.");
  }

  const environment = { ...options.environment };
  delete environment[DAEMON_TOKEN_ENV];
  delete environment[DAEMON_RUNTIME_ID_ENV];
  delete environment[DAEMON_OWNER_ENV];
  environment[DAEMON_TOKEN_ENV] = token;
  environment[DAEMON_RUNTIME_ID_ENV] = options.runtimeId;
  environment[DAEMON_OWNER_ENV] = "cli";

  const compiled = options.embedded;
  const command = compiled ? options.daemonExecutable : options.sourceExecutable;
  const args = compiled
    ? ["--serve", options.host, String(options.port)]
    : [options.sourceEntry, "--serve", options.host, String(options.port)];
  const spec: DaemonLaunchSpec = {
    backend: compiled && options.platform === "win32" ? "bun" : "node",
    detached: true,
    platform: options.platform,
    command,
    args,
    environment,
    stderrPath: join(options.agentDir, "logs", "daemon-stderr.log"),
  };
  return { token, spec };
}

export async function waitForCliDaemonSuccessor(
  options: CliDaemonSuccessorReadinessOptions,
  dependencies: CliDaemonSuccessorReadinessDependencies = {},
): Promise<boolean> {
  const fetchReady = dependencies.fetch ?? directLocalHttpFetch;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? SUCCESSOR_READY_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  let firstAttempt = true;

  while (firstAttempt || now() < deadline) {
    firstAttempt = false;
    if (options.signal?.aborted) return false;
    if (await probeCliDaemonSuccessor(options, fetchReady, deadline, now, timeoutMs > 0)) return true;
    if (options.signal?.aborted || now() >= deadline) return false;
    await waitForReadinessDelay(
      wait(Math.min(options.pollIntervalMs ?? 100, Math.max(0, deadline - now()))),
      options.signal,
    );
  }
  return false;
}

export async function startCliDaemonSuccessor(
  options: StartCliDaemonSuccessorOptions,
  dependencies: StartCliDaemonSuccessorDependencies = {},
): Promise<void> {
  return startCliDaemon({
    ...options,
    environment: reconstructChildEnvironment(options.currentEnvironment, options.startupBaseline),
  }, dependencies);
}

export async function startCliDaemon(
  options: StartCliDaemonOptions,
  dependencies: StartCliDaemonSuccessorDependencies = {},
): Promise<void> {
  const { token, child, handoff } = await spawnCliDaemon(options, dependencies);

  try {
    handoff.commit(child.pid);
  } catch (handoffError) {
    let cleanupError: unknown;
    try {
      await cleanupFailedSuccessor(
        options.agentDir,
        token,
        child,
        options.cleanupTimeoutMs ?? SUCCESSOR_CLEANUP_TIMEOUT_MS,
        dependencies,
        handoff,
      );
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError === undefined) {
      try {
        handoff.cancel();
      } catch (cancelError) {
        cleanupError = cancelError;
      }
    }
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [handoffError, cleanupError],
        "EasyResearch daemon transition handoff and child cleanup failed.",
      );
    }
    throw handoffError;
  }
  let readinessError: unknown;
  let ready = false;
  try {
    ready = await waitForCliDaemonSuccessor({
      agentDir: options.agentDir,
      host: options.host,
      port: options.port,
      runtimeId: options.runtimeId,
      token,
      oldBootId: options.oldBootId,
      oldPid: options.oldPid,
      expectedPid: child.pid,
      timeoutMs: options.readyTimeoutMs,
      signal: options.signal,
    }, {
      fetch: dependencies.fetch,
      now: dependencies.now,
      wait: dependencies.wait,
    });
  } catch (error) {
    readinessError = error;
  }
  if (ready && !options.signal?.aborted) {
    child.unref();
    return;
  }

  try {
    await cleanupFailedSuccessor(
      options.agentDir,
      token,
      child,
      options.cleanupTimeoutMs ?? SUCCESSOR_CLEANUP_TIMEOUT_MS,
      dependencies,
      handoff,
    );
  } catch (cleanupError) {
    if (readinessError !== undefined) {
      throw new AggregateError(
        [readinessError, cleanupError],
        "EasyResearch daemon readiness and cleanup failed.",
      );
    }
    throw cleanupError;
  }
  if (options.signal?.aborted) return;
  if (readinessError !== undefined) throw readinessError;
  throw new Error("EasyResearch daemon failed authenticated readiness.");
}

async function cleanupFailedSuccessor(
  agentDir: string,
  token: string,
  child: OwnedDaemonChild,
  timeoutMs: number,
  dependencies: CliDaemonSuccessorReadinessDependencies,
  handoff: RuntimeLeaseHandoff,
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  try {
    await stopServerProcess(agentDir, {
      expectedOwner: "cli",
      expectedToken: token,
      fetch: dependencies.fetch,
      now: dependencies.now,
      wait: dependencies.wait,
      timeoutMs,
    });
  } catch (error) {
    cleanupErrors.push(error);
    // The owned process handle remains the fallback cleanup authority.
  }

  try {
    child.terminate();
  } catch (error) {
    cleanupErrors.push(error);
  }
  let exited = await waitForOwnedDaemonExit(child, timeoutMs, cleanupErrors);
  if (!exited) {
    try {
      child.forceTerminate();
    } catch (error) {
      cleanupErrors.push(error);
    }
    exited = await waitForOwnedDaemonExit(child, timeoutMs, cleanupErrors);
  }
  if (!exited) {
    const message = "EasyResearch daemon successor did not exit after forced termination.";
    try {
      if (!handoff.transferred) handoff.commit(child.pid);
      handoff.relinquish();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, message);
    throw new Error(message);
  }
}

async function waitForOwnedDaemonExit(
  child: OwnedDaemonChild,
  timeoutMs: number,
  errors: unknown[],
): Promise<boolean> {
  try {
    return await child.waitForExit(timeoutMs);
  } catch (error) {
    errors.push(error);
    return false;
  }
}

async function probeCliDaemonSuccessor(
  options: CliDaemonSuccessorReadinessOptions,
  fetchReady: LocalHttpFetch,
  deadline: number,
  now: () => number,
  enforceDeadline: boolean,
): Promise<boolean> {
  const expected = readExpectedSuccessorRecord(options);
  if (!expected) return false;
  const origin = daemonProbeOrigin(options.host, options.port);
  try {
    const control = await fetchReady(`${origin}${DAEMON_CONTROL_PATH}`, {
      method: "GET",
      headers: { [DAEMON_TOKEN_HEADER]: options.token },
      redirect: "error",
      signal: readinessRequestSignal(options.signal, remainingRequestTimeout(deadline, now)),
    });
    if (!control.ok) return false;
    const controlBody = await control.json() as { runtimeId?: unknown };
    if (controlBody.runtimeId !== options.runtimeId) return false;
    if (options.signal?.aborted || (enforceDeadline && now() > deadline)) return false;

    const status = await fetchReady(`${origin}/api/status`, {
      redirect: "error",
      signal: readinessRequestSignal(options.signal, remainingRequestTimeout(deadline, now)),
    });
    if (!status.ok) return false;
    const statusBody = await status.json() as { bootId?: unknown };
    if (
      typeof statusBody.bootId !== "string"
      || statusBody.bootId.length === 0
      || (options.oldBootId !== undefined && statusBody.bootId === options.oldBootId)
    ) {
      return false;
    }
    if (options.signal?.aborted || (enforceDeadline && now() > deadline)) return false;
    const current = readExpectedSuccessorRecord(options);
    return current !== undefined && current.pid === expected.pid;
  } catch {
    return false;
  }
}

function remainingRequestTimeout(deadline: number, now: () => number): number {
  return Math.max(1, Math.min(2_000, deadline - now()));
}

function readinessRequestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function waitForReadinessDelay(
  wait: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal || signal.aborted) return signal ? undefined : wait;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([wait, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function readExpectedSuccessorRecord(
  options: CliDaemonSuccessorReadinessOptions,
) {
  const entry = readServerProcess(options.agentDir);
  if (entry.kind !== "owned") return undefined;
  const record = entry.record;
  if (
    record.token !== options.token
    || serverOwner(record) !== "cli"
    || record.host !== options.host
    || record.port !== options.port
    || record.runtimeId !== options.runtimeId
    || (options.oldPid !== undefined && record.pid === options.oldPid)
    || (options.expectedPid !== undefined && record.pid !== options.expectedPid)
  ) {
    return undefined;
  }
  return record;
}

function daemonProbeOrigin(host: string, port: number): string {
  const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const authority = probeHost.includes(":") ? `[${probeHost}]` : probeHost;
  return `http://${authority}:${port}`;
}

async function launchDaemon(spec: DaemonLaunchSpec): Promise<OwnedDaemonChild> {
  mkdirSync(dirname(spec.stderrPath), { recursive: true });
  const environment = stringEnvironment(spec.environment);
  if (spec.backend === "bun") {
    const child = Bun.spawn([spec.command, ...spec.args], {
      detached: spec.detached,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: environment,
    });
    const exited = child.exited.then(() => undefined, () => undefined);
    return {
      pid: child.pid,
      unref: () => child.unref(),
      terminate: () => terminateDaemonTree(child.pid, spec, "SIGTERM", () => child.kill()),
      forceTerminate: () => terminateDaemonTree(child.pid, spec, "SIGKILL", () => child.kill("SIGKILL")),
      waitForExit: (timeoutMs) => waitForExit(exited, timeoutMs),
    };
  }

  const stderrFd = openSync(spec.stderrPath, "a");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(spec.command, spec.args, {
      detached: spec.detached,
      stdio: ["ignore", "ignore", stderrFd],
      env: environment,
    });
  } finally {
    closeSync(stderrFd);
  }
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    child.once("error", onError);
    child.once("spawn", () => {
      child.removeListener("error", onError);
      resolve();
    });
  });
  const childPid = child.pid;
  if (!childPid) {
    child.kill("SIGKILL");
    throw new Error("EasyResearch daemon spawn did not report a process id.");
  }
  return {
    pid: childPid,
    unref: () => child.unref(),
    terminate: () => terminateDaemonTree(childPid, spec, "SIGTERM", () => child.kill("SIGTERM")),
    forceTerminate: () => terminateDaemonTree(childPid, spec, "SIGKILL", () => child.kill("SIGKILL")),
    waitForExit: (timeoutMs) => waitForExit(exited, timeoutMs),
  };
}

function terminateDaemonTree(
  pid: number | undefined,
  spec: Pick<DaemonLaunchSpec, "platform" | "environment">,
  signal: "SIGTERM" | "SIGKILL",
  terminateChild: () => unknown,
): void {
  if (!pid) {
    terminateChild();
    return;
  }
  if (spec.platform === "win32") {
    const systemRoot = spec.environment.SystemRoot
      ?? spec.environment.SYSTEMROOT
      ?? process.env.SystemRoot
      ?? "C:\\Windows";
    const result = spawnSync(
      win32.join(systemRoot, "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
      { windowsHide: true, stdio: "ignore", timeout: SUCCESSOR_CLEANUP_TIMEOUT_MS },
    );
    if (!result.error && result.status === 0) return;
    terminateChild();
    if (result.error) throw result.error;
    throw new Error(`taskkill exited with status ${result.status ?? "unknown"}.`);
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    try {
      terminateChild();
    } catch (fallbackError) {
      throw new AggregateError([error, fallbackError], "EasyResearch daemon tree termination failed.");
    }
  }
}

function stringEnvironment(environment: EnvironmentMap): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

async function waitForExit(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    }),
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}
