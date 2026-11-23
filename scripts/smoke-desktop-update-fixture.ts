/** Private acceptance infrastructure. Never imported by the product runtime. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { closeSync, createReadStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { Duplex } from "node:stream";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { pipeline } from "node:stream/promises";
import type { WindowsFixtureProcess } from "./smoke-desktop-update-windows";
import type { UpdateActionResult } from "../src/runtime/update-contract";
import type { DesktopUpdateReceipt } from "../src/desktop/update-protocol";
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

/** OS process relationships survive removal of the short-lived worker receipt. */
export function findDesktopUpdateLineage(processes: readonly WindowsFixtureProcess[], expected: {
  oldHostPid: number; sidecarPid: number; host: string; helper: string; installer: string; sidecar: string;
}): { worker: WindowsFixtureProcess; guard: WindowsFixtureProcess; installer: WindowsFixtureProcess; host: WindowsFixtureProcess; sidecar: WindowsFixtureProcess } | undefined {
  const samePath = (a: string, b: string) => win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();
  const sidecar = processes.find(row => row.pid === expected.sidecarPid && samePath(row.executable, expected.sidecar));
  const host = sidecar && processes.find(row => row.pid === sidecar.parentPid && row.pid !== expected.oldHostPid && samePath(row.executable, expected.host));
  const worker = host && processes.find(row => row.pid === host.parentPid && row.worker && row.parentPid === expected.oldHostPid && samePath(row.executable, expected.helper));
  if (!sidecar || !host || !worker) return;
  for (const guard of processes.filter(row => row.job && row.parentPid === worker.pid)) {
    const installer = processes.find(row => row.installer && row.parentPid === guard.pid && samePath(row.executable, expected.installer));
    if (installer) return { worker, guard, installer, host, sidecar };
  }
  return;
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

export interface CommandOptions { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; logFile?: string; windowsVerbatimArguments?: boolean; label?: string }
export async function runFixtureCommand(command: string, args: string[], options: CommandOptions = {}): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let failure: Error | undefined; let finished = false;
    let hardDeadline: ReturnType<typeof setTimeout> | undefined;
    const capture = (text: string, chunk: Buffer) => (text + chunk.toString()).slice(-2 * 1024 * 1024);
    child.stdout.on("data", chunk => { stdout = capture(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = capture(stderr, chunk); });
    child.once("error", error => { failure = error; });
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
export async function powershell(script: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 30_000, label = "PowerShell fixture probe"): Promise<string> {
  return runFixtureCommand(powershellExecutable(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
    Buffer.from(`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ${script}`, "utf16le").toString("base64")], { env, timeoutMs, label });
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
