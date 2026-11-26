/** Private acceptance infrastructure. Never imported by the product runtime. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { closeSync, createReadStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { Duplex } from "node:stream";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { pipeline } from "node:stream/promises";
import type { UpdateActionResult } from "../src/runtime/update-contract";
import { desktopUpdateFailure, type DesktopUpdateReceipt } from "../src/desktop/update-protocol";
import { smokeAgentText, type SmokeAgentRequest } from "./smoke-agent-scenario";

export function desktopUpdateFixtureInput(request: SmokeAgentRequest, marker: string): "history" | "active" | undefined {
  const inputs = request.messages?.filter(message => message.role === "user").map(message => smokeAgentText(message.content)) ?? [];
  if (inputs.some(text => text.includes(`${marker}:active`))) return "active";
  if (inputs.some(text => text.includes(`${marker}:history`))) return "history";
  return undefined;
}

export function desktopCustodyDiagnostic(receipt: DesktopUpdateReceipt): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (["prepared", "installing", "verifying", "recovering", "complete", "failed", "cancelled"].includes(receipt.phase)) result.phase = receipt.phase;
  for (const key of ["workerPid", "installerGuardPid"] as const) if (Number.isSafeInteger(receipt[key]) && receipt[key]! > 0) result[key] = receipt[key];
  for (const key of ["installerSettled", "custodyUnresolved", "recovery"] as const) if (typeof receipt[key] === "boolean") result[key] = receipt[key];
  if (receipt.failure && /^(?:verify-(?:registry|version|files)|rollback-(?:stop|lease|server|quarantine|remove-current|restore-files|registry|verify)|recovery-(?:verify|version|launch))$/u.test(receipt.failure.operation)
    && /^(?:EPERM|EACCES|ENOENT|EBUSY|ENOTEMPTY|EEXIST|ETIMEDOUT|EINVAL|EIO|FAILED|UPDATE_PROCESS_EXIT)$/u.test(receipt.failure.code)) {
    result.failure = desktopUpdateFailure(receipt.failure.operation, receipt.failure);
  }
  if (receipt.outcome) {
    const outcome: Record<string, unknown> = {};
    for (const key of ["installerAdmitted", "hostExited", "recoveryComplete"] as const) if (typeof receipt.outcome[key] === "boolean") outcome[key] = receipt.outcome[key];
    if (["not-required", "pending", "complete"].includes(receipt.outcome.rollback)) outcome.rollback = receipt.outcome.rollback;
    result.outcome = outcome;
  }
  return result;
}

function diagnosticText(text: string, secrets: readonly string[], limit: number): string {
  for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
  text = text.split(/\r?\n/u).map(line => {
    // No raw protocol/auth objects or credential-bearing headers enter uploaded diagnostics.
    if (/(?:authorization|cookie|auth|api[-_]?key|password|client[-_]?secret|(?:renderer|control|successor|worker|access|refresh)?[-_]?token|credentials?)\s*["']?\s*[:=]|\b(?:Bearer|Basic)\s+\S+/iu.test(line)) return "[redacted credential-bearing line]";
    return line.replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gu, "[redacted]");
  }).join("\n");
  const bytes = Buffer.from(text);
  return bytes.length <= limit ? text : bytes.subarray(-(limit - 3)).toString("utf8");
}

export function fixtureDiagnosticError(error: unknown, secrets: readonly string[] = []): string {
  const seen = new Set<unknown>();
  const describe = (value: unknown, depth: number): string => {
    if (depth > 3 || seen.has(value)) return "[additional error context omitted]";
    seen.add(value);
    if (!(value instanceof Error)) return typeof value === "string" ? value : "Non-Error fixture failure";
    const causes = value instanceof AggregateError ? [...value.errors].slice(0, 4) : value.cause === undefined ? [] : [value.cause];
    return [value.message, ...causes.map(cause => describe(cause, depth + 1))].join("\nCaused by: ");
  };
  return diagnosticText(describe(error, 0), secrets, 8192);
}

function updateDiagnostic(value: unknown, secrets: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { unavailable: true };
  const source = value as Record<string, unknown>; const result: Record<string, unknown> = {};
  for (const key of ["owner", "phase", "currentVersion", "latestVersion", "code"])
    if (typeof source[key] === "string" && source[key].length <= 80) result[key] = diagnosticText(source[key], secrets, 256);
  for (const key of ["revision", "bytesReceived", "bytesTotal", "activeSessions"])
    if (Number.isSafeInteger(source[key]) && (source[key] as number) >= 0) result[key] = source[key];
  for (const key of ["canDownload", "canInstall", "canActivate", "canCancel", "canReveal", "authFlowActive"])
    if (typeof source[key] === "boolean") result[key] = source[key];
  if (typeof source.message === "string") result.message = diagnosticText(source.message, secrets, 2048);
  return result;
}

/** A rejected/early IPC result must fail the handoff wait, rather than disappear into its deadline. */
export function observeFixtureUpdateAction(action: Promise<UpdateActionResult>, secrets: () => readonly string[] = () => []) {
  let outcome: { kind: "pending" } | { kind: "result"; value: UpdateActionResult } | { kind: "error"; error: unknown } = { kind: "pending" };
  void action.then(value => { outcome = { kind: "result", value }; }, error => { outcome = { kind: "error", error }; });
  const diagnostic = (): Record<string, unknown> => outcome.kind === "error" ? { kind: "error", error: fixtureDiagnosticError(outcome.error, secrets()) }
    : outcome.kind === "result" ? { kind: "result", result: updateDiagnostic(outcome.value, secrets()) } : { kind: "pending" };
  const fail = (label: string) => { throw new Error(`${label}: install action settled before the expected handoff: ${JSON.stringify(diagnostic())}`); };
  return { result: action, diagnostic,
    assertPending(label: string) { if (outcome.kind !== "pending") fail(label); },
    assertInstalling(label: string, allowHostDisconnect: boolean) {
      if (outcome.kind === "error" && !(allowHostDisconnect && outcome.error instanceof Error
        && /(?:page|context|browser|target|session|connection).*(?:closed|destroyed|disconnected)/iu.test(outcome.error.message))) fail(label);
      if (outcome.kind === "result" && ("code" in outcome.value || outcome.value.phase !== "activating")) fail(label);
    },
  };
}

