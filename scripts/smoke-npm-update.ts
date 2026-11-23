#!/usr/bin/env bun
/**
 * Native Linux, two-version installed npm acceptance. This never builds or publishes.
 * Both executables must already contain the updater and have different embedded versions.
 * Example:
 * bun scripts/smoke-npm-update.ts --old-bin /private/old/easyresearch --old-version 0.1.23 \
 *   --new-bin /private/new/easyresearch --new-version 0.1.24
 *
 * Node/npm are intentionally present. The independent smoke-release.ts gate still
 * proves standalone Node/Bun absence, Python setup/imports and release acceptance.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync,
  readdirSync, readSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  DAEMON_CONTROL_PATH, DAEMON_TOKEN_HEADER, readServerProcess, stopServerProcess, type ServerProcessRecord,
} from "../src/cli/server-process";
import type { SessionSnapshotDto } from "../src/web/contracts";
import type { UpdateAction, UpdateSnapshot } from "../src/runtime/update-contract";
import {
  createRegistryCertificate, fileDigest, fixtureCommand, fixtureEnvironment, fixtureRuntime,
  MODEL_HOST, packUpdateFixtures, REGISTRY_HOST, startClosedProxy, startFixtureRegistry, waitFixture, withFixtureProxy,
} from "./smoke-npm-update-fixture";

export interface NpmUpdateSmokeOptions {
  oldBin: string; oldVersion: string; newBin: string; newVersion: string; node?: string; timeoutMs: number;
}
const USAGE = "bun scripts/smoke-npm-update.ts --old-bin <native-executable> --old-version <version> --new-bin <native-executable> --new-version <version> [--node <associated-node>] [--timeout-ms <milliseconds>]";
export function parseNpmUpdateSmokeOptions(args: string[]): NpmUpdateSmokeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    assert(["--old-bin", "--old-version", "--new-bin", "--new-version", "--node", "--timeout-ms"].includes(key), `Unknown flag: ${key}\n${USAGE}`);
    const value = args[index + 1];
    assert(value && !value.startsWith("--") && !values.has(key), `Missing or repeated ${key}\n${USAGE}`);
    values.set(key, value);
  }
  for (const key of ["--old-bin", "--old-version", "--new-bin", "--new-version"]) assert(values.has(key), `Required: ${key}\n${USAGE}`);
  const oldVersion = values.get("--old-version")!;
  const newVersion = values.get("--new-version")!;
  for (const version of [oldVersion, newVersion]) assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    && version.split(".").every(part => Number.isSafeInteger(Number(part))), "Exact stable versions are required");
  const oldParts = oldVersion.split(".").map(Number);
  const difference = newVersion.split(".").map((part, index) => Number(part) - oldParts[index]!).find(value => value !== 0);
  assert(difference !== undefined && difference > 0, "The new version must be greater than the old version");
  const timeoutMs = Number(values.get("--timeout-ms") ?? 600_000);
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 30_000 && timeoutMs <= 1_800_000, "timeout-ms must be between 30000 and 1800000");
  return { oldBin: resolve(values.get("--old-bin")!), oldVersion, newBin: resolve(values.get("--new-bin")!), newVersion,
    node: values.get("--node"), timeoutMs };
}

export function assertNativeLinuxExecutable(path: string, arch = process.arch): void {
  assert(process.platform === "linux" && ["x64", "arm64"].includes(arch), "This acceptance harness currently supports native Linux x64/arm64 only");
  assert(statSync(path).isFile() && (statSync(path).mode & 0o111), `Candidate is not executable: ${path}`);
  const fd = openSync(path, "r");
  const header = Buffer.alloc(20);
  try { assert.equal(readSync(fd, header, 0, header.length, 0), header.length); } finally { closeSync(fd); }
  assert.equal(header.subarray(0, 4).toString("hex"), "7f454c46", "Native acceptance requires real ELF executables, not script stand-ins");
  assert.equal(header[4], 2, "Candidate must be ELF64"); assert.equal(header[5], 1, "Candidate must use native little-endian ELF");
  assert.equal(header.readUInt16LE(18), arch === "x64" ? 62 : 183, "Candidate architecture differs from this native host");
}

interface Status { bootId: string; version: string; agentDir: string; homeDir: string; activeSessions: unknown[] }
interface EventFrame { type: string; id?: string; bootId?: string; event?: { type: string; bootId?: string; snapshot?: UpdateSnapshot } }

async function requestJson<T>(base: string, path: string, signal: AbortSignal, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`${base}${path}`, { method, proxy: "", redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert(Buffer.byteLength(text) <= 2 * 1024 * 1024, `Oversized API response: ${path}`);
  return { status: response.status, body: JSON.parse(text) as T };
}

async function requireJson<T>(base: string, path: string, signal: AbortSignal, body?: unknown, expected?: number, method?: string): Promise<T> {
  const result = await requestJson<T>(base, path, signal, body, method);
  assert(expected === undefined ? result.status >= 200 && result.status < 300 : result.status === expected,
    `${path} returned HTTP ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function events(base: string, bootId: string, signal: AbortSignal) {
  const abort = new AbortController();
  const headerTimeout = setTimeout(() => abort.abort(new Error("SSE headers timed out")), 10_000);
  let response: Response;
  try { response = await fetch(`${base}/api/events`, { proxy: "", signal: AbortSignal.any([signal, abort.signal]) }); }
  finally { clearTimeout(headerTimeout); }
  assert(response.ok && response.body, "Multiplexed SSE connection failed");
  const reader = response.body.getReader();
  const frames: EventFrame[] = [];
  let failure: unknown;
  let stopping = false;
  const task = (async () => {
    const decoder = new TextDecoder(); let buffer = "";
    while (true) {
      const next = await reader.read(); if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true }).replaceAll("\r\n", "\n");
      assert(Buffer.byteLength(buffer) < 1024 * 1024, "SSE frame exceeded its bound");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const value = JSON.parse(data) as EventFrame;
        assert.notEqual(value.type, "stream-error", "Logical event source failed");
        assert.equal(value.bootId, bootId, "SSE frame boot identity changed in-place");
        assert(frames.length < 4096, "SSE event bound exceeded"); frames.push(value);
      }
    }
  })().catch(error => { if (!stopping) failure = error; });
  try {
    const connected = await waitFixture("SSE connected frame", () => { if (failure) throw failure; return frames.find(frame => frame.type === "connected"); }, signal);
    await requireJson(base, `/api/events/${connected.id}`, signal, { revision: 1, subscriptions: [
      { id: "config", path: "/api/config/events" }, { id: "update", path: "/api/update/events" },
    ] }, 200, "PUT");
  } catch (error) { stopping = true; abort.abort(); await reader.cancel().catch(() => {}); await task; throw error; }
  return {
    frames,
    updates: () => frames.flatMap(frame => frame.id === "update" && frame.event?.snapshot ? [frame.event.snapshot] : []),
    assertHealthy() { if (failure) throw failure; },
    async close() { stopping = true; abort.abort(); await reader.cancel().catch(() => {}); await task; },
  };
}

function modelFixture(marker: string) {
  let requests = 0; let held = false; let cancelled = false; let failure: unknown;
  let heldResponse: ServerResponse | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const respond = (request: IncomingMessage, response: ServerResponse, target: URL) => {
    void (async () => {
      assert.equal(request.method, "POST"); assert.equal(target.pathname, "/v1/chat/completions");
      let text = "";
      for await (const chunk of request) { text += chunk.toString(); assert(Buffer.byteLength(text) <= 2 * 1024 * 1024, "Model fixture body bound exceeded"); }
      assert(++requests <= 2, "Unexpected inference after terminal update activation");
      const body = JSON.parse(text) as { messages: Array<{ role: string; content: unknown }> };
      const users = body.messages.filter(message => message.role === "user");
      const last = JSON.stringify(users.at(-1)?.content);
      assert(!text.includes("FORBIDDEN_AFTER_ACTIVATION"), "New work crossed the activation fence");
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      if (last.includes(`${marker}:hold`)) {
        assert.equal(requests, 2); held = true; heldResponse = response;
        response.write(": held native provider response\n\n");
        response.once("close", () => { cancelled = true; clearTimeout(timer); });
        timer = setTimeout(() => { failure = new Error("Held model response outlived activation deadline"); response.destroy(); }, 30_000);
        return;
      }
      assert.equal(requests, 1); assert(last.includes(marker), "Unexpected initial history prompt");
      const chunks = [{ delta: { role: "assistant", content: `${marker}:preserved` }, finish_reason: null }, { delta: {}, finish_reason: "stop" }]
        .map(choice => ({ id: "npm-update-history", object: "chat.completion.chunk", created: 1, model: "npm-update", choices: [{ index: 0, ...choice }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      response.end(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
    })().catch(error => { failure = error; response.destroy(); });
  };
  return { respond, get requests() { return requests; }, get held() { return held; }, get cancelled() { return cancelled; },
    assertHealthy() { if (failure) throw failure; }, close() { clearTimeout(timer); heldResponse?.destroy(); } };
}

interface OwnedProcess { pid: number; start: string }
function processIdentity(pid: number): OwnedProcess | undefined {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return undefined;
    return { pid, start: fields[19]! };
  } catch { return undefined; }
}

/** Only inspect environments whose cwd is already inside our newly-created private tree. */
export function fixtureProcesses(root: string): OwnedProcess[] {
  const matches: OwnedProcess[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const cwd = readlinkSync(`/proc/${name}/cwd`);
      if (cwd !== root && !cwd.startsWith(`${root}${sep}`)) continue;
      const environment = readFileSync(`/proc/${name}/environ`, "utf8").split("\0");
      if (!environment.includes(`EASYRESEARCH_NPM_SMOKE_ROOT=${root}`)) continue;
      const identity = processIdentity(Number(name)); if (identity) matches.push(identity);
    } catch { /* Process exited or is inaccessible. */ }
  }
  return matches;
}

