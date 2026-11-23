#!/usr/bin/env bun
/**
 * Real Windows two-version NSIS update acceptance, after normal packaged smoke.
 * bun scripts/smoke-desktop-update.ts windows-x64 --old-version 0.1.23
 *   [--fixture <build-update-fixture.json>] [--receipt <outside-checkout.json>]
 *
 * Requires an ephemeral Windows x64 runner, the already accepted current native
 * and Desktop manifests/artifacts, OpenSSL (Git for Windows), and free loopback
 * port 443. Uses temporary CA trust only on a disposable GitHub-hosted runner; no hosts/proxy edits,
 * certificate bypass, fake installer success, product hooks or publication.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { chromium, type Browser, type Page } from "@playwright/test";
import { buildManifestPath, platformPackageDir, releaseDir, repoPackageVersion, type BuildManifest } from "./build";
import { assertNativeDesktopHost, assertWindowsElectronLocales, validateDesktopSidecar, type DesktopBuildManifest } from "./build-desktop";
import { assertExternalFixtureReceipt, buildUpdateFixture, removeUpdateFixture, type UpdateFixtureBuild } from "./build-update-fixture";
import { createDesktopSmokeEnvironment, nsisInstallCommand, verifyDesktopSmokePackages, verifyDesktopSidecarIdentity, verifyPackagedNotice, verifyPackagedSidecar } from "./smoke-desktop-support";
import { resolveSmokePython } from "./smoke-release-support";
import { THIRD_PARTY_NOTICES_FILE } from "./third-party-notices";
import { DESKTOP_ACCESS_HEADER, DESKTOP_SMOKE_USER_DATA_ENV } from "../src/desktop/contracts";
import { DAEMON_CONTROL_PATH, DAEMON_TOKEN_HEADER } from "../src/cli/daemon-control";
import type { DesktopUpdateHandoff, DesktopUpdateReceipt, InstalledDesktopIdentity } from "../src/desktop/update-protocol";
import type { UpdateAction, UpdateActionResult, UpdateSnapshot } from "../src/runtime/update-contract";
import { assertFixtureChild, assertOlderVersion, captureDesktopUpdateFailure, createDesktopFixtureCertificate, createReleaseFixture, desktopCustodyDiagnostic, desktopUpdateFixtureInput, digestFile, findDesktopUpdateLineage, fixtureDiagnosticError, observeFixtureUpdateAction, remainingDesktopRecoveryArtifacts, runFixtureCommand,
  startDesktopReleaseFixture, windowsFixtureTrust, withFixtureTrust } from "./smoke-desktop-update-fixture";
import { assessInstalledWindowEvidence, assertFixtureInstallation, closeRecoveryReleaseDialog, fixtureWindowsProcesses, formatInstalledWindowDiagnostic, installedHostHasNativeMenu, installedWindowEvidence, readBoundedFixtureJson,
  readFixtureServer, requestInstalledHostExit, retainFixtureProcessObservation, stopFixtureWindowsProcesses, windowsInstallationRegistry, withWindowsFixtureRoamingAppData, type NativeWindowOwner, type WindowsFixtureProcess } from "./smoke-desktop-update-windows";
import { smokeAgentText, smokeBackgroundReports } from "./smoke-agent-scenario";
import { selectShell } from "../src/background/shell/process";

const USAGE = "bun scripts/smoke-desktop-update.ts windows-x64 --old-version <older-stable-version> [--fixture <private-fixture.json>] [--receipt <json>]";
export function parseDesktopUpdateSmokeOptions(args: string[]): { oldVersion: string; fixture?: string; receipt?: string } {
  assert(args[0] === "windows-x64", USAGE); const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index]!; const value = args[index + 1];
    assert(["--old-version", "--fixture", "--receipt"].includes(key) && value && !value.startsWith("--") && !values.has(key), USAGE); values.set(key, value);
  }
  assert(values.has("--old-version"), USAGE);
  return { oldVersion: values.get("--old-version")!, fixture: values.get("--fixture"), receipt: values.get("--receipt") };
}

async function waitFor<T>(label: string, read: () => T | undefined | Promise<T | undefined>, timeoutMs = 60_000, interval = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await read(); if (value !== undefined) return value; await new Promise(resolveWait => setTimeout(resolveWait, interval)); }
  throw new Error(`Desktop update gate timed out: ${label} (${timeoutMs}ms)`);
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }

interface NativeStatus { version: string; bootId: string; agentDir: string; homeDir: string }
interface SessionSnapshot { session: { sessionFile: string; status: string; isStreaming: boolean }; timeline: unknown[] }
async function rendererJson<T>(page: Page, path: string, body?: unknown): Promise<T> {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`); return response.json();
  }, { path, body }) as Promise<T>;
}
async function updateAction(page: Page, action: UpdateAction): Promise<UpdateActionResult> {
  return page.evaluate(request => window.easyresearchDesktop!.updateAction!(request), action);
}
function snapshot(result: UpdateActionResult, phase: UpdateSnapshot["phase"]): UpdateSnapshot {
  assert(!("code" in result) && result.phase === phase, `Expected update ${phase}, received ${JSON.stringify(result)}`); return result;
}

async function launchInstalledFixtureHost(options: {
  host: string; env: NodeJS.ProcessEnv; project: string; logPath: string; language?: "fr";
  onSpawn(child: ChildProcess): void; onBrowser(browser: Browser): void;
}): Promise<{ child: ChildProcess; browser: Browser; page: Page }> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") }); const port = probe.port; probe.stop(true);
  // The initial control must exercise native accessibility activation too; the
  // argument-free automatic successor does not inherit Chromium switches.
  const child = spawn(options.host, [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", "--no-proxy-server",
    "--host-resolver-rules=MAP api.github.com 127.0.0.1, MAP github.com 127.0.0.1",
    ...(options.language ? [`--lang=${options.language}`] : [])], { env: options.env, cwd: options.project, stdio: ["ignore", "pipe", "pipe"] });
  options.onSpawn(child); // caller owns cleanup even if startup/CDP fails
  let hostLog = ""; const log = (chunk: Buffer) => { hostLog = (hostLog + chunk.toString()).slice(-64 * 1024); writeFileSync(options.logPath, hostLog); };
  child.stdout?.on("data", log); child.stderr?.on("data", log);
  let spawnError: Error | undefined; child.once("error", error => { spawnError = error; });
  const debugUrl = `http://127.0.0.1:${port}`;
  await waitFor("installed Electron debugger", async () => {
    if (spawnError) throw spawnError; assert(child.exitCode === null && child.signalCode === null, "Installed host exited before debugger readiness");
    try { return (await fetch(`${debugUrl}/json/version`, { signal: AbortSignal.timeout(1000), proxy: "" })).ok ? true : undefined; } catch { return; }
  }, 60_000);
  const browser = await chromium.connectOverCDP(debugUrl); options.onBrowser(browser);
  const page = await waitFor("authenticated installed renderer", async () => {
    const candidate = browser.contexts().flatMap(context => context.pages()).find(page => /^http:\/\/127\.0\.0\.1:\d+\//u.test(page.url()));
    if (!candidate) return;
    try { await candidate.waitForFunction(() => Boolean(window.easyresearchDesktop?.updateSnapshot && document.querySelector("#root")?.childElementCount), undefined, { timeout: 1000 }); return candidate; } catch { return; }
  }, 15 * 60_000);
  page.setDefaultTimeout(30_000);
  return { child, browser, page };
}

async function installedIdentity(installation: string): Promise<InstalledDesktopIdentity> {
  return { hostSha256: await digestFile(join(installation, "EasyResearch.exe")), appSha256: await digestFile(join(installation, "resources", "app.asar")),
    sidecarSha256: await digestFile(join(installation, "resources", "sidecar", "easyresearch.exe")) };
}

async function exitInstalledFixtureHost(pid: number, sidecarPid: number, agentDir: string): Promise<void> {
  await requestInstalledHostExit(pid);
  await waitFor("installed host and owned runtime terminal Exit", () => !alive(pid) && !alive(sidecarPid) && !existsSync(join(agentDir, "server.pid"))
    && !existsSync(join(agentDir, "server.lease")) && !existsSync(join(agentDir, "server.transition.lease")) ? true : undefined, 30_000);
}

function modelFixture(shellPidPath: string, marker: string, logPath: string) {
  let calls = 0; let held = false; let cancelled = false; let failure: unknown;
  let shellReturned = false;
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255,
    async fetch(request) {
      try {
        assert(request.method === "POST" && new URL(request.url).pathname === "/v1/chat/completions", "Unexpected model fixture request");
        const text = await request.text(); assert(text.length < 2 * 1024 * 1024, "Model fixture request exceeded its bound");
        const body = JSON.parse(text) as { messages: Array<{ role: string; content: unknown; tool_call_id?: string }>; tools?: Array<{ function?: { name: string } }> };
        const input = desktopUpdateFixtureInput(body, marker);
        assert(++calls <= 3, "Unexpected inference after terminal update cleanup");
        requests.push({ call: calls, input: input ?? "unrecognized", roles: body.messages.slice(-16).map(message => message.role),
          toolResults: body.messages.filter(message => message.role === "tool").map(message => message.tool_call_id).slice(-8),
          userPreviews: body.messages.filter(message => message.role === "user").slice(-3).map(message => fixtureDiagnosticError(smokeAgentText(message.content).slice(-512))) });
        writeFileSync(logPath, `${requests.map(record => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
        const respond = (delta: unknown, finish: string) => new Response([
          { choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ].map(chunk => `data: ${JSON.stringify({ id: marker, object: "chat.completion.chunk", created: 1, model: "desktop-update", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
        if (input === "history") {
          assert(calls === 1 && !shellReturned, "Unexpected repeated history inference");
          return respond({ role: "assistant", content: `${marker}:preserved` }, "stop");
        }
        assert(input === "active", "Unexpected model prompt");
        if (!shellReturned) {
          assert.equal(calls, 2, "Active fixture work did not follow the verified history turn");
          assert(body.tools?.some(tool => tool.function?.name === "shell"), "Installed root has no managed shell tool"); shellReturned = true;
          const literal = `'${shellPidPath.replaceAll("'", "''")}'`;
          return respond({ role: "assistant", tool_calls: [{ index: 0, id: "update_owned_shell", type: "function", function: { name: "shell", arguments: JSON.stringify({
            command: `[IO.File]::WriteAllText(${literal}, [string]$PID); while($true){Start-Sleep -Seconds 1}`, background: true,
          }) } }] }, "tool_calls");
        }
        assert.equal(calls, 3, "Unexpected shell follow-up inference");
        assert.equal(body.messages.filter(message => message.role === "tool" && message.tool_call_id === "update_owned_shell").length, 1,
          "Native shell follow-up did not retain its exact tool result");
        const terminal = smokeBackgroundReports(body).find(report => report.kind === "shell" && report.state !== "running");
        assert(!terminal, `Native shell ended before update commit: ${terminal ? fixtureDiagnosticError(terminal.text) : ""}`);
        held = true;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: marker, object: "chat.completion.chunk", created: 1, model: "desktop-update", choices: [{ index: 0, delta: { role: "assistant", content: "active update acceptance work" }, finish_reason: null }] })}\n\n`));
            request.signal.addEventListener("abort", () => { cancelled = true; try { controller.close(); } catch { /* Already cancelled. */ } }, { once: true });
          }, cancel() { cancelled = true; },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
      } catch (error) { failure = error; return new Response("Model fixture rejected request", { status: 500 }); }
    },
  });
  return { port: server.port, get held() { return held; }, get cancelled() { return cancelled; }, get calls() { return calls; },
    assertHealthy() { if (failure) throw failure; }, close() { server.stop(true); } };
}