/** Snapshot and log capture happen before browser/process cleanup and expose only bounded safe projections. */
export async function captureDesktopUpdateFailure(options: {
  root: string; userData: string; error: unknown; secrets: readonly string[];
  actions: readonly ReturnType<typeof observeFixtureUpdateAction>[];
  snapshot?: () => Promise<unknown>; snapshotTimeoutMs?: number;
}): Promise<void> {
  const report: Record<string, unknown> = { error: fixtureDiagnosticError(options.error, options.secrets), actions: options.actions.map(action => action.diagnostic()) };
  const reportPath = assertFixtureChild(options.root, join(options.root, "update-failure.json"));
  const save = () => writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  save(); // Preserve the primary failure even if later diagnostics fail or the view never replies.
  try {
    const path = assertFixtureChild(options.userData, join(options.userData, "logs", "desktop.log"));
    const file = openSync(path, "r");
    try {
      const info = fstatSync(file); assert(info.isFile(), "Desktop owner log is not a regular file");
      const bytes = Buffer.alloc(Math.min(info.size, 64 * 1024));
      const position = Math.max(0, info.size - bytes.length);
      const read = readSync(file, bytes, 0, bytes.length, position);
      let text = bytes.subarray(0, read).toString("utf8");
      // A cut credential-bearing line may have lost its field name or full secret.
      if (position > 0) text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "[incomplete log line omitted]";
      writeFileSync(assertFixtureChild(options.root, join(options.root, "desktop-owner.log")), diagnosticText(text, options.secrets, 64 * 1024), { mode: 0o600 });
      report.ownerLogCaptured = true;
    } finally { closeSync(file); }
  } catch (error) { report.ownerLogError = fixtureDiagnosticError(error, options.secrets); }
  if (options.snapshot) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([Promise.resolve().then(options.snapshot), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Update diagnostic snapshot timed out")), options.snapshotTimeoutMs ?? 3000);
      })]);
      report.snapshot = updateDiagnostic(value, options.secrets);
    } catch (error) { report.snapshotError = fixtureDiagnosticError(error, options.secrets); }
    finally { clearTimeout(timer); }
  }
  save();
}