async function cleanupNative(root: string, agentDir: string) {
  const record = readServerProcess(agentDir);
  let authenticatedExit = false;
  let exitError: string | undefined;
  if (record.kind === "owned") {
    try { authenticatedExit = await stopServerProcess(agentDir, { expectedOwner: "cli", expectedToken: record.record.token, timeoutMs: 15_000 }); }
    catch (error) { exitError = String(error); }
  }
  const cleanupSignal = AbortSignal.timeout(10_000);
  let forced = 0;
  // Keep scanning across exit/reparenting; do not signal a recycled PID or a real user daemon.
  for (const signal of [undefined, "SIGTERM", "SIGKILL"] as const) {
    const owned = fixtureProcesses(root);
    if (!owned.length) break;
    if (signal) for (const identity of owned) {
      if (processIdentity(identity.pid)?.start !== identity.start) continue;
      try { process.kill(identity.pid, signal); forced++; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    try { await waitFixture("owned fixture processes to exit", () => fixtureProcesses(root).length === 0 ? true : undefined, cleanupSignal, 1500); } catch { /* Escalate below. */ }
  }
  assert.equal(fixtureProcesses(root).length, 0, "Owned native/npm processes survived bounded cleanup");
  return { authenticatedExit, forcedSignals: forced, ...(exitError ? { exitError } : {}) };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

function bundleEvidence(agentDir: string, version: string) {
  const root = join(agentDir, "bundled");
  assert.equal(readFileSync(join(root, ".easyresearch-bundled-version"), "utf8"), version);
  assert.equal(readFileSync(join(agentDir, ".easyresearch-resource-retirement-version"), "utf8"), version);
  const pi = JSON.parse(readFileSync(join(root, "pi", "package.json"), "utf8"));
  assert.equal(pi.version, version); assert.equal(pi.piConfig?.configDir, ".easyresearch");
  for (const resource of ["agents/research-assistant.md", "skills/research-project-workflow/SKILL.md"]) assert(statSync(join(root, resource)).size > 0);
  return { bundledVersion: version, retirementVersion: version, piIdentityVersion: pi.version };
}

async function installedEvidence(prefix: string, version: string, binaryHash: string, launcherHash: string, target: string) {
  const metaRoot = join(prefix, "lib", "node_modules", "easyresearch");
  const meta = JSON.parse(readFileSync(join(metaRoot, "package.json"), "utf8"));
  assert.equal(meta.name, "easyresearch"); assert.equal(meta.version, version);
  assert.equal(realpathSync(join(prefix, "bin", "easyresearch")), join(metaRoot, "launcher.mjs"));
  assert.equal(await fileDigest(join(metaRoot, "launcher.mjs")), launcherHash, "Installed launcher differs from exact fixture launcher");
  const platformManifest = realpathSync(createRequire(join(metaRoot, "launcher.mjs")).resolve(`easyresearch-${target}/package.json`));
  assert(platformManifest.startsWith(`${prefix}/lib/node_modules/`), "Platform package escaped the original prefix");
  const platform = JSON.parse(readFileSync(platformManifest, "utf8"));
  assert.equal(platform.name, `easyresearch-${target}`); assert.equal(platform.version, version);
  assert.equal(meta.optionalDependencies[platform.name], version);
  const binary = join(platformManifest, "..", "bin", "easyresearch");
  assert.equal(await fileDigest(binary), binaryHash, "Installed native bytes differ from supplied candidate");
  return { prefix, metaVersion: meta.version, platformVersion: platform.version, binarySha256: binaryHash };
}

async function readyDaemon(agentDir: string, base: string, signal: AbortSignal, version: string, previous?: ServerProcessRecord) {
  return waitFixture("authenticated daemon readiness", async () => {
    const entry = readServerProcess(agentDir);
    if (entry.kind !== "owned" || (previous && entry.record.token === previous.token)) return undefined;
    const record = entry.record;
    assert.equal(record.owner ?? "cli", "cli"); assert.equal(record.host, "127.0.0.1");
    try {
      const response = await fetch(`${base}${DAEMON_CONTROL_PATH}`, { proxy: "", headers: { [DAEMON_TOKEN_HEADER]: record.token }, signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
      if (!response.ok) return undefined;
      const control = await response.json() as { runtimeId: string };
      assert.equal(control.runtimeId, record.runtimeId);
      const status = await requireJson<Status>(base, "/api/status", signal);
      assert.equal(status.version, version); assert.equal(status.agentDir, agentDir); assert(status.bootId);
      return { record, status };
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      return undefined;
    }
  }, signal, 90_000);
}

export async function runNpmUpdateSmoke(options: NpmUpdateSmokeOptions): Promise<string> {
  for (const path of [options.oldBin, options.newBin]) assertNativeLinuxExecutable(path);
  const runtime = fixtureRuntime(options.node);
  const target = `linux-${process.arch}`;
  const temporaryDirectory = process.env.RUNNER_TEMP ?? (existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir());
  const root = realpathSync(mkdtempSync(join(temporaryDirectory, "easyresearch-npm-update-")));
  const sandbox = join(root, "private fixture"); mkdirSync(sandbox, { mode: 0o700 });
  const report: Record<string, unknown> = { acceptance: "native-linux-two-version-installed-npm", target, status: "running", root,
    standaloneNodeFreeGate: "separate: scripts/smoke-release.ts", python: "intentionally absent; this offline update gate verifies resource bootstrap, not Python acceptance" };
  console.log(`[npm-update-smoke] evidence: ${root}`);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("npm update native acceptance deadline exceeded")), options.timeoutMs);
  const interrupt = () => controller.abort(new Error("npm update native acceptance interrupted"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const signal = controller.signal;
  const env = fixtureEnvironment(sandbox, runtime);
  const agentDir = env.EASYRESEARCH_CODING_AGENT_DIR!;
  const project = join(sandbox, "project");
  const prefix = join(sandbox, "nondefault npm prefix with spaces");
  const bin = join(prefix, "bin", "easyresearch");
  const closers: Array<() => Promise<void>> = [];
  const viewClosers: Array<() => Promise<void>> = [];
  const marker = `NPM_UPDATE_HISTORY_${randomUUID()}`;
  const model = modelFixture(marker);
  let failure: unknown;
  let succeeded = false;
  const persist = () => writeFileSync(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  try {
    const oldHash = await fileDigest(options.oldBin); const newHash = await fileDigest(options.newBin);
    assert.notEqual(oldHash, newHash, "Two distinguishable native executables are required");
    report.candidates = { old: { path: options.oldBin, version: options.oldVersion, sha256: oldHash }, new: { path: options.newBin, version: options.newVersion, sha256: newHash } };
    for (const candidate of [{ executable: options.oldBin, version: options.oldVersion }, { executable: options.newBin, version: options.newVersion }]) {
      assert.equal((await fixtureCommand(candidate.executable, ["--version"], { cwd: project, env, signal, timeoutMs: 15_000 })).trim(), `easyresearch ${candidate.version}`);
    }
    report.nodeVersion = (await fixtureCommand(runtime.node, ["--version"], { cwd: project, env, signal })).trim();
    report.npmVersion = (await fixtureCommand(runtime.node, [runtime.npm, "--version"], { cwd: project, env, signal })).trim();
    const certificate = await createRegistryCertificate(join(sandbox, "tls"), runtime, env, signal);
    const trusted = { ...env, NODE_EXTRA_CA_CERTS: certificate.caPath, npm_config_cafile: certificate.caPath };
    const deny = await startClosedProxy({}); closers.push(deny.close);
    const packingEnv = withFixtureProxy(trusted, deny.url);
    const packages = await packUpdateFixtures({ directory: join(sandbox, "packages"), runtime, env: packingEnv, target, signal,
      candidates: [{ version: options.oldVersion, executable: options.oldBin }, { version: options.newVersion, executable: options.newBin }] });
    const launcherHash = await fileDigest(join(sandbox, "packages", `easyresearch-${options.oldVersion}`, "launcher.mjs"));
    assert.equal(await fileDigest(join(sandbox, "packages", `easyresearch-${options.newVersion}`, "launcher.mjs")), launcherHash);
    report.launcherSha256 = launcherHash;
    report.tarballs = packages.filter(pkg => pkg.native || pkg.name === "easyresearch").map(pkg => ({ name: pkg.name, version: pkg.version, size: pkg.size, sha256: pkg.sha256, integrity: pkg.integrity }));
    const registry = await startFixtureRegistry(certificate, packages, options.newVersion); closers.push(registry.close);
    const all = await startClosedProxy({ registryPort: registry.port }); closers.push(all.close);
    const llm = await startClosedProxy({ http: model.respond }); closers.push(llm.close);
    const search = await startClosedProxy({}); closers.push(search.close);
    report.registryRequests = registry.records; report.proxies = { all: all.records, llm: llm.records, search: search.records, inheritedDeny: deny.records };
    const installerEnv = withFixtureProxy(trusted, all.url);
    // The daemon inherits a fail-closed sentinel route. Only its persisted All setting can reach the registry.
    const daemonEnv = withFixtureProxy(trusted, deny.url);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ httpProxy: all.url, defaultProvider: "npm-update", defaultModel: "npm-update",
      retry: { enabled: false }, easyresearch: { network: { llmProxy: llm.url, searchProxy: search.url }, web: { autoSessionTitle: false },
        agentDefaults: { "research-assistant": { model: "npm-update/npm-update", thinking: "off" } } } }));
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "npm-update": { baseUrl: `http://${MODEL_HOST}/v1`, api: "openai-completions", apiKey: "isolated-fixture-key",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "npm-update", name: "Npm update fixture", contextWindow: 32000, maxTokens: 1024 }] } } }));
    console.log(`[npm-update-smoke] installing old fixture ${options.oldVersion} with real npm`);
    await fixtureCommand(runtime.node, [runtime.npm, "install", "--global", "--prefix", prefix, `easyresearch@${options.oldVersion}`,
      "--registry=https://registry.npmjs.org/", "--ignore-scripts", "--include=optional", "--no-audit", "--no-fund"],
    { cwd: project, env: installerEnv, signal, timeoutMs: 120_000, logFile: join(root, "initial-npm-install.log") });
    report.oldInstallation = await installedEvidence(prefix, options.oldVersion, oldHash, launcherHash, target);
    assert(!existsSync(join(agentDir, "bundled")), "npm install unexpectedly performed first-run setup");
    assert.equal((await fixtureCommand(bin, ["--version"], { cwd: project, env: daemonEnv, signal })).trim(), `easyresearch ${options.oldVersion}`);
    const port = await reservePort(); const base = `http://127.0.0.1:${port}`;
    await fixtureCommand(bin, ["--host", "127.0.0.1", "-p", String(port), "--no-open"], { cwd: project, env: daemonEnv, signal, timeoutMs: 90_000, logFile: join(root, "old-first-run.log") });
    const old = await readyDaemon(agentDir, base, signal, options.oldVersion);
    report.oldBoot = { pid: old.record.pid, bootId: old.status.bootId, runtimeId: old.record.runtimeId, ...bundleEvidence(agentDir, options.oldVersion) };
    assert.equal(old.status.homeDir, env.HOME);
    const oldExecutable = readlinkSync(`/proc/${old.record.pid}/exe`);
    assert(oldExecutable.startsWith(`${agentDir}/bin/`), "Old daemon did not use its owned copied executable");
    assert.equal(await fileDigest(oldExecutable), oldHash);
    const oldOnlyResource = join(agentDir, "bundled", "npm-update-old-only.txt"); writeFileSync(oldOnlyResource, marker);
    const projectMarker = join(project, "history-preservation-marker.txt"); writeFileSync(projectMarker, marker);
    const stream = await events(base, old.status.bootId, signal); viewClosers.push(stream.close);
    report.updateEvents = stream.frames;
    await waitFixture("initial configuration/update SSE snapshots", () => stream.updates().length && stream.frames.some(frame => frame.id === "config" && frame.event?.bootId === old.status.bootId) ? true : undefined, signal);
    const initial = await requireJson<UpdateSnapshot>(base, "/api/update", signal);
    assert.equal(initial.currentVersion, options.oldVersion); assert.equal(initial.owner, "cli");
    assert(initial.manualCommand?.includes(prefix), "Original nondefault npm scope was not resolved");
    assert(initial.manualCommand?.includes("--registry=https://registry.npmjs.org/"));
    const session = await requireJson<{ id: string }>(base, "/api/sessions", signal, { cwd: project });
    await requireJson(base, `/api/sessions/${session.id}/messages`, signal, { message: marker });
    const idle = await waitFixture("persisted native history marker", async () => {
      model.assertHealthy();
      const snapshot = await requireJson<SessionSnapshotDto>(base, `/api/sessions/${session.id}/snapshot`, signal);
      if (snapshot.session.status !== "ready" || !snapshot.session.sessionFile) return undefined;
      return readFileSync(snapshot.session.sessionFile, "utf8").includes(`${marker}:preserved`) ? snapshot : undefined;
    }, signal);
    const historyPath = idle.session.sessionFile!;
    assert(isAbsolute(historyPath) && historyPath.startsWith(`${agentDir}${sep}`));
    const historyPrefix = readFileSync(historyPath);
    const checkBaseline = registry.records.length;
    await requireJson<UpdateSnapshot>(base, "/api/update/action", signal, { action: "check" } satisfies UpdateAction, 202);
    const available = await waitFixture("checked new version", async () => {
      const snapshot = await requireJson<UpdateSnapshot>(base, "/api/update", signal);
      assert.notEqual(snapshot.phase, "failed", snapshot.message);
      return snapshot.phase === "available" ? snapshot : undefined;
    }, signal);
    assert.equal(available.latestVersion, options.newVersion); assert(available.canInstall && available.operationId, available.message);
    assert(registry.records.slice(checkBaseline).some(record => record.path === "/easyresearch/latest" && record.status === 200), "Update metadata did not use the private official-URL registry");
    const operationId = available.operationId;
    const heldTarball = registry.holdTarball(`easyresearch-${target}`, options.newVersion);
    console.log(`[npm-update-smoke] API installing ${options.newVersion}; checking duplicate admission`);
    await requireJson(base, "/api/update/action", signal, { action: "install", operationId }, 202);
    await waitFixture("real npm requesting the new platform tarball", () => heldTarball.hit ? true : undefined, signal);
    const duplicate = await requestJson<{ code: string }>(base, "/api/update/action", signal, { action: "install", operationId });
    assert.equal(duplicate.status, 409); assert.equal(duplicate.body.code, "UPDATE_BUSY");
    heldTarball.release();
    const prepared = await waitFixture("verified prepared candidate", async () => {
      stream.assertHealthy();
      const snapshot = await requireJson<UpdateSnapshot>(base, "/api/update", signal);
      assert.notEqual(snapshot.phase, "failed", snapshot.message);
      return snapshot.phase === "ready" ? snapshot : undefined;
    }, signal, 120_000);
    assert.equal(prepared.operationId, operationId); assert.equal(prepared.currentVersion, options.oldVersion); assert(prepared.canActivate);
    report.newInstallation = await installedEvidence(prefix, options.newVersion, newHash, launcherHash, target);
    assert.equal((await fixtureCommand(bin, ["--version"], { cwd: project, env: daemonEnv, signal })).trim(), `easyresearch ${options.newVersion}`);
    const beforeActivation = await readyDaemon(agentDir, base, signal, options.oldVersion);
    assert.equal(beforeActivation.record.pid, old.record.pid); assert.equal(beforeActivation.record.token, old.record.token);
    assert.equal(beforeActivation.status.bootId, old.status.bootId);
    bundleEvidence(agentDir, options.oldVersion); assert(existsSync(oldOnlyResource), "Installation activated resources before explicit activation");
    const candidateCopies: string[] = [];
    for (const name of readdirSync(join(agentDir, "bin"))) {
      const path = join(agentDir, "bin", name);
      if (statSync(path).isFile() && await fileDigest(path) === newHash) candidateCopies.push(path);
    }
    assert.equal(candidateCopies.length, 1, "Duplicate install staged more than one verified candidate");
    const duplicateReady = await requestJson(base, "/api/update/action", signal, { action: "install", operationId });
    assert.equal(duplicateReady.status, 409);
    await requireJson(base, `/api/sessions/${session.id}/messages`, signal, { message: `${marker}:hold` });
    await waitFixture("active native provider work", () => { model.assertHealthy(); return model.held ? true : undefined; }, signal);
    const busy = await requestJson<{ code: string; activeSessions: number }>(base, "/api/update/action", signal, { action: "activate", operationId });
    assert.equal(busy.status, 409); assert.equal(busy.body.code, "RUNTIME_BUSY"); assert(busy.body.activeSessions > 0);
    assert.equal((await requireJson<UpdateSnapshot>(base, "/api/update", signal)).phase, "ready"); assert(!model.cancelled);
    console.log("[npm-update-smoke] explicitly activating and checking terminal shutdown/new bootstrap");
    const activation = await requireJson<UpdateSnapshot>(base, "/api/update/action", signal, { action: "activate", operationId, force: true }, 202);
    assert.equal(activation.phase, "activating");
    try {
      const fence = await requestJson(base, `/api/sessions/${session.id}/messages`, signal, { message: "FORBIDDEN_AFTER_ACTIVATION" });
      assert([404, 409, 503].includes(fence.status), `New work was admitted after activation: HTTP ${fence.status}`);
      report.admissionFence = { status: fence.status };
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      // A refused/reset old listener is terminal admission, not a successful API request.
      assert(/ECONNRESET|ECONNREFUSED|socket|connection.*(?:closed|refused)/i.test(String(error)), `Unexpected admission probe failure: ${String(error)}`);
      report.admissionFence = { listenerClosed: true };
    }
    const next = await readyDaemon(agentDir, base, signal, options.newVersion, old.record);
    assert.notEqual(next.record.pid, old.record.pid); assert.notEqual(next.record.token, old.record.token);
    assert.notEqual(next.record.runtimeId, old.record.runtimeId); assert.notEqual(next.status.bootId, old.status.bootId);
    assert.equal(next.record.port, old.record.port);
    const stale = await fetch(`${base}${DAEMON_CONTROL_PATH}`, { proxy: "", headers: { [DAEMON_TOKEN_HEADER]: old.record.token }, signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
    assert.equal(stale.status, 404); await stale.text();
    const nextExecutable = readlinkSync(`/proc/${next.record.pid}/exe`);
    assert.equal(nextExecutable, candidateCopies[0]); assert.equal(await fileDigest(nextExecutable), newHash);
    assert(!existsSync(oldOnlyResource), "New-version bootstrap retained the old resource tree");
    report.newBoot = { pid: next.record.pid, bootId: next.status.bootId, runtimeId: next.record.runtimeId, copiedExecutable: nextExecutable,
      nativeSha256: await fileDigest(nextExecutable), credentialsChanged: true, ...bundleEvidence(agentDir, options.newVersion) };
    await waitFixture("old native owner and active provider to stop", () => { model.assertHealthy(); return !processIdentity(old.record.pid) && model.cancelled ? true : undefined; }, signal);
    assert.equal(model.requests, 2, "Terminal activation resumed old inference");
    const savedHistory = readFileSync(historyPath);
    assert(savedHistory.subarray(0, historyPrefix.length).equals(historyPrefix), "Update rewrote existing native history bytes");
    assert(savedHistory.includes(Buffer.from(marker))); assert(!savedHistory.includes(Buffer.from("FORBIDDEN_AFTER_ACTIVATION")));
    assert.equal(readFileSync(projectMarker, "utf8"), marker);
    report.history = { preservedPrefixBytes: historyPrefix.length, bytesAfterTerminalStop: savedHistory.length, markerPreserved: true, projectFilePreserved: true };
    const successorStream = await events(base, next.status.bootId, signal); viewClosers.push(successorStream.close);
    await waitFixture("successor configuration/update SSE snapshots", () => successorStream.updates().some(snapshot => snapshot.currentVersion === options.newVersion)
      && successorStream.frames.some(frame => frame.id === "config" && frame.event?.bootId === next.status.bootId) ? true : undefined, signal);
    report.successorEvents = successorStream.frames;
    const finalUpdate = await requireJson<UpdateSnapshot>(base, "/api/update", signal);
    assert.equal(finalUpdate.currentVersion, options.newVersion); assert.equal(finalUpdate.owner, "cli");
    assert(finalUpdate.manualCommand?.includes(prefix), "Successor lost original npm provenance");
    await waitFixture("SSE phases through explicit activation", () => {
      const phases = stream.updates().map(snapshot => snapshot.phase);
      return ["checking", "available", "installing", "verifying", "ready", "activating"].every(phase => phases.includes(phase as UpdateSnapshot["phase"])) ? phases : undefined;
    }, signal);
    for (const name of ["easyresearch", `easyresearch-${target}`]) {
      const downloads = registry.records.filter(record => record.path === `/${name}/-/${name}-${options.newVersion}.tgz`);
      assert.equal(downloads.length, 1, "Duplicate installation or missing real npm download");
      assert(downloads[0]!.userAgent.startsWith("npm/"), "Candidate download did not come from the real npm client");
    }
    assert(registry.records.every(record => record.method === "GET" && record.status === 200), "Unexpected fixture registry write/foreign request");
    assert(all.records.length > 0 && all.records.every(record => record.allowed && record.target === `${REGISTRY_HOST}:443`));
    assert(llm.records.length === 2 && llm.records.every(record => record.allowed && record.target === MODEL_HOST));
    assert.equal(search.records.length, 0, "npm metadata/install incorrectly used Search routing");
    assert.equal(deny.records.length, 0, "The persisted All route did not override inherited/npm proxy settings");
    assert(!existsSync(join(env.npm_config_prefix!, "lib", "node_modules", "easyresearch")), "Update escaped into the default npm prefix");
    report.assertions = { realNpmInstall: true, originalPrefix: true, duplicateInstallRejected: true, explicitActivation: true,
      busyConfirmation: true, terminalProviderCancellation: true, freshCredentialsAndBoot: true, newResourceBootstrap: true,
      exactNativeBytes: true, sseOldAndNewBoot: true, allVsLlmRouting: true, noSearchRegistryTraffic: true, strictTls: true, publicRegistryForwarding: false };
    succeeded = true;
  } catch (error) { failure = error; report.error = error instanceof Error ? error.stack ?? error.message : String(error); }
  finally {
    clearTimeout(deadline); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    // Close views first, then authenticated Exit. Fixture TLS/proxy/model listeners stay
    // available until every owned native/npm process has settled.
    for (const close of viewClosers.reverse()) { try { await close(); } catch (error) { failure ??= error; } }
    try {
      report.cleanup = await cleanupNative(sandbox, agentDir);
      if (succeeded) assert((report.cleanup as { authenticatedExit: boolean; forcedSignals: number }).authenticatedExit
        && (report.cleanup as { forcedSignals: number }).forcedSignals === 0, "Successful acceptance requires authenticated Exit without kill fallback");
    } catch (error) { failure ??= error; report.cleanupError = String(error); }
    model.close();
    for (const close of closers.reverse()) { try { await close(); } catch (error) { failure ??= error; } }
    try {
      const log = join(agentDir, "logs", "daemon-stderr.log");
      if (existsSync(log)) writeFileSync(join(root, "daemon-stderr.log"), readFileSync(log).subarray(-1024 * 1024), { mode: 0o600 });
      if (!fixtureProcesses(sandbox).length) rmSync(sandbox, { recursive: true, force: true });
    } catch (error) { failure ??= error; }
    report.status = succeeded && !failure ? "passed" : "failed";
    if (failure && !report.error) report.error = String(failure);
    persist();
  }
  if (failure) throw new Error(`Native npm update acceptance failed. Evidence: ${root}`, { cause: failure });
  assert(succeeded);
  console.log(`[npm-update-smoke] PASS ${options.oldVersion} -> ${options.newVersion}; receipt: ${join(root, "report.json")}`);
  return join(root, "report.json");
}

if (import.meta.main) {
  if (process.argv.slice(2).includes("--help")) console.log(USAGE);
  else await runNpmUpdateSmoke(parseNpmUpdateSmokeOptions(process.argv.slice(2)));
}