/** Handoffs span preparation. Terminal receipts are optional diagnostic samples, never acceptance gates. */
function observeUpdateReceipts(userData: string) {
  const handoffs = new Map<string, DesktopUpdateHandoff>(); const receipts = new Map<string, DesktopUpdateReceipt>();
  const transitions: Record<string, unknown>[] = []; const last = new Map<string, string>();
  let failure: unknown;
  const scan = () => {
    try {
      const directory = join(userData, "updates"); if (!existsSync(directory)) return;
      const entries = readdirSync(directory); assert(entries.length <= 64, "Updater staging is unbounded");
      for (const name of entries) {
        if (!/^update-[A-Za-z0-9]+$/u.test(name)) continue;
        const path = assertFixtureChild(userData, join(directory, name));
        const handoff = readBoundedFixtureJson<DesktopUpdateHandoff>(join(path, "handoff.json"));
        const receipt = readBoundedFixtureJson<DesktopUpdateReceipt>(join(path, "receipt.json"));
        if (handoff) handoffs.set(path, handoff);
        if (receipt) {
          receipts.set(path, receipt);
          const diagnostic = desktopCustodyDiagnostic(receipt); const encoded = JSON.stringify(diagnostic);
          if (last.get(path) !== encoded) {
            last.set(path, encoded); transitions.push({ directory: path, at: Date.now(), ...diagnostic });
            if (transitions.length > 128) transitions.shift();
          }
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure = error; }
  };
  const timer = setInterval(scan, 25); scan();
  return { handoffs, receipts, diagnostics: () => [...transitions], assertHealthy() { if (failure) throw failure; }, close() { clearInterval(timer); scan(); } };
}

function tlsHandshake(port: number, ca?: Buffer, servername = "api.github.com"): Promise<void> {
  return new Promise((resolveHandshake, reject) => {
    const socket = tlsConnect({ host: "127.0.0.1", port, ca, servername, rejectUnauthorized: true });
    socket.setTimeout(5000, () => socket.destroy(new Error("TLS fixture handshake timeout")));
    socket.once("error", reject); socket.once("secureConnect", () => { socket.destroy(); resolveHandshake(); });
  });
}

async function driveScenario(options: {
  root: string; mode: "rollback" | "upgrade"; old: UpdateFixtureBuild;
  candidateManifest: DesktopBuildManifest; candidateInstaller: string; candidateIdentity: InstalledDesktopIdentity;
  release: Awaited<ReturnType<typeof startDesktopReleaseFixture>>;
}) {
  const { root, mode, old, candidateManifest, release } = options;
  console.log(`[desktop-update] ${mode}: installing private ${old.version}`);
  assert.equal((await windowsInstallationRegistry()).length, 0, "Unexpected existing EasyResearch installation; preserve it and abort");
  const env = createDesktopSmokeEnvironment(root, process.env);
  // Both hosts resolve this directory through the scenario's real Windows
  // RoamingAppData binding, including the ordinary argument-free successor.
  const userData = join(env.APPDATA!, "EasyResearch"); delete env[DESKTOP_SMOKE_USER_DATA_ENV];
  const agentDir = env.EASYRESEARCH_CODING_AGENT_DIR!; const project = join(root, "project");
  const install = join(root, "安装目录 with spaces", "EasyResearch"); const host = join(install, "EasyResearch.exe");
  const installedSidecar = join(install, "resources", "sidecar", "easyresearch.exe");
  const temp = join(root, "tmp"); env.TEMP = temp; env.TMP = temp;
  for (const path of [env.HOME!, env.APPDATA!, env.LOCALAPPDATA!, userData, agentDir, project, temp, dirname(install), env.XDG_CONFIG_HOME!, env.XDG_CACHE_HOME!, env.XDG_DATA_HOME!, env.XDG_STATE_HOME!]) mkdirSync(path, { recursive: true });
  for (const key of Object.keys(env)) if (/proxy|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED/iu.test(key)) delete env[key];
  const python = resolveSmokePython({ explicit: process.env.EASYRESEARCH_SMOKE_PYTHON });
  env.PATH = `${dirname(python)};${env.PATH ?? ""}`; env.PIP_RETRIES = "3"; env.PIP_DEFAULT_TIMEOUT = "30";
  const selectedShell = selectShell("win32", env);
  writeFileSync(join(root, "shell-environment.log"), `${JSON.stringify({ executable: selectedShell.executable, pathKeys: Object.keys(env).filter(key => key.toUpperCase() === "PATH") })}\n`);
  const marker = `desktop-update-${randomUUID()}`; const shellPidPath = join(project, "owned-shell.pid"); const model = modelFixture(shellPidPath, marker, join(root, "model-fixture.log"));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { smoke: { baseUrl: `http://127.0.0.1:${model.port}/v1`, api: "openai-completions", apiKey: "isolated-fixture",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "desktop-update", name: "Desktop update fixture", contextWindow: 256_000, maxTokens: 2048 }] } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "smoke", defaultModel: "desktop-update", retry: { enabled: false },
    easyresearch: { web: { autoSessionTitle: false }, agentDefaults: { "research-assistant": { model: "smoke/desktop-update", thinking: "off" } } } }));
  const observer = observeUpdateReceipts(userData);
  const seen = new Map<number, WindowsFixtureProcess>();
  let liveProcesses: WindowsFixtureProcess[] = [];
  const credentials = new Set<string>(["isolated-fixture"]);
  const diagnosticSecrets = () => [...credentials, ...[...observer.handoffs.values()].map(value => value.token),
    ...[...observer.receipts.values()].flatMap(value => value.successorToken ? [value.successorToken] : [])];
  const installActions: ReturnType<typeof observeFixtureUpdateAction>[] = [];
  let diagnosticPage: Page | undefined;
  let oldHost: ChildProcess | undefined; let browser: Browser | undefined; let installed = false; let successorPid: number | undefined;
  let primary: unknown; let result: Record<string, unknown> | undefined; const cleanupErrors: unknown[] = [];
  type NativeObservation = Parameters<typeof formatInstalledWindowDiagnostic>[0];
  const nativeObservations = new Map<"initial" | "successor", NativeObservation>();
  const persistNativeObservation = (observation: NativeObservation) => {
    writeFileSync(assertFixtureChild(root, join(root, `native-window-${observation.phase}.log`)),
      formatInstalledWindowDiagnostic({ ...observation, secrets: diagnosticSecrets() }), { mode: 0o600 });
  };
  const sampleNativeWindow = async (phase: "initial" | "successor", owner: NativeWindowOwner, canonicalUrl: string) => {
    const previous = nativeObservations.get(phase);
    const observation: NativeObservation = { phase, owner, canonicalUrl, historyText: `${marker}:preserved`, secrets: [],
      // Never merge evidence across another owner or a reused PID. An error may
      // retain only this exact owner's dated last sample, marked historical.
      ...(previous?.owner === owner ? { evidence: previous.evidence, sampledAt: previous.sampledAt } : {}) };
    try {
      const evidence = await installedWindowEvidence(owner);
      observation.evidence = evidence; observation.sampledAt = Date.now();
      return evidence;
    } catch (error) { observation.error = error; throw error; }
    finally { nativeObservations.set(phase, observation); persistNativeObservation(observation); }
  };
  try {
    const installCommand = nsisInstallCommand(old.installer!, install);
    await runFixtureCommand(installCommand.command, ["/S", "/currentuser", installCommand.args.at(-1)!], { env, cwd: project, windowsVerbatimArguments: true, timeoutMs: 180_000, logFile: join(root, "old-install.log") });
    installed = true; await assertFixtureInstallation(install, old.version);
    const oldManifest = JSON.parse(readFileSync(old.desktopManifest!, "utf8")) as DesktopBuildManifest;
    verifyPackagedSidecar(installedSidecar, oldManifest.sidecar, old.version);
    const oldIdentity = await installedIdentity(install);
    const oldLocales = readdirSync(join(install, "locales")).filter(name => name.endsWith(".pak")).sort();
    assert(oldLocales.length > 4 && oldLocales.includes("fr.pak"), "Older real NSIS installation must include stale locale packs");
    const oldLocaleDigests = Object.fromEntries(await Promise.all(["en-US.pak", "en-GB.pak", "zh-CN.pak", "zh-TW.pak"].map(async name => [name, await digestFile(join(install, "locales", name))])));
    const initialLaunch = await launchInstalledFixtureHost({ host, env, project, logPath: join(root, "initial-host.log"),
      onSpawn: child => { oldHost = child; }, onBrowser: connected => { browser = connected; } });
    oldHost = initialLaunch.child; browser = initialLaunch.browser; const page = initialLaunch.page; diagnosticPage = page;
    const initialStatus = await rendererJson<NativeStatus>(page, "/api/status");
    assert.equal(initialStatus.version, old.version); assert.equal(resolve(initialStatus.agentDir).toLowerCase(), resolve(agentDir).toLowerCase());
    const initialRecord = readFixtureServer(agentDir)!; assert(initialRecord && alive(initialRecord.pid));
    credentials.add(initialRecord.token);
    assert.equal(new URL(page.url()).origin, `http://127.0.0.1:${initialRecord.port}`);
    assert.equal(await page.evaluate(() => window.easyresearchDesktop!.version), old.version);
    const cdp = await browser.contexts()[0]!.newCDPSession(page); await cdp.send("Network.enable");
    let oldRendererToken: string | undefined;
    cdp.on("Network.requestWillBeSentExtraInfo", event => { for (const [key, value] of Object.entries(event.headers)) if (key.toLowerCase() === DESKTOP_ACCESS_HEADER) { oldRendererToken = String(value); credentials.add(oldRendererToken); } });
    await rendererJson(page, "/api/status");
    await waitFor("old renderer credential observation", () => oldRendererToken, 10_000);
    await page.evaluate(() => {
      const target = window as unknown as { fixtureUpdates: UpdateSnapshot[]; fixtureUnsubscribe: () => void };
      target.fixtureUpdates = []; target.fixtureUnsubscribe = window.easyresearchDesktop!.onUpdate!(value => target.fixtureUpdates.push(value));
    });
    const created = await rendererJson<{ id: string }>(page, "/api/sessions", { cwd: project });
    const route = `#/work/${encodeURIComponent(created.id)}?cwd=${encodeURIComponent(project)}`;
    await page.evaluate(route => { location.hash = route; }, route);
    await rendererJson(page, `/api/sessions/${encodeURIComponent(created.id)}/messages`, { message: `${marker}:history` });
    const history = await waitFor("real native history", async () => {
      model.assertHealthy(); const value = await rendererJson<SessionSnapshot>(page, `/api/sessions/${encodeURIComponent(created.id)}/snapshot`);
      return value.session.status === "ready" && !value.session.isStreaming && JSON.stringify(value.timeline).includes(`${marker}:preserved`) && existsSync(value.session.sessionFile) ? value : undefined;
    });
    const historyPath = assertFixtureChild(agentDir, history.session.sessionFile); const historyPrefix = readFileSync(historyPath);
    const initialWindowOwner = (await fixtureWindowsProcesses(root)).find(row => row.pid === oldHost!.pid);
    assert(initialWindowOwner && initialWindowOwner.parentPid === process.pid
      && initialWindowOwner.executable.toLowerCase() === realpathSync(host).toLowerCase(), "Initial native window is not the owned installed host");
    const initialUrl = `http://127.0.0.1:${initialRecord.port}/${route}`;
    await waitFor("initial canonical Work/history native accessibility control", async () => {
      const evidence = await sampleNativeWindow("initial", initialWindowOwner, initialUrl);
      const [canonicalUrl, historyVisible] = await Promise.all([
        page.evaluate(expected => location.href === expected, initialUrl),
        page.getByText(`${marker}:preserved`, { exact: true }).isVisible(),
      ]);
      const control = { canonicalUrl, historyVisible };
      const observation = nativeObservations.get("initial")!; observation.control = control; persistNativeObservation(observation);
      const checks = assessInstalledWindowEvidence(evidence, { owner: initialWindowOwner, canonicalUrl: initialUrl, historyText: `${marker}:preserved` });
      return control.canonicalUrl && control.historyVisible && checks.canonicalUrl && checks.historyVisible ? true : undefined;
    }, 60_000, 500);

    if (mode === "rollback") {
      release.select(await createReleaseFixture(candidateManifest.version, options.candidateInstaller, { corruptDigest: true }));
      const available = snapshot(await updateAction(page, { action: "check" }), "available");
      const failed = snapshot(await updateAction(page, { action: "download", operationId: available.operationId! }), "failed");
      assert(failed.message && failed.releaseUrl === "https://github.com/hdu-ailab/EasyResearch/releases/latest");
      assert(alive(oldHost.pid!) && alive(initialRecord.pid), "Checksum rejection stopped the unchanged installed app");
      verifyPackagedSidecar(installedSidecar, oldManifest.sidecar, old.version);
      assert(!existsSync(join(userData, "updates")) || readdirSync(join(userData, "updates")).length === 0, "Rejected download left staging files");
      // A genuine older NSIS executable with valid advertised hash downloads and
      // runs normally, then fails the required NEW installed-version verification.
      // This exercises committed rollback/recovery without a success-returning stub.
      release.select(await createReleaseFixture(candidateManifest.version, old.installer!));
    } else release.select(await createReleaseFixture(candidateManifest.version, options.candidateInstaller));

    const available = snapshot(await updateAction(page, { action: "check" }), "available");
    assert.equal(available.latestVersion, candidateManifest.version);
    const downloaded = snapshot(await updateAction(page, { action: "download", operationId: available.operationId! }), "downloaded");
    assert(downloaded.canInstall && downloaded.bytesReceived === downloaded.bytesTotal && downloaded.bytesTotal! > 0);
    const downloadedDirectory = readdirSync(join(userData, "updates")).find(name => /^update-[A-Za-z0-9]+$/u.test(name)); assert(downloadedDirectory);
    const staging = assertFixtureChild(userData, join(userData, "updates", downloadedDirectory));
    const installerName = `EasyResearch-${candidateManifest.version}-windows-x64.exe`;
    assert.equal(await digestFile(join(staging, installerName)), await digestFile(mode === "upgrade" ? options.candidateInstaller : old.installer!));

    // Start idle, then admit real model/shell work only AFTER preparation begins.
    // The final daemon prepare-update gate must return renewed busy confirmation.
    const activityResponse = await fetch(`http://127.0.0.1:${initialRecord.port}${DAEMON_CONTROL_PATH}`, {
      headers: { [DAEMON_TOKEN_HEADER]: initialRecord.token }, signal: AbortSignal.timeout(5000), proxy: "",
    });
    assert(activityResponse.ok, "Initial authenticated update activity check failed");
    const activity = await activityResponse.json() as { busy?: { code?: string; activeSessions?: number; authFlowActive?: boolean } };
    assert(activity.busy?.code === "RUNTIME_BUSY" && activity.busy.activeSessions === 0 && activity.busy.authFlowActive === false,
      "Late-busy fixture must begin with no active Agent work or authentication flow");
    const firstInstall = observeFixtureUpdateAction(updateAction(page, { action: "install", operationId: downloaded.operationId!, force: false }), diagnosticSecrets);
    installActions.push(firstInstall);
    await waitFor("real helper preparation before late work", () => {
      firstInstall.assertPending("Waiting for helper preparation before late work");
      observer.assertHealthy(); return observer.handoffs.get(staging);
    }, 120_000, 25);
    firstInstall.assertPending("Admitting late work after helper preparation");
    await rendererJson(page, `/api/sessions/${encodeURIComponent(created.id)}/messages`, { message: `${marker}:active` });
    const busy = await firstInstall.result;
    assert("code" in busy && busy.code === "RUNTIME_BUSY" && busy.activeSessions > 0, "Late admitted work did not trigger the final busy gate");
    await waitFor("managed shell and held native model", () => { model.assertHealthy(); return model.held && existsSync(shellPidPath) ? true : undefined; });
    const shellPid = Number(readFileSync(shellPidPath, "utf8").trim()); assert(Number.isSafeInteger(shellPid) && shellPid > 0 && alive(shellPid));
    assert(!model.cancelled && alive(oldHost.pid!) && alive(initialRecord.pid), "Busy refusal disturbed old work");
    await waitFor("precommit helper cleanup", async () => !(await fixtureWindowsProcesses(root)).some(process => process.worker) ? true : undefined, 30_000, 500);
    snapshot(await page.evaluate(() => window.easyresearchDesktop!.updateSnapshot!()), "downloaded");
    assert.equal(await digestFile(join(staging, installerName)), await digestFile(mode === "upgrade" ? options.candidateInstaller : old.installer!));
    for (const secret of diagnosticSecrets()) credentials.add(secret);
    observer.handoffs.clear(); observer.receipts.clear();
    const events = await page.evaluate(() => (window as unknown as { fixtureUpdates: UpdateSnapshot[] }).fixtureUpdates);
    assert(events.some(event => event.phase === "downloading" && (event.bytesReceived ?? 0) > 0), "Actual preload update events lacked download progress");
    console.log(`[desktop-update] ${mode}: confirmed busy installation and native handoff`);
    // Host exit disconnects CDP before IPC can resolve. Native installed state,
    // process lineage, authenticated ownership and rendered Work decide acceptance.
    // Terminal receipt files may already be collected before this process wakes.
    const installing = observeFixtureUpdateAction(updateAction(page, { action: "install", operationId: downloaded.operationId!, force: true }), diagnosticSecrets);
    installActions.push(installing);
    const committed = await waitFor("committed helper handoff", () => {
      observer.assertHealthy(); const handoff = observer.handoffs.get(staging);
      installing.assertInstalling("Waiting for committed helper handoff", handoff !== undefined || !alive(oldHost!.pid!));
      return handoff;
    }, 120_000, 25);
    assert.equal(committed.hostPid, oldHost.pid); assert.equal(committed.hostPath.toLowerCase(), realpathSync(host).toLowerCase());
    assert.equal(committed.oldBootId, initialStatus.bootId); assert.equal(committed.route, route); assert.equal(committed.userDataDir.toLowerCase(), realpathSync(userData).toLowerCase());
    assert.equal(committed.operationId, downloaded.operationId); assert.equal(committed.currentVersion, old.version); assert.equal(committed.version, candidateManifest.version);
    assert.equal(committed.helperSha256, oldManifest.sidecar.sha256);
    assert.deepEqual({ hostSha256: committed.oldHostSha256, appSha256: committed.oldAppSha256, sidecarSha256: committed.oldSidecarSha256 }, oldIdentity);
    let sampling: Promise<void> | undefined; let samplingFailure: unknown;
    const sampleProcesses = () => {
      if (sampling) return;
      sampling = fixtureWindowsProcesses(root, [...seen.values()]).then(values => {
        liveProcesses = values; for (const value of values) seen.set(value.pid, retainFixtureProcessObservation(seen.get(value.pid), value));
        writeFileSync(join(root, "custody-observation.log"), `${JSON.stringify({ receipts: observer.diagnostics(), seen: [...seen.values()], live: liveProcesses })}\n`, { mode: 0o600 });
      })
        .catch(error => { samplingFailure = error; }).finally(() => { sampling = undefined; });
    };
    sampleProcesses();
    const processTimer = setInterval(sampleProcesses, 200);
    let accepted: { record: NonNullable<ReturnType<typeof readFixtureServer>>; lineage: NonNullable<ReturnType<typeof findDesktopUpdateLineage>> };
    try {
      accepted = await waitFor("settled native installer and installed successor", () => {
        installing.assertInstalling("Waiting for installed successor after handoff", true);
        observer.assertHealthy(); model.assertHealthy(); if (samplingFailure) throw samplingFailure;
        const terminal = readBoundedFixtureJson<DesktopUpdateReceipt>(join(staging, "receipt.json"));
        if (terminal?.phase === "failed" && terminal.operationId === downloaded.operationId && terminal.version === candidateManifest.version
          && Number.isSafeInteger(terminal.workerPid) && terminal.workerPid > 0 && !alive(terminal.workerPid) && !terminal.outcome?.recoveryComplete) {
          throw new Error(`Update worker exited before recovery readiness: ${JSON.stringify(desktopCustodyDiagnostic(terminal))}`);
        }
        const record = readFixtureServer(agentDir); if (!record || record.pid === initialRecord.pid) return;
        const lineage = findDesktopUpdateLineage([...seen.values()], { oldHostPid: oldHost!.pid!, sidecarPid: record.pid, host,
          helper: join(staging, "custodian.exe"), installer: join(staging, installerName), sidecar: installedSidecar });
        if (!lineage) return;
        const isLive = (row: WindowsFixtureProcess) => liveProcesses.some(current => current.pid === row.pid && current.start === row.start);
        if (!isLive(lineage.host) || !isLive(lineage.sidecar)) return;
        // Retain observed descendants after parent exit. Only the verified
        // successor's subtree may survive the updater worker and its OS jobs.
        const updaterTree = new Set([lineage.worker.pid]); let added: boolean;
        do {
          added = false;
          for (const row of seen.values()) if (row.pid !== lineage.host.pid && updaterTree.has(row.parentPid) && !updaterTree.has(row.pid)) {
            updaterTree.add(row.pid); added = true;
          }
        } while (added);
        if ([...seen.values()].some(row => updaterTree.has(row.pid) && isLive(row))) return;
        return { record, lineage };
      }, 15 * 60_000, 100);
    } finally { clearInterval(processTimer); await sampling; }
    if (samplingFailure) throw samplingFailure;
    await waitFor("old host, sidecar, model and shell terminal cleanup", () => !alive(oldHost!.pid!) && !alive(initialRecord.pid) && !alive(shellPid) && model.cancelled ? true : undefined, 30_000);
    const { record: successor, lineage } = accepted;
    credentials.add(successor.token);
    assert.equal(readFixtureServer(agentDir)?.token, successor.token, "Observed successor ownership changed before verification");
    assert.notEqual(successor.token, initialRecord.token); assert(alive(successor.pid));
    const successorOrigin = `http://127.0.0.1:${successor.port}`;
    successorPid = lineage.host.pid;
    const control = await fetch(`${successorOrigin}${DAEMON_CONTROL_PATH}`, { headers: { [DAEMON_TOKEN_HEADER]: successor.token }, signal: AbortSignal.timeout(5000), proxy: "" });
    assert(control.ok && (await control.json() as { runtimeId: string }).runtimeId === successor.runtimeId, "Successor did not authenticate its real server record");
    const oldCredential = await fetch(`${successorOrigin}/api/status`, { headers: { [DESKTOP_ACCESS_HEADER]: oldRendererToken! }, signal: AbortSignal.timeout(5000), proxy: "" });
    assert.equal(oldCredential.status, 401, "Successor reused the old renderer credential");
    assert.equal((await fetch(`${successorOrigin}/api/status`, { signal: AbortSignal.timeout(5000), proxy: "" })).status, 401);
    const expectedVersion = mode === "upgrade" ? candidateManifest.version : old.version;
    const expectedSidecar = mode === "upgrade" ? candidateManifest.sidecar : oldManifest.sidecar;
    verifyPackagedSidecar(installedSidecar, expectedSidecar, expectedVersion);
    assert.equal((await runFixtureCommand(installedSidecar, ["--version"], { env, timeoutMs: 15_000 })).trim(), `easyresearch ${expectedVersion}`);
    const expectedIdentity = mode === "upgrade" ? options.candidateIdentity : oldIdentity;
    assert.deepEqual(await installedIdentity(install), expectedIdentity, "Installed host/app/sidecar differ from the independently captured package identity");
    assert.equal(expectedSidecar.sha256, expectedIdentity.sidecarSha256);
    assert.equal(readFileSync(join(agentDir, "bundled", ".easyresearch-bundled-version"), "utf8").trim(), expectedVersion, "Successor did not run its versioned resource setup");
    await assertFixtureInstallation(install, expectedVersion);
    if (mode === "rollback") {
      await waitFor("native recovery Release fallback dialog", async () => await closeRecoveryReleaseDialog(successorPid!) ? true : undefined, 60_000, 500);
      assert.deepEqual(readdirSync(join(install, "locales")).filter(name => name.endsWith(".pak")).sort(), oldLocales);
    } else {
      assertWindowsElectronLocales(install);
      for (const [name, hash] of Object.entries(oldLocaleDigests)) assert.equal(await digestFile(join(install, "locales", name)), hash, "Upgrade changed a retained locale pack");
      verifyPackagedNotice(join(install, "resources", "sidecar", THIRD_PARTY_NOTICES_FILE), join(platformPackageDir("windows-x64"), THIRD_PARTY_NOTICES_FILE));
      assert.notEqual(successor.runtimeId, initialRecord.runtimeId, "Upgrade kept the old native runtime identity");
    }
    const windowEvidence = await waitFor("successor canonical Work document through native accessibility", async () => {
      const evidence = await sampleNativeWindow("successor", lineage.host, `${successorOrigin}/${route}`);
      const checks = assessInstalledWindowEvidence(evidence, { owner: lineage.host, canonicalUrl: `${successorOrigin}/${route}`, historyText: `${marker}:preserved` });
      return checks.canonicalUrl && checks.historyVisible ? evidence : undefined;
    }, 60_000, 500);
    assert(readFileSync(historyPath).subarray(0, historyPrefix.length).equals(historyPrefix), "Update rewrote existing native history");
    await waitFor("updater staging, recovery copies and transition cleanup", () => {
      return (!existsSync(join(userData, "updates")) || readdirSync(join(userData, "updates")).length === 0)
        && remainingDesktopRecoveryArtifacts(install, committed.operationId).length === 0
        && !existsSync(join(agentDir, "server.transition.lease")) ? true : undefined;
    }, 60_000);
    assert.equal(model.calls, 3, "Terminal update replayed model work");

    let unsupportedLocale: Record<string, unknown> | undefined;
    if (mode === "upgrade") {
      // The automatic successor intentionally loses the old host's Chromium
      // flags. Prove fallback on the actual PRUNED installation in a fresh host.
      await exitInstalledFixtureHost(successorPid, successor.pid, agentDir);
      await browser.close().catch(() => {}); browser = undefined;
      assertWindowsElectronLocales(install);
      assert(!existsSync(join(install, "locales", "fr.pak")) && existsSync(join(install, "locales", "en-US.pak")));
      const french = await launchInstalledFixtureHost({ host, env, project, language: "fr", logPath: join(root, "pruned-fr-host.log"),
        onSpawn: child => { successorPid = child.pid; }, onBrowser: connected => { browser = connected; } });
      diagnosticPage = french.page;
      successorPid = french.child.pid!;
      const frenchStatus = await rendererJson<NativeStatus>(french.page, "/api/status");
      assert.equal(frenchStatus.version, candidateManifest.version); assert.notEqual(frenchStatus.bootId, initialStatus.bootId);
      assert.equal(resolve(frenchStatus.agentDir).toLowerCase(), resolve(agentDir).toLowerCase());
      const frenchRecord = readFixtureServer(agentDir)!; assert(frenchRecord && alive(frenchRecord.pid));
      credentials.add(frenchRecord.token);
      assert.notEqual(frenchRecord.token, successor.token); assert.notEqual(frenchRecord.pid, successor.pid);
      const frenchProcesses = await fixtureWindowsProcesses(root, [...seen.values()]);
      for (const row of frenchProcesses) seen.set(row.pid, retainFixtureProcessObservation(seen.get(row.pid), row));
      assert(frenchProcesses.some(row => row.pid === successorPid && row.requestedFrench && row.executable.toLowerCase() === realpathSync(host).toLowerCase()), "Pruned installed host did not actually launch with --lang=fr");
      assert(frenchProcesses.some(row => row.pid === frenchRecord.pid && row.parentPid === successorPid && row.executable.toLowerCase() === realpathSync(installedSidecar).toLowerCase()));
      assert.equal(new URL(french.page.url()).origin, `http://127.0.0.1:${frenchRecord.port}`);
      assert.equal(await french.page.evaluate(() => window.easyresearchDesktop!.version), candidateManifest.version);
      await waitFor("pruned locale host initial update check", async () => {
        const state = await french.page.evaluate(() => window.easyresearchDesktop!.updateSnapshot!());
        return state.phase !== "checking" ? state : undefined;
      });
      await french.page.evaluate(() => {
        const target = window as unknown as { fixtureUpdates: UpdateSnapshot[]; fixtureUnsubscribe: () => void };
        target.fixtureUpdates = []; target.fixtureUnsubscribe = window.easyresearchDesktop!.onUpdate!(value => target.fixtureUpdates.push(value));
      });
      const checked = snapshot(await updateAction(french.page, { action: "check" }), "current");
      assert.equal(checked.currentVersion, candidateManifest.version);
      const frenchEvents = await french.page.evaluate(() => (window as unknown as { fixtureUpdates: UpdateSnapshot[] }).fixtureUpdates);
      assert(frenchEvents.some(event => event.phase === "checking") && frenchEvents.some(event => event.phase === "current"), "Pruned locale host lost functional update bridge events");
      assert.equal(await installedHostHasNativeMenu(successorPid), false, "Pruned locale host restored a native window menu");
      await french.page.bringToFront(); await french.page.keyboard.press("Alt");
      assert.equal(await installedHostHasNativeMenu(successorPid), false, "Alt restored a native menu in the pruned locale host");
      await french.page.evaluate(route => { location.hash = route; }, route);
      await french.page.getByText(`${marker}:preserved`, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
      assertWindowsElectronLocales(install);
      assert.deepEqual(await installedIdentity(install), options.candidateIdentity);
      assert.equal((await runFixtureCommand(installedSidecar, ["--version"], { env, timeoutMs: 15_000 })).trim(), `easyresearch ${candidateManifest.version}`);
      assert(readFileSync(historyPath).subarray(0, historyPrefix.length).equals(historyPrefix)); model.assertHealthy(); assert.equal(model.calls, 3);
      await exitInstalledFixtureHost(successorPid, frenchRecord.pid, agentDir);
      unsupportedLocale = { requestedLanguage: "fr", requestObservedInNativeCommandLine: true, frenchPackAbsent: true, englishFallbackPackPresent: true,
        installedVersion: frenchStatus.version, bootId: frenchStatus.bootId, rendererAndHistoryVisible: true, nativeMenuAbsentBeforeAndAfterAlt: true, updateBridgeFunctional: true, terminalExitVerified: true };
    }
    result = { mode, oldVersion: old.version, installedVersion: expectedVersion, nativeSha256: expectedSidecar.sha256,
      oldLocaleCount: oldLocales.length, installedLocaleCount: readdirSync(join(install, "locales")).length,
      originalDirectoryPreserved: true, terminalModelAndShellCleanup: true, lateBusyReconfirmed: true,
      initialNativeAccessibilityControlVerified: true,
      oldHostExited: true, freshControlCredential: true, oldRendererCredentialRejected: true,
      successorOriginChanged: successor.port !== initialRecord.port, persistedTranscriptRendered: true,
      successorProof: "installed host/app/sidecar hashes; authenticated fresh owner; worker→OS-job→NSIS and worker→host→sidecar lineage; rendered canonical Work/history; worker and installer exit; native staging/transition cleanup",
      processLineage: { workerPid: lineage.worker.pid, guardPid: lineage.guard.pid, installerPid: lineage.installer.pid, hostPid: lineage.host.pid, sidecarPid: lineage.sidecar.pid },
      canonicalRouteObserved: windowEvidence.urls.includes(`${successorOrigin}/${route}`),
      ...(observer.receipts.get(staging) ? { lastSampledReceiptPhase: observer.receipts.get(staging)!.phase } : {}),
      stagingReclaimed: true, recoveryCopiesReclaimed: true, ...(unsupportedLocale ? { unsupportedLocale } : {}),
      ...(mode === "rollback" ? { corruptDownloadRejected: true, recoveryReleaseDialogObserved: true } : {}) };
  } catch (error) {
    try { const current = readFixtureServer(agentDir); if (current) credentials.add(current.token); } catch { /* Diagnostics never require a valid current listener. */ }
    writeFileSync(join(root, "custody-observation.log"), `${JSON.stringify({ receipts: observer.diagnostics(), seen: [...seen.values()], live: liveProcesses })}\n`, { mode: 0o600 });
    primary = new Error(fixtureDiagnosticError(error, diagnosticSecrets()));
    try { for (const observation of nativeObservations.values()) persistNativeObservation(observation); }
    catch (diagnosticError) { cleanupErrors.push(new Error(`Native window evidence capture failed: ${fixtureDiagnosticError(diagnosticError, diagnosticSecrets())}`)); }
    try {
      await captureDesktopUpdateFailure({ root, userData, error, secrets: diagnosticSecrets(), actions: installActions,
        ...(diagnosticPage ? { snapshot: () => diagnosticPage!.evaluate(() => window.easyresearchDesktop!.updateSnapshot!()) } : {}) });
    } catch (diagnosticError) { cleanupErrors.push(new Error(`Update diagnostic capture failed: ${fixtureDiagnosticError(diagnosticError, diagnosticSecrets())}`)); }
  }
  finally {
    observer.close();
    try { if (successorPid && alive(successorPid)) { await requestInstalledHostExit(successorPid); await waitFor("installed host terminal Exit", () => !alive(successorPid!) ? true : undefined, 30_000); } }
    catch (error) { cleanupErrors.push(error); }
    try { await browser?.close(); } catch { /* Old host/CDP already exited by design. */ }
    let processesSettled = false;
    try { await stopFixtureWindowsProcesses(root, [...seen.values()]); processesSettled = true; } catch (error) { cleanupErrors.push(error); }
    model.close();
    try {
      if (processesSettled && (installed || existsSync(host))) {
        // Never invoke an uninstaller if registry custody changed underneath us.
        await assertFixtureInstallation(install);
        const uninstaller = assertFixtureChild(root, join(install, "Uninstall EasyResearch.exe")); assert(existsSync(uninstaller));
        await runFixtureCommand(uninstaller, ["/S", "/currentuser", `_?=${install}`], { env, cwd: project, windowsVerbatimArguments: true, timeoutMs: 180_000, logFile: join(root, "uninstall.log") });
        await waitFor("owned per-user registry cleanup", async () => (await windowsInstallationRegistry()).length === 0 ? true : undefined, 30_000, 500);
      }
    } catch (error) { cleanupErrors.push(error); }
  }
  if (primary || cleanupErrors.length) {
    if (!primary) {
      try { await captureDesktopUpdateFailure({ root, userData, error: new AggregateError(cleanupErrors), secrets: diagnosticSecrets(), actions: installActions }); }
      catch (error) { cleanupErrors.push(new Error(`Update diagnostic capture failed: ${fixtureDiagnosticError(error, diagnosticSecrets())}`)); }
    }
    throw new AggregateError([...(primary ? [primary] : []), ...cleanupErrors.map(error => new Error(fixtureDiagnosticError(error, diagnosticSecrets())))], `Windows ${mode} update acceptance failed; private diagnostics retained at ${root}`);
  }
  return result!;
}