/** Observe only: a leftover recovery copy must fail acceptance, never be hidden by harness removal. */
export function remainingDesktopRecoveryArtifacts(installation: string, operationId: string): string[] {
  assert(/^[a-f0-9-]{36}$/u.test(operationId), "Invalid fixture operation identity");
  const prefixes = [`${basename(installation)}.update-backup`, `${basename(installation)}.update-failed`];
  const entries = readdirSync(dirname(installation));
  assert(entries.length <= 4096, "Unexpected fixture installation-parent contents");
  return entries.filter(name => prefixes.some(prefix => name === prefix || name === `${prefix}-${operationId}` || name.startsWith(`${prefix}-`)))
    .map(name => join(dirname(installation), name));
}

export interface WindowsFixtureProcess {
  pid: number; parentPid: number; start: string; executable: string;
  worker: boolean; installer: boolean; job: boolean; requestedFrench?: boolean;
  /** Current-parent corroboration; historical edges also require a unique valid lifetime interval. */
  parentStart?: string;
}
const PROCESS_LIMIT = 4096;
function validProcessStart(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{7})Z$/u.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1601 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!
    && hour <= 23 && minute <= 59 && second <= 59;
}
export function fixtureProcessIdentity(row: Pick<WindowsFixtureProcess, "pid" | "start">): string {
  assert(Number.isSafeInteger(row.pid) && row.pid > 0 && row.pid <= 0x7fffffff && validProcessStart(row.start), "Invalid Windows process creation identity");
  // Fixed-width UTC CIM strings preserve all seven fractional digits and sort
  // chronologically. Date.parse would collapse distinct lifetimes to milliseconds.
  return `${row.pid}:${row.start}`;
}
function assertProcessRoles(row: WindowsFixtureProcess): void {
  assert(Number(row.worker) + Number(row.installer) + Number(row.job) <= 1
    && !(row.requestedFrench && (row.worker || row.installer || row.job)), "Conflicting Windows process role flags");
}
export function retainFixtureProcessObservation(previous: WindowsFixtureProcess | undefined, current: WindowsFixtureProcess): WindowsFixtureProcess {
  const identity = fixtureProcessIdentity(current); assertProcessRoles(current);
  if (!previous || fixtureProcessIdentity(previous) !== identity) return { ...current };
  assert(previous.parentPid === current.parentPid, "Conflicting retained process parent identity");
  assert(!previous.parentStart || !current.parentStart || previous.parentStart === current.parentStart, "Conflicting retained process parent lifetime");
  assert(!previous.executable || !current.executable || previous.executable.toLowerCase() === current.executable.toLowerCase(), "Conflicting retained process executable identity");
  const retained = { ...current, parentStart: current.parentStart ?? previous.parentStart, executable: current.executable || previous.executable,
    worker: previous.worker || current.worker, installer: previous.installer || current.installer,
    job: previous.job || current.job, requestedFrench: previous.requestedFrench || current.requestedFrench };
  assertProcessRoles(retained);
  return retained;
}
function parseProcessRows(text: string, history: boolean): WindowsFixtureProcess[] {
  assert(Buffer.byteLength(text, "utf8") <= 2 * 1024 * 1024, "Windows process observations exceed their bound");
  const rows: unknown = JSON.parse(text);
  assert(Array.isArray(rows) && rows.length <= PROCESS_LIMIT, "Expected a bounded flat Windows process array");
  const seen = new Set<string | number>();
  return rows.map(value => {
    assert(value && typeof value === "object" && !Array.isArray(value), "Invalid Windows process observation");
    const row = value as WindowsFixtureProcess;
    const identity = fixtureProcessIdentity(row);
    assert(Number.isSafeInteger(row.parentPid) && row.parentPid >= 0 && row.parentPid <= 0x7fffffff && row.parentPid !== row.pid
      && typeof row.executable === "string" && row.executable.length <= 32767 && !/[\r\n\0]/u.test(row.executable)
      && typeof row.worker === "boolean" && typeof row.installer === "boolean" && typeof row.job === "boolean"
      && (row.requestedFrench === undefined || typeof row.requestedFrench === "boolean")
      && (row.parentStart === undefined || (row.parentPid > 0 && validProcessStart(row.parentStart) && row.parentStart < row.start)),
    "Invalid Windows process identity or flags");
    assertProcessRoles(row);
    const key = history ? identity : row.pid;
    assert(!seen.has(key), "Duplicate Windows process identity"); seen.add(key);
    return { pid: row.pid, parentPid: row.parentPid, start: row.start, executable: row.executable,
      worker: row.worker, installer: row.installer, job: row.job,
      ...(row.requestedFrench === undefined ? {} : { requestedFrench: row.requestedFrench }),
      ...(row.parentStart === undefined ? {} : { parentStart: row.parentStart }) };
  });
}
export function parseFixtureWindowsProcesses(text: string): WindowsFixtureProcess[] { return parseProcessRows(text, false); }
export function parseFixtureProcessHistory(text: string): WindowsFixtureProcess[] { return parseProcessRows(text, true); }

function bindCurrentParents(rows: readonly WindowsFixtureProcess[]): WindowsFixtureProcess[] {
  const current = new Map(rows.map(row => [row.pid, row]));
  return rows.map(row => {
    const parent = current.get(row.parentPid);
    if (!parent || parent.start >= row.start) return { ...row };
    assert(!row.parentStart || row.parentStart === parent.start, "Current process parent lifetime changed");
    return { ...row, parentStart: parent.start };
  });
}
/** One bounded history, with live snapshots kept separate and unmodified. */
export function retainFixtureProcessHistory(history: Map<string, WindowsFixtureProcess>, snapshot: readonly WindowsFixtureProcess[]): void {
  const current = bindCurrentParents(parseFixtureWindowsProcesses(JSON.stringify(snapshot)));
  const next = new Map(history);
  for (const row of current) {
    const key = fixtureProcessIdentity(row);
    next.set(key, retainFixtureProcessObservation(next.get(key), row));
  }
  assert(next.size <= PROCESS_LIMIT, "Windows process history exceeds its bound");
  parseFixtureProcessHistory(JSON.stringify([...next.values()]));
  for (const [key, row] of next) assert(key === fixtureProcessIdentity(row), "Invalid Windows process history key");
  for (const [key, row] of next) history.set(key, row);
}

/** Validate the native scope-filtered projection, not a machine-wide CIM dump.
 * Current ownership uses current parent identities, never historical PID ancestry. */
export function selectFixtureWindowsProcesses(rows: readonly WindowsFixtureProcess[], rooted: ReadonlySet<string>, previouslyOwned: readonly WindowsFixtureProcess[]): WindowsFixtureProcess[] {
  const current = bindCurrentParents(parseFixtureWindowsProcesses(JSON.stringify(rows)));
  const known = new Map(parseFixtureProcessHistory(JSON.stringify(previouslyOwned)).map(row => [fixtureProcessIdentity(row), row]));
  const latest = new Map<number, string>();
  for (const row of known.values()) if (!latest.has(row.pid) || latest.get(row.pid)! < row.start) latest.set(row.pid, row.start);
  const byPid = new Map(current.map(row => [row.pid, row]));
  const owned = new Set<string>();
  for (const row of current) {
    assert(!latest.has(row.pid) || latest.get(row.pid)! <= row.start, "Stale Windows process lifetime observed");
    const key = fixtureProcessIdentity(row), previous = known.get(key);
    if (previous) retainFixtureProcessObservation(previous, row); // Validate, but never enrich a live sample.
    if (rooted.has(key) || previous) owned.add(key);
  }
  const children = new Map<string, string[]>();
  for (const row of current) {
    const parent = byPid.get(row.parentPid);
    if (!parent || parent.start >= row.start || row.parentStart !== parent.start) continue;
    const key = fixtureProcessIdentity(parent), bucket = children.get(key) ?? [];
    bucket.push(fixtureProcessIdentity(row)); children.set(key, bucket);
  }
  const pending = [...owned];
  for (let index = 0; index < pending.length; index++) for (const key of children.get(pending[index]!) ?? []) {
    if (!owned.has(key)) { owned.add(key); pending.push(key); }
  }
  return current.filter(row => owned.has(fixtureProcessIdentity(row)));
}