export async function runDesktopUpdateSmoke(options: ReturnType<typeof parseDesktopUpdateSmokeOptions>): Promise<void> {
  assertNativeDesktopHost("windows-x64");
  if (options.receipt) assertExternalFixtureReceipt(dirname(releaseDir()), options.receipt);
  const version = repoPackageVersion(); assertOlderVersion(options.oldVersion, version);
  assert.equal((await windowsInstallationRegistry()).length, 0, "This gate requires an empty ephemeral runner-user installation registry");
  const manifestPath = join(releaseDir(), "desktop-manifest-windows-x64.json");
  const manifestBytes = readFileSync(manifestPath); const nativeManifestBytes = readFileSync(buildManifestPath("windows-x64"));
  const candidateManifest = JSON.parse(manifestBytes.toString()) as DesktopBuildManifest;
  const [candidate] = verifyDesktopSmokePackages(candidateManifest, "windows-x64", version, join(releaseDir(), "desktop")); assert(candidate);
  const nativeBinary = join(platformPackageDir("windows-x64"), "bin", "easyresearch.exe");
  const native = validateDesktopSidecar("windows-x64", JSON.parse(nativeManifestBytes.toString()) as BuildManifest, nativeBinary, version);
  verifyDesktopSidecarIdentity(candidateManifest.sidecar, native);
  // Normal build-desktop leaves this exact payload beside the accepted NSIS.
  // Capture independent host/app hashes before the private older build or install.
  const candidatePayload = join(releaseDir(), "desktop", "win-unpacked");
  verifyPackagedSidecar(join(candidatePayload, "resources", "sidecar", "easyresearch.exe"), native, version);
  const candidateIdentity = await installedIdentity(candidatePayload);
  const root = realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "easyresearch-desktop-update-")));
  console.log(`[desktop-update] private diagnostics: ${root}`);
  let old: UpdateFixtureBuild | undefined; let builtHere = false; let failure: unknown;
  const receiptPath = options.receipt ? resolve(options.receipt) : join(root, "receipt.json");
  let phase = "predecessor-build";
  const progress = (value: string) => { phase = value; console.log(`[desktop-update] ${value}`); };
  try {
    progress("predecessor-build");
    old = options.fixture ? JSON.parse(readFileSync(options.fixture, "utf8")) as UpdateFixtureBuild : await buildUpdateFixture({ target: "windows-x64", version: options.oldVersion, desktop: true, allWindowsLocales: true });
    builtHere = !options.fixture;
    progress("predecessor-verification");
    assert(old.target === "windows-x64" && old.version === options.oldVersion && old.desktopManifest && old.installer && old.allWindowsLocales, "Expected updater-enabled all-locales private Windows fixture");
    assertFixtureChild(old.root, old.installer); assertFixtureChild(old.root, old.nativeBinary);
    const oldDesktop = JSON.parse(readFileSync(old.desktopManifest, "utf8")) as DesktopBuildManifest;
    verifyDesktopSmokePackages(oldDesktop, "windows-x64", old.version, dirname(old.installer));
    const oldNative = validateDesktopSidecar("windows-x64", JSON.parse(readFileSync(old.nativeManifest, "utf8")), old.nativeBinary, old.version);
    verifyDesktopSidecarIdentity(oldDesktop.sidecar, oldNative);
    progress("certificate-generation");
    const certificate = await createDesktopFixtureCertificate(join(root, "tls"));
    writeFileSync(join(root, "fixture-ca-ownership.json"), JSON.stringify({ store: "LocalMachine/Root", thumbprint: certificate.thumbprint }), { mode: 0o600 });
    progress("tls-fixture-start");
    const fixture = await startDesktopReleaseFixture(certificate, await createReleaseFixture(version, candidate.path));
    try {
      // Prove absent trust BEFORE importing into the disposable runner's store.
      await assert.rejects(tlsHandshake(fixture.port));
      progress("certificate-trust");
      await withFixtureTrust(certificate.thumbprint, windowsFixtureTrust(certificate.caPath), async () => {
        // Chromium independently uses the imported Windows root, without any
        // ignore-certificate flags or TLS-setting mutation.
        await assert.rejects(tlsHandshake(fixture.port, certificate.ca, "wrong-host.invalid"));
        await tlsHandshake(fixture.port, certificate.ca, "api.github.com"); await tlsHandshake(fixture.port, certificate.ca, "github.com");
        const results: Record<string, unknown>[] = [];
        for (const mode of ["rollback", "upgrade"] as const) {
          progress(`installed-${mode}`);
          const scenario = join(root, mode); mkdirSync(scenario);
          results.push(await withWindowsFixtureRoamingAppData(scenario,
            () => driveScenario({ root: scenario, mode, old: old!, candidateManifest, candidateInstaller: candidate.path, candidateIdentity, release: fixture })));
        }
        assert(fixture.requests.some(request => request.host === "api.github.com" && request.status === 200), "Installed host did not use the closed official metadata fixture");
        assert(fixture.requests.some(request => request.host === "github.com" && request.path.endsWith(candidate.fileName)), "Installed host did not download the actual candidate NSIS bytes");
        writeFileSync(receiptPath, `${JSON.stringify({ acceptance: "native-windows-two-version-desktop-update", version, candidateInstallerSha256: candidate.sha256, candidateNativeSha256: native.sha256,
          candidateIdentity, fixtureVersion: old!.version, strictTlsAndHostnames: true, results, requests: fixture.requests }, null, 2)}\n`, { mode: 0o600 });
      });
    } finally { await fixture.close(); }
    // Trust cleanup is part of acceptance, after the scenarios, not a best-effort
    // epilogue hidden behind an already-published success receipt.
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")); receipt.fixtureCaRemoved = true;
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  } catch (error) { failure = error; }
  finally {
    const errors: unknown[] = [];
    try {
      assert(readFileSync(manifestPath).equals(manifestBytes), "Accepted Desktop manifest changed");
      assert(readFileSync(buildManifestPath("windows-x64")).equals(nativeManifestBytes), "Accepted native manifest changed");
      assert.equal(await digestFile(candidate.path), candidate.sha256, "Accepted NSIS candidate changed");
      assert.equal(await digestFile(nativeBinary), native.sha256, "Accepted native candidate changed");
      assert.deepEqual(await installedIdentity(candidatePayload), candidateIdentity, "Accepted Desktop payload changed");
    } catch (error) { errors.push(error); }
    try { if (old && builtHere && !failure) await removeUpdateFixture(old); } catch (error) { errors.push(error); }
    // Private keys have no diagnostic value and must not enter an uploaded receipt.
    try { rmSync(join(root, "tls"), { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (failure || errors.length) {
      writeFileSync(receiptPath, `${JSON.stringify({ acceptance: "native-windows-two-version-desktop-update", status: "failed", phase, version,
        error: fixtureDiagnosticError(new AggregateError([...(failure ? [failure] : []), ...errors])),
        candidateInstallerSha256: candidate.sha256, candidateNativeSha256: native.sha256 })}\n`, { mode: 0o600 });
      throw new AggregateError([...(failure ? [failure] : []), ...errors], `Windows Desktop update gate failed during ${phase}; diagnostics: ${root}`);
    }
  }
  console.log(`[desktop-update] native Windows upgrade and rollback passed: ${receiptPath}`);
}

if (import.meta.main) {
  if (process.argv.includes("--help")) console.log(USAGE);
  else await runDesktopUpdateSmoke(parseDesktopUpdateSmokeOptions(process.argv.slice(2)));
}