function processGraph(history: readonly WindowsFixtureProcess[]) {
  const rows = parseFixtureProcessHistory(JSON.stringify(history));
  const identities = new Map(rows.map(row => [fixtureProcessIdentity(row), row]));
  const lifetimes = new Map<number, WindowsFixtureProcess[]>();
  for (const row of rows) { const bucket = lifetimes.get(row.pid) ?? []; bucket.push(row); lifetimes.set(row.pid, bucket); }
  for (const bucket of lifetimes.values()) bucket.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  const ends = new Map<string, string>();
  for (const bucket of lifetimes.values()) for (let index = 0; index < bucket.length - 1; index++) {
    ends.set(fixtureProcessIdentity(bucket[index]!), bucket[index + 1]!.start);
  }
  const parent = (row: WindowsFixtureProcess): WindowsFixtureProcess | undefined => {
    const candidates = (lifetimes.get(row.parentPid) ?? []).filter(candidate => {
      const end = ends.get(fixtureProcessIdentity(candidate));
      return candidate.start < row.start && (!end || row.start < end);
    });
    if (candidates.length !== 1) return;
    const candidate = candidates[0]!;
    if (row.parentStart && row.parentStart !== candidate.start) return;
    return candidate;
  };
  const current = (live: readonly WindowsFixtureProcess[]) => {
    const result = new Map<string, WindowsFixtureProcess>();
    for (const row of parseFixtureWindowsProcesses(JSON.stringify(live))) {
      const key = fixtureProcessIdentity(row), recorded = identities.get(key);
      if (!recorded || ends.has(key)) return; // A known reused PID cannot resurrect its old instance.
      result.set(key, retainFixtureProcessObservation(recorded, row));
    }
    return result;
  };
  return { rows, identities, parent, current };
}
export interface DesktopUpdateLineage {
  worker: WindowsFixtureProcess; guard: WindowsFixtureProcess; installer: WindowsFixtureProcess; host: WindowsFixtureProcess; sidecar: WindowsFixtureProcess;
}
/** Exact historical parent instances plus a positively live successor pair. */
export function findDesktopUpdateLineage(processes: readonly WindowsFixtureProcess[], live: readonly WindowsFixtureProcess[], expected: {
  oldHost: WindowsFixtureProcess; sidecarPid: number; host: string; helper: string; installer: string; sidecar: string;
}): DesktopUpdateLineage | undefined {
  const graph = processGraph(processes), current = graph.current(live);
  if (!current) return;
  const same = (a: WindowsFixtureProcess, b: WindowsFixtureProcess) => fixtureProcessIdentity(a) === fixtureProcessIdentity(b);
  const samePath = (a: string, b: string) => a !== "" && win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();
  const sidecar = [...current.values()].find(row => row.pid === expected.sidecarPid && samePath(row.executable, expected.sidecar));
  const host = sidecar && graph.parent(sidecar);
  if (!host || !sidecar || !current.has(fixtureProcessIdentity(host)) || same(host, expected.oldHost) || !samePath(host.executable, expected.host)) return;
  const worker = graph.parent(host), oldHost = worker && graph.parent(worker);
  if (!worker || !worker.worker || !samePath(worker.executable, expected.helper) || !oldHost || !same(oldHost, expected.oldHost)) return;
  retainFixtureProcessObservation(expected.oldHost, oldHost);
  const matches: DesktopUpdateLineage[] = [];
  for (const installer of graph.rows.filter(row => row.installer && samePath(row.executable, expected.installer))) {
    const guard = graph.parent(installer), owner = guard && graph.parent(guard);
    if (guard?.job && owner && same(owner, worker)) matches.push({ worker, guard, installer, host, sidecar });
  }
  return matches.length === 1 ? matches[0] : undefined;
}
/** Only the current accepted host's exact subtree may outlive the updater. */
export function desktopUpdateProcessesSettled(processes: readonly WindowsFixtureProcess[], live: readonly WindowsFixtureProcess[], lineage: DesktopUpdateLineage): boolean {
  const graph = processGraph(processes), current = graph.current(live);
  if (!current || !current.has(fixtureProcessIdentity(lineage.host)) || !current.has(fixtureProcessIdentity(lineage.sidecar))) return false;
  const host = fixtureProcessIdentity(lineage.host), worker = fixtureProcessIdentity(lineage.worker);
  for (const row of current.values()) {
    let ancestor: WindowsFixtureProcess | undefined = row;
    while (ancestor && fixtureProcessIdentity(ancestor) !== host && fixtureProcessIdentity(ancestor) !== worker) ancestor = graph.parent(ancestor);
    if (!ancestor || fixtureProcessIdentity(ancestor) !== host) return false;
  }
  return true;
}

export function assertFixtureChild(root: string, path: string): string {
  const parent = realpathSync(root);
  const candidate = resolve(path);
  const inside = (value: string) => { const rel = relative(parent, value); return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
  assert(inside(candidate), "Fixture path must be strictly inside its private root");
  // Check every existing ancestor as well as the leaf; missing leaves do not
  // grant permission to walk through an existing junction to an unrelated tree.
  let cursor = parent;
  for (const part of relative(parent, candidate).split(sep)) {
    cursor = join(cursor, part);
    if (existsSync(cursor)) assert(!lstatSync(cursor).isSymbolicLink() && inside(realpathSync(cursor)), "Fixture path escaped through a symbolic link");
  }
  return existsSync(candidate) ? realpathSync(candidate) : candidate;
}

export async function digestFile(path: string): Promise<string> {
  assert(lstatSync(path).isFile() && statSync(path).size > 0 && statSync(path).size <= 2 * 1024 ** 3, "Expected a bounded regular artifact");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function assertStableVersion(version: string): void {
  assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)
    && version.split(".").every(value => Number.isSafeInteger(Number(value))), "An exact stable version is required");
}

export function assertOlderVersion(older: string, current: string): void {
  assertStableVersion(older); assertStableVersion(current);
  const parts = current.split(".").map(Number);
  const difference = older.split(".").map((part, index) => Number(part) - parts[index]!).find(value => value !== 0);
  assert(difference !== undefined && difference < 0, "Fixture version must be older than the accepted candidate version");
}

export interface CommandOptions { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; logFile?: string; windowsVerbatimArguments?: boolean; label?: string; input?: string }
export async function runFixtureCommand(command: string, args: string[], options: CommandOptions = {}): Promise<string> {
  if (options.input !== undefined) assert(Buffer.byteLength(options.input, "utf8") <= 2 * 1024 * 1024, "Fixture command input exceeds its bound");
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments, detached: process.platform !== "win32", stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let failure: Error | undefined; let finished = false;
    let hardDeadline: ReturnType<typeof setTimeout> | undefined;
    const capture = (text: string, chunk: Buffer) => (text + chunk.toString()).slice(-2 * 1024 * 1024);
    child.stdout!.on("data", chunk => { stdout = capture(stdout, chunk); });
    child.stderr!.on("data", chunk => { stderr = capture(stderr, chunk); });
    child.once("error", error => { failure = error; });
    if (options.input !== undefined) {
      child.stdin!.on("error", () => { failure = new Error("Fixture command input could not be delivered."); });
      child.stdin!.end(options.input);
    }
    const timer = setTimeout(() => {
      failure = new Error(`Fixture command timed out: ${options.label ?? command}`);
      // Broken inherited pipes cannot hang the gate forever. Caller-owned native
      // fixture cleanup still rechecks/scans its private process tree on rejection.
      hardDeadline = setTimeout(() => finish(null, null), 15_000);
      if (!child.pid) return;
      if (process.platform === "win32") spawnSync(win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { timeout: 10_000, windowsHide: true });
      else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    }, options.timeoutMs ?? 60_000);
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return; finished = true;
      clearTimeout(timer); clearTimeout(hardDeadline);
      if (options.logFile) writeFileSync(options.logFile, `${stdout}\n${stderr}`, { mode: 0o600 });
      if (failure || code !== 0 || signal) reject(new Error(`${failure?.message ?? `Fixture command exited ${code ?? signal}`}: ${options.label ?? command}\n${stdout.slice(-8192)}\n${stderr.slice(-8192)}`));
      else resolveCommand(stdout);
    };
    child.once("close", finish);
  });
}

export interface FixtureTrustStore { contains(thumbprint: string): Promise<boolean>; add(thumbprint: string): Promise<void>; remove(thumbprint: string): Promise<void> }
export interface FixtureRoamingBinding { read(): Promise<string>; write(path: string): Promise<void> }
export async function withFixtureRoamingBinding<T>(directory: string, binding: FixtureRoamingBinding, run: () => Promise<T>): Promise<T> {
  const original = await binding.read();
  assert(win32.isAbsolute(original) && win32.isAbsolute(directory), "Invalid native profile binding");
  const same = (a: string, b: string) => win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();
  assert(!same(original, directory), "Fixture profile binding is already in use");
  const errors: unknown[] = []; let result: T | undefined;
  try {
    await binding.write(directory);
    assert(same(await binding.read(), directory), "Native profile binding did not apply");
    result = await run();
  } catch (error) { errors.push(error); }
  try {
    const current = await binding.read();
    assert(same(current, directory) || same(current, original), "Native profile binding changed independently");
    if (!same(current, original)) await binding.write(original);
    assert(same(await binding.read(), original), "Native profile binding restoration failed");
  } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Fixture scenario and profile restoration failed");
  return result as T;
}

export async function withFixtureTrust<T>(thumbprint: string, store: FixtureTrustStore, run: () => Promise<T>): Promise<T> {
  assert(/^[A-F0-9]{40}$/u.test(thumbprint), "Invalid fixture certificate thumbprint");
  assert(!await store.contains(thumbprint), "Fixture CA already exists; refuse to own another certificate");
  let result: T | undefined; const errors: unknown[] = [];
  try { await store.add(thumbprint); assert(await store.contains(thumbprint), "Fixture CA import did not persist"); result = await run(); }
  catch (error) { errors.push(error); }
  // Import can mutate the store and then fail. Establish ownership before it,
  // and always attempt removal of this exact absent-at-entry fingerprint.
  try { await store.remove(thumbprint); assert(!await store.contains(thumbprint), "Fixture CA cleanup did not remove its certificate"); }
  catch (error) { errors.push(new Error("Fixture CA cleanup failed", { cause: error })); }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Fixture execution and CA cleanup failed");
  return result as T;
}

export function powershellExecutable(): string {
  assert.equal(process.platform, "win32", "Windows fixture operations require native Windows");
  const path = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  assert(statSync(path).isFile(), "Windows PowerShell is unavailable"); return path;
}
export async function powershell(script: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 30_000, label = "PowerShell fixture probe", input?: string): Promise<string> {
  return runFixtureCommand(powershellExecutable(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
    Buffer.from(`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ${script}`, "utf16le").toString("base64")], { env, timeoutMs, label, input });
}

export function assertHostedWindowsFixture(): void {
  assert(process.platform === "win32" && process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted",
    "Native fixture mutation requires a disposable GitHub-hosted Windows runner");
}

export function windowsFixtureTrust(caPath: string): FixtureTrustStore {
  assertHostedWindowsFixture();
  const execute = (label: string, operation: string, thumbprint: string) => powershell(`
    $store=[System.Security.Cryptography.X509Certificates.X509Store]::new('Root','LocalMachine');
    $store.Open('ReadWrite');
    try {
      $matches=@($store.Certificates | Where-Object { $_.Thumbprint -ceq $env:ER_FIXTURE_THUMBPRINT });
      ${operation}
    } finally { $store.Close() }
  `, { ...process.env, ER_FIXTURE_THUMBPRINT: thumbprint, ER_FIXTURE_CA: caPath }, 30_000, `certificate store ${label}`);
  const contains = async (thumbprint: string) => (await execute("contains", "[Console]::Write($matches.Count)", thumbprint)).trim() !== "0";
  return {
    contains,
    async add(thumbprint) {
      assert.equal(new X509Certificate(readFileSync(caPath)).fingerprint.replaceAll(":", ""), thumbprint, "Fixture CA identity mismatch");
      assert(!await contains(thumbprint), "Fixture certificate unexpectedly exists");
      // CurrentUser Root always requests interactive confirmation. This disposable
      // hosted runner's machine store uses its existing administrator context.
      await runFixtureCommand(win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "certutil.exe"),
        ["-f", "-addstore", "Root", caPath], { timeoutMs: 30_000, label: "certificate store add" });
    },
    async remove(thumbprint) { await execute("remove", "foreach($cert in $matches){$store.Remove($cert)}", thumbprint); },
  };
}

export interface DesktopFixtureCertificate { cert: Buffer; key: Buffer; ca: Buffer; caPath: string; thumbprint: string }
export async function createDesktopFixtureCertificate(root: string): Promise<DesktopFixtureCertificate> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const candidates = (process.env.PATH ?? "").split(delimiter).map(dir => join(dir, process.platform === "win32" ? "openssl.exe" : "openssl"));
  if (process.platform === "win32") candidates.push("C:\\Program Files\\Git\\usr\\bin\\openssl.exe", "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe");
  const executable = candidates.find(path => existsSync(path) && statSync(path).isFile());
  assert(executable, "OpenSSL is required for the isolated TLS fixture (Git for Windows supplies it)");
  const run = (args: string[]) => runFixtureCommand(executable, args, { cwd: root, timeoutMs: 30_000 });
  await run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2", "-subj", "/CN=EasyResearch private Desktop update acceptance CA",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", "ca.key", "-out", "ca.pem"]);
  await run(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-subj", "/CN=api.github.com", "-keyout", "server.key", "-out", "server.csr"]);
  writeFileSync(join(root, "server.ext"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:api.github.com,DNS:github.com\n");
  await run(["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-sha256", "-extfile", "server.ext", "-out", "server.pem"]);
  await run(["x509", "-in", "ca.pem", "-outform", "DER", "-out", "ca.cer"]);
  const ca = readFileSync(join(root, "ca.pem"));
  return { cert: readFileSync(join(root, "server.pem")), key: readFileSync(join(root, "server.key")), ca, caPath: join(root, "ca.cer"),
    thumbprint: new X509Certificate(ca).fingerprint.replaceAll(":", "") };
}

type FixtureResponse = { kind: "text"; body: Buffer; contentType: string } | { kind: "file"; path: string; size: number };
export async function createReleaseFixture(version: string, installer: string, options: { corruptDigest?: boolean } = {}) {
  assertStableVersion(version);
  const name = `EasyResearch-${version}-windows-x64.exe`;
  const actualDigest = await digestFile(installer);
  const digest = options.corruptDigest ? `${actualDigest[0] === "0" ? "1" : "0"}${actualDigest.slice(1)}` : actualDigest;
  const size = statSync(installer).size;
  const base = `/hdu-ailab/EasyResearch/releases/download/v${version}/`;
  const checksum = Buffer.from(`${digest}  ${name}\n`);
  const asset = (file: string, bytes: number, hash: string) => ({ name: file, size: bytes, digest: `sha256:${hash}`, state: "uploaded", browser_download_url: `https://github.com${base}${file}` });
  const metadata = Buffer.from(JSON.stringify({ tag_name: `v${version}`, html_url: `https://github.com/hdu-ailab/EasyResearch/releases/tag/v${version}`, draft: false, prerelease: false,
    assets: [asset(name, size, digest), asset("SHA256SUMS", checksum.length, createHash("sha256").update(checksum).digest("hex"))] }));
  assert(metadata.length < 1024 * 1024, "Release fixture exceeds the real metadata bound");
  return { name, size, actualDigest,
    match(method: string, host: string, path: string): FixtureResponse | undefined {
      if (method !== "GET") return;
      if (host === "api.github.com" && path === "/repos/hdu-ailab/EasyResearch/releases/latest") return { kind: "text", body: metadata, contentType: "application/json" };
      if (host !== "github.com") return;
      if (path === `${base}SHA256SUMS`) return { kind: "text", body: checksum, contentType: "text/plain" };
      if (path === `${base}${name}`) return { kind: "file", path: installer, size };
      return;
    },
  };
}

export async function startDesktopReleaseFixture(certificate: DesktopFixtureCertificate, initial: Awaited<ReturnType<typeof createReleaseFixture>>, port = 443) {
  let release = initial;
  const requests: Array<{ host: string; path: string; status: number }> = [];
  const sockets = new Set<Duplex>();
  const server = createServer({ key: certificate.key, cert: certificate.cert, minVersion: "TLSv1.2" }, (request, response) => {
    const host = request.headers.host ?? ""; const path = request.url ?? "";
    const match = release.match(request.method ?? "", host, path);
    if (requests.length >= 1024) { response.writeHead(429); response.end(); return; }
    requests.push({ host, path, status: match ? 200 : 404 });
    if (!match) { response.writeHead(404, { Connection: "close" }); response.end("Closed fixture: unknown request"); return; }
    response.writeHead(200, { "Content-Type": match.kind === "text" ? match.contentType : "application/octet-stream", "Content-Length": match.kind === "text" ? match.body.length : match.size, "Cache-Control": "no-store" });
    if (match.kind === "text") response.end(match.body);
    else void pipeline(createReadStream(match.path), response).catch(() => response.destroy());
  });
  server.headersTimeout = 10_000; server.requestTimeout = 30_000;
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolveListen(); }); });
  return { requests, port: (server.address() as { port: number }).port,
    select(next: Awaited<ReturnType<typeof createReleaseFixture>>) { release = next; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); },
  };
}
