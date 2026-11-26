import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertExternalFixtureReceipt, copyUpdateFixtureSource, parseUpdateFixtureOptions, removeUpdateFixture } from "../../scripts/build-update-fixture";
import { assertFixtureChild, captureDesktopUpdateFailure, createDesktopFixtureCertificate, createReleaseFixture, desktopCustodyDiagnostic, desktopUpdateFixtureInput, desktopUpdateProcessesSettled, findDesktopUpdateLineage, fixtureDiagnosticError, fixtureProcessIdentity, observeFixtureUpdateAction, parseFixtureProcessHistory, powershell, remainingDesktopRecoveryArtifacts, retainFixtureProcessHistory, runFixtureCommand, selectFixtureWindowsProcesses, startDesktopReleaseFixture, windowsFixtureTrust, withFixtureTrust, withFixtureRoamingBinding, type WindowsFixtureProcess } from "../../scripts/smoke-desktop-update-fixture";
import { discoverDesktopRelease, downloadDesktopAsset } from "../desktop/update-download";
import { windowsInstallerRegistryId } from "../desktop/update-worker";
import { assessInstalledRecoveryEvidence, assessInstalledWindowEvidence, assertWindowsFixtureInstallation, closeRecoveryReleaseDialog, fixtureWindowsProcesses, formatInstalledWindowDiagnostic, nativeRecoveryWindowAdmissionControls, parseFixtureWindowsProcesses, projectInstalledRecoveryDiagnostic, retainFixtureProcessObservation, stopFixtureWindowsProcesses, type InstalledRecoveryEvidence, type InstalledRecoveryWindow, type InstalledWindowEvidence } from "../../scripts/smoke-desktop-update-windows";
import { LATEST_RELEASE_PAGE, type UpdateSnapshot } from "./update-contract";
import type { DesktopUpdateReceipt } from "../desktop/update-protocol";

const roots: string[] = [];
function temporary() { const path = realpathSync(mkdtempSync(join(tmpdir(), "er-update-fixture-test-"))); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("recognizes the original update task when native tool context follows its user input", () => {
  const marker = "fixture-unique";
  const messages = [
    { role: "user", content: `${marker}:history` },
    { role: "user", content: [{ type: "text", text: `${marker}:active` }] },
    { role: "tool", tool_call_id: "update_owned_shell", content: "Managed shell is working." },
    { role: "user", content: "<system-reminder>Native background task context.</system-reminder>" },
  ];
  expect(desktopUpdateFixtureInput({ messages }, marker)).toBe("active");
  expect(desktopUpdateFixtureInput({ messages: [messages[0]!, messages[3]!] }, marker)).toBe("history");
  expect(desktopUpdateFixtureInput({ messages: [{ role: "system", content: `${marker}:active` }, messages[3]!] }, marker)).toBeUndefined();
});

it("projects custody progress without publishing private tokens or arbitrary receipt fields", () => {
  const receipt = { phase: "failed", operationId: "private-operation", version: "0.1.24", workerPid: 123, successorToken: "private-successor",
    installerGuardPid: 124, installerSettled: true, recovery: true, arbitrary: "private-extra",
    outcome: { installerAdmitted: true, hostExited: true, rollback: "complete", recoveryComplete: false },
  } as DesktopUpdateReceipt;
  const projected = desktopCustodyDiagnostic(receipt);
  expect(projected).toMatchObject({ phase: "failed", workerPid: 123, installerGuardPid: 124, installerSettled: true,
    outcome: { rollback: "complete", recoveryComplete: false } });
  expect(JSON.stringify(projected)).not.toMatch(/private-operation|private-successor|private-extra/);
});

describe("private older-version source fixture", () => {
  it("requires an explicit native target and older stable version", () => {
    expect(parseUpdateFixtureOptions(["--target", "linux-arm64", "--version", "0.1.23"])).toMatchObject({ target: "linux-arm64", version: "0.1.23", desktop: false });
    for (const args of [[], ["--target", "linux-x64"], ["--target", "linux-x64", "--version", "latest"],
      ["--target", "linux-x64", "--version", "0.1.23", "--desktop"],
      ["--target", "windows-x64", "--version", "0.1.23", "--target", "linux-x64"]]) {
      expect(() => parseUpdateFixtureOptions(args)).toThrow();
    }
  });

  it("copies current working bytes, isolates generated files and only links authoritative docs", async () => {
    const source = join(temporary(), "source"); const parent = temporary();
    for (const path of ["src/generated", "scripts", "node_modules/example", ".docs", "release"]) mkdirSync(join(source, path), { recursive: true });
    const original = '{"name":"easyresearch","private":true,"version":"0.1.24"}\n';
    writeFileSync(join(source, "package.json"), original);
    writeFileSync(join(source, "src/generated/embedded-assets.ts"), "original stub\n");
    writeFileSync(join(source, "src/new.ts"), "uncommitted current code\n");
    writeFileSync(join(source, "node_modules/example/package.json"), '{"name":"example"}');
    writeFileSync(join(source, ".docs/architecture.md"), "authoritative\n");
    writeFileSync(join(source, "release/accepted.exe"), "accepted bytes\n");
    const fixture = await copyUpdateFixtureSource({ source, temporaryDirectory: parent, version: "0.1.23" });
    expect(JSON.parse(readFileSync(join(fixture.source, "package.json"), "utf8")).version).toBe("0.1.23");
    expect(readFileSync(join(source, "package.json"), "utf8")).toBe(original);
    expect(readFileSync(join(fixture.source, "src/new.ts"), "utf8")).toBe("uncommitted current code\n");
    writeFileSync(join(fixture.source, "src/generated/embedded-assets.ts"), "private generated bytes\n");
    expect(readFileSync(join(source, "src/generated/embedded-assets.ts"), "utf8")).toBe("original stub\n");
    expect(existsSync(join(fixture.source, "release"))).toBe(false);
    expect(lstatSync(join(fixture.source, ".docs")).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(fixture.source, ".docs"))).toBe(realpathSync(join(source, ".docs")));
    expect(realpathSync(join(fixture.source, "node_modules/example"))).toBe(realpathSync(join(source, "node_modules/example")));
    mkdirSync(join(fixture.source, "node_modules/.vite-temp"));
    writeFileSync(join(fixture.source, "node_modules/.vite-temp/private-config.mjs"), "private generated config");
    expect(existsSync(join(source, "node_modules/.vite-temp"))).toBe(false);
    await removeUpdateFixture(fixture);
    expect(existsSync(fixture.root)).toBe(false);
    expect(readFileSync(join(source, "release/accepted.exe"), "utf8")).toBe("accepted bytes\n");
    expect(readFileSync(join(source, ".docs/architecture.md"), "utf8")).toBe("authoritative\n");
    expect(readFileSync(join(source, "node_modules/example/package.json"), "utf8")).toBe('{"name":"example"}');
  });

  it("omits only root-private config/env/npm files while preserving nested Skill examples byte-for-byte", async () => {
    const source = temporary(); const parent = temporary();
    mkdirSync(join(source, "node_modules"));
    const examples = "src/skills/fixture/examples"; mkdirSync(join(source, examples), { recursive: true });
    writeFileSync(join(source, "package.json"), '{"name":"easyresearch","version":"0.1.24","private":true}');
    const privateDirectories = [".easyresearch", ".pi", ".lazypaper"];
    const privateFiles = [".env", ".env.local", ".env.production", ".envrc", ".npmrc", ".npmrc.backup"];
    const template = Buffer.from("EXAMPLE_ONLY=placeholder\r\n", "utf8");
    const resource = Buffer.from([0, 255, 128, 10, 13, 42]);
    for (const name of privateDirectories) {
      mkdirSync(join(source, name)); writeFileSync(join(source, name, "settings.json"), '{"private":"fixture-only credential"}');
      mkdirSync(join(source, examples, name)); writeFileSync(join(source, examples, name, "settings.json"), template);
    }
    for (const name of privateFiles) {
      writeFileSync(join(source, name), "PRIVATE_FIXTURE_ONLY=not-a-real-credential");
      writeFileSync(join(source, examples, name), template);
    }
    writeFileSync(join(source, "src/current.ts"), "export const value = 'current working source';\r\n");
    writeFileSync(join(source, examples, "resource.bin"), resource);
    const fixture = await copyUpdateFixtureSource({ source, temporaryDirectory: parent, version: "0.1.23" });
    try {
      for (const name of [...privateDirectories, ...privateFiles]) expect(existsSync(join(fixture.source, name))).toBe(false);
      for (const name of privateDirectories) expect(readFileSync(join(fixture.source, examples, name, "settings.json"))).toEqual(template);
      for (const name of privateFiles) expect(readFileSync(join(fixture.source, examples, name))).toEqual(template);
      expect(readFileSync(join(fixture.source, "src/current.ts"), "utf8")).toBe("export const value = 'current working source';\r\n");
      expect(readFileSync(join(fixture.source, examples, "resource.bin"))).toEqual(resource);
    } finally { await removeUpdateFixture(fixture); }
    expect(readFileSync(join(source, ".npmrc"), "utf8")).toBe("PRIVATE_FIXTURE_ONLY=not-a-real-credential");
  });

  it("skips a private root link before attempting to inspect or copy its target", async () => {
    const source = temporary(); const parent = temporary(); const privateRoot = temporary();
    mkdirSync(join(source, "node_modules")); writeFileSync(join(source, "package.json"), '{"version":"0.1.24"}');
    writeFileSync(join(privateRoot, "auth.json"), "private fixture bytes");
    symlinkSync(privateRoot, join(source, ".easyresearch"), process.platform === "win32" ? "junction" : "dir");
    const fixture = await copyUpdateFixtureSource({ source, temporaryDirectory: parent, version: "0.1.23" });
    try { expect(existsSync(join(fixture.source, ".easyresearch"))).toBe(false); }
    finally { await removeUpdateFixture(fixture); }
    expect(readFileSync(join(privateRoot, "auth.json"), "utf8")).toBe("private fixture bytes");
  });

  it("refuses an in-checkout destination and escaped source links", async () => {
    const source = temporary(); const outside = temporary();
    mkdirSync(join(source, "src")); mkdirSync(join(source, "node_modules"));
    writeFileSync(join(source, "package.json"), '{"version":"2.0.0"}');
    await expect(copyUpdateFixtureSource({ source, temporaryDirectory: source, version: "1.0.0" })).rejects.toThrow(/outside/);
    symlinkSync(outside, join(source, "src/escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(copyUpdateFixtureSource({ source, temporaryDirectory: outside, version: "1.0.0" })).rejects.toThrow(/symbolic|link/);
  });
});

describe("installed update admission diagnostics", () => {
  const state = (phase: UpdateSnapshot["phase"]): UpdateSnapshot => ({ revision: 4, operationId: "fixture-operation", owner: "desktop", phase,
    currentVersion: "0.1.23", latestVersion: "0.1.24", canDownload: false, canInstall: false, canActivate: false, canCancel: false,
    message: "Installation failed. Open latest Release.", releaseUrl: LATEST_RELEASE_PAGE });

  it.each([state("failed"), { code: "RUNTIME_BUSY" as const, activeSessions: 1, authFlowActive: false }])("fails handoff observation as soon as installation returns early: %j", async result => {
    const action = observeFixtureUpdateAction(Promise.resolve(result));
    await action.result;
    expect(() => action.assertPending("before late work")).toThrow(/failed|RUNTIME_BUSY/);
    expect(() => action.assertInstalling("before commit", true)).toThrow(/failed|RUNTIME_BUSY/);
  });

  it("reports rejected admission immediately and permits only the expected host disconnection", async () => {
    const action = observeFixtureUpdateAction(Promise.reject(new Error("custodian preparation rejected")));
    await expect(action.result).rejects.toThrow("custodian preparation rejected");
    expect(() => action.assertPending("before late work")).toThrow(/custodian preparation rejected/);
    expect(() => action.assertInstalling("before commit", false)).toThrow(/custodian preparation rejected/);
    expect(() => action.assertInstalling("after host exit", true)).toThrow(/custodian preparation rejected/);
    const disconnect = observeFixtureUpdateAction(Promise.reject(new Error("Target page, context or browser has been closed")));
    await expect(disconnect.result).rejects.toThrow(/closed/);
    expect(() => disconnect.assertInstalling("before handoff", false)).toThrow(/closed/);
    expect(() => disconnect.assertInstalling("after observed handoff", true)).not.toThrow();
  });

  it("keeps pending admission observable and allows only activating as a completed install acknowledgement", async () => {
    let resolve!: (value: UpdateSnapshot) => void;
    const action = observeFixtureUpdateAction(new Promise<UpdateSnapshot>(done => { resolve = done; }));
    expect(() => action.assertPending("preparing")).not.toThrow();
    resolve(state("activating")); await action.result;
    expect(() => action.assertInstalling("committing", false)).not.toThrow();
    expect(() => action.assertPending("late work must still be late")).toThrow();
  });

  it("preserves the bounded owner-log tail and safe failure before view loss without copying credentials", async () => {
    const root = temporary(); const userData = join(root, "appdata"); const logs = join(userData, "logs"); mkdirSync(logs, { recursive: true });
    const ownerLog = join(logs, "desktop.log"); const token = "t".repeat(43); const credential = "private-fixture-key";
    writeFileSync(ownerLog, "old log data\n".repeat(20_000) + `Desktop update failed: invalid app.asar file\nrendererToken=${token}\nAuthorization: Bearer ${credential}\n`);
    await captureDesktopUpdateFailure({ root, userData, error: new Error(`preparation failed ${token}`, { cause: new Error("raw archive verification failed") }),
      secrets: [token, credential], actions: [],
      snapshot: async () => { unlinkSync(ownerLog); return { ...state("failed"), rendererToken: token, auth: { apiKey: credential } }; },
    });
    const log = readFileSync(join(root, "desktop-owner.log"), "utf8");
    const report = readFileSync(join(root, "update-failure.json"), "utf8");
    expect(Buffer.byteLength(log)).toBeLessThanOrEqual(64 * 1024);
    expect(log).toContain("invalid app.asar file");
    expect(report).toContain("raw archive verification failed");
    expect(JSON.parse(report).snapshot).toMatchObject({ phase: "failed", currentVersion: "0.1.23" });
    for (const text of [log, report]) { expect(text).not.toContain(token); expect(text).not.toContain(credential); }
    expect(report).not.toContain("rendererToken"); expect(report).not.toContain('"auth"');
  });

  it("still records the primary failure when the diagnostic view never answers", async () => {
    const root = temporary(); const userData = join(root, "appdata"); mkdirSync(userData);
    await captureDesktopUpdateFailure({ root, userData, error: new Error("original preparation failure"), secrets: [], actions: [],
      snapshot: () => new Promise(() => {}), snapshotTimeoutMs: 10 });
    const report = JSON.parse(readFileSync(join(root, "update-failure.json"), "utf8"));
    expect(report.error).toContain("original preparation failure");
    expect(report.snapshotError).toMatch(/timed out/);
  });

  it("omits a cut credential line and unlabelled base64url credentials from the owner-log tail", async () => {
    const root = temporary(); const userData = join(root, "appdata"); mkdirSync(join(userData, "logs"), { recursive: true });
    const credential = `-${"b".repeat(41)}_`;
    writeFileSync(join(userData, "logs", "desktop.log"), `Authorization: ${"a".repeat(70_000)}private-fragment\nDesktop update failed: archive read error\n${credential}\n`);
    await captureDesktopUpdateFailure({ root, userData, error: new Error("failed"), secrets: [], actions: [] });
    const log = readFileSync(join(root, "desktop-owner.log"), "utf8");
    expect(log).toContain("archive read error");
    expect(log).not.toContain("private-fragment"); expect(log).not.toContain(credential);
  });
});

describe("closed Desktop Release fixture", () => {
  it("serves the real bounded updater over trusted TLS and refuses missing trust, wrong SAN and unknown paths", async () => {
    const directory = temporary(); const installer = join(directory, "candidate.exe");
    const bytes = Buffer.alloc(96 * 1024, 0x51); writeFileSync(installer, bytes);
    const certificate = await createDesktopFixtureCertificate(join(directory, "tls"));
    const server = await startDesktopReleaseFixture(certificate, await createReleaseFixture("0.1.24", installer), 0);
    const handshake = (ca?: Buffer, servername = "github.com") => new Promise<void>((resolve, reject) => {
      const socket = tlsConnect({ host: "127.0.0.1", port: server.port, servername, ca, rejectUnauthorized: true });
      socket.setTimeout(3000, () => socket.destroy(new Error("TLS deadline")));
      socket.once("error", reject); socket.once("secureConnect", () => { socket.destroy(); resolve(); });
    });
    const fetchFixture = (input: string): Promise<Response> => new Promise((resolve, reject) => {
      const url = new URL(input);
      const request = httpsRequest({ hostname: "127.0.0.1", port: server.port, servername: url.hostname, ca: certificate.ca, rejectUnauthorized: true,
        path: `${url.pathname}${url.search}`, headers: { Host: url.host } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.once("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: { "Content-Length": String(response.headers["content-length"] ?? Buffer.concat(chunks).length) } })));
        response.once("error", reject);
      });
      request.setTimeout(3000, () => request.destroy(new Error("Fixture request deadline")));
      request.once("error", reject); request.end();
    });
    try {
      await expect(handshake()).rejects.toThrow();
      await expect(handshake(certificate.ca, "wrong-host.invalid")).rejects.toThrow();
      await expect(handshake(certificate.ca)).resolves.toBeUndefined();
      expect((await fetchFixture("https://github.com/unknown")).status).toBe(404);
      const candidate = await discoverDesktopRelease("0.1.23", "windows-x64.exe", { fetch: fetchFixture });
      expect(candidate?.version).toBe("0.1.24");
      const download = join(directory, "download"); mkdirSync(download);
      const artifact = await downloadDesktopAsset(candidate!.asset, download, { fetch: fetchFixture });
      expect(readFileSync(artifact.path)).toEqual(bytes);
      server.select(await createReleaseFixture("0.1.24", installer, { corruptDigest: true }));
      const corrupt = await discoverDesktopRelease("0.1.23", "windows-x64.exe", { fetch: fetchFixture });
      const rejected = join(directory, "rejected"); mkdirSync(rejected);
      await expect(downloadDesktopAsset(corrupt!.asset, rejected, { fetch: fetchFixture })).rejects.toThrow(/verification/);
      expect(existsSync(join(rejected, candidate!.asset.name))).toBe(false);
      expect(readFileSync(installer)).toEqual(bytes);
    } finally { await server.close(); }
  }, 30_000);

  it("binds metadata, checksum and installer to the exact official host/path and bytes", async () => {
    const file = join(temporary(), "real-installer-fixture.exe"); const bytes = Buffer.from("not native acceptance: fixture routing bytes");
    writeFileSync(file, bytes);
    const release = await createReleaseFixture("0.1.24", file);
    const metadata = release.match("GET", "api.github.com", "/repos/hdu-ailab/EasyResearch/releases/latest");
    expect(metadata?.kind).toBe("text");
    if (metadata?.kind !== "text") throw new Error("Missing metadata");
    const data = JSON.parse(metadata.body.toString());
    const asset = data.assets.find((item: { name: string }) => item.name.endsWith(".exe"));
    expect(asset.size).toBe(bytes.length);
    expect(asset.digest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    const download = release.match("GET", "github.com", new URL(asset.browser_download_url).pathname);
    expect(download).toMatchObject({ kind: "file", path: file, size: bytes.length });
    expect(release.match("GET", "github.com", "/hdu-ailab/EasyResearch/releases/download/v0.1.24/SHA256SUMS")?.kind).toBe("text");
    for (const [method, host, path] of [
      ["POST", "api.github.com", "/repos/hdu-ailab/EasyResearch/releases/latest"],
      ["GET", "evil.invalid", "/repos/hdu-ailab/EasyResearch/releases/latest"],
      ["GET", "api.github.com:444", "/repos/hdu-ailab/EasyResearch/releases/latest"],
      ["GET", "github.com", "/hdu-ailab/EasyResearch/releases/download/v0.1.24/../secret"],
      ["GET", "github.com", "/hdu-ailab/EasyResearch/releases/download/v0.1.24/%53HA256SUMS"],
      ["GET", "api.github.com", "/repos/hdu-ailab/EasyResearch/releases/latest?forward=1"],
    ]) expect(release.match(method!, host!, path!)).toBeUndefined();
  });

  it("can advertise a deliberately wrong digest without modifying accepted installer bytes", async () => {
    const file = join(temporary(), "candidate.exe"); writeFileSync(file, "immutable candidate");
    const release = await createReleaseFixture("0.1.24", file, { corruptDigest: true });
    const metadata = release.match("GET", "api.github.com", "/repos/hdu-ailab/EasyResearch/releases/latest");
    if (metadata?.kind !== "text") throw new Error("Missing metadata");
    const digest = JSON.parse(metadata.body.toString()).assets[0].digest;
    expect(digest).not.toBe(`sha256:${createHash("sha256").update("immutable candidate").digest("hex")}`);
    expect(readFileSync(file, "utf8")).toBe("immutable candidate");
  });
});

describe("native window evidence", () => {
  const owner = { pid: 123, parentPid: 122, start: "2026-11-24T00:00:00.0000000Z", executable: "C:\\fixture\\EasyResearch.exe" };
  const canonicalUrl = "http://127.0.0.1:12345/#/work/session?cwd=C%3A%5Cfixture";
  const historyText = "desktop-update-01234567-89ab-cdef-0123-456789abcdef:preserved";
  const evidence = (): InstalledWindowEvidence => ({ owner, urls: [canonicalUrl], names: [historyText], texts: ["EasyResearch"],
    windows: [], scan: { handles: 1, accessibleRoots: 1, rootFailures: 0, visited: 2, integerChildren: 1, resolvedIntegerChildren: 0,
      propertyErrors: 0, activationReads: 1, budgetLimited: false, depthLimited: false, valueLimited: false } });

  it("requires exact canonical URL and history from the same verified host sample", () => {
    const expected = { owner, canonicalUrl, historyText };
    expect(assessInstalledWindowEvidence(evidence(), expected)).toMatchObject({ canonicalUrl: true, historyVisible: true, urlStatus: "canonical" });
    for (const url of ["http://127.0.0.1:12345/", canonicalUrl.replace("session", "other"), `${canonicalUrl}/`]) {
      expect(assessInstalledWindowEvidence({ ...evidence(), urls: [url] }, expected)).toMatchObject({ canonicalUrl: false, historyVisible: true, urlStatus: "same-origin-other-route" });
    }
    expect(assessInstalledWindowEvidence({ ...evidence(), urls: [] }, expected).urlStatus).toBe("no-urls");
    expect(assessInstalledWindowEvidence({ ...evidence(), urls: [canonicalUrl.replace("12345", "12346")] }, expected).urlStatus).toBe("other-origin");
    expect(assessInstalledWindowEvidence({ ...evidence(), names: ["other history"] }, expected).historyVisible).toBe(false);
  });

  it("rejects foreign or reused-PID samples instead of carrying their metadata forward", () => {
    for (const change of [{ pid: 124 }, { parentPid: 999 }, { start: "later-creation" }, { executable: "C:\\foreign\\EasyResearch.exe" }]) {
      const foreign = { ...evidence(), owner: { ...owner, ...change } };
      expect(() => assessInstalledWindowEvidence(foreign, { owner, canonicalUrl, historyText })).toThrow(/identity/);
      expect(() => formatInstalledWindowDiagnostic({ phase: "successor", owner, canonicalUrl, historyText, evidence: foreign, secrets: [] })).toThrow(/identity/);
    }
  });

  it("bounds UTF-8 diagnostics after redaction while retaining route and history verdicts", () => {
    const token = "t".repeat(43), secret = "fixture-private-key";
    const raw = { ...evidence(), scan: { ...evidence().scan, privateExtra: token }, names: [historyText, `Authorization: Bearer ${secret}`, token, `handoffToken=${token}`,
      ...Array.from({ length: 300 }, (_, index) => `${index}: ${"界😀".repeat(1000)}`)] };
    const encoded = formatInstalledWindowDiagnostic({ phase: "successor", owner, canonicalUrl, historyText, evidence: raw,
      sampledAt: 1, secrets: [token, secret], control: { canonicalUrl: true, historyVisible: true } });
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(16 * 1024);
    const parsed = JSON.parse(encoded);
    expect(parsed.checks).toMatchObject({ canonicalUrl: true, historyVisible: true });
    expect(parsed.counts.names).toBe(raw.names.length);
    expect(parsed.truncated).toBe(true);
    expect(encoded).not.toContain(token); expect(encoded).not.toContain(secret); expect(encoded).not.toContain("\uFFFD");
    expect(encoded).not.toContain("privateExtra");
    expect(raw.names[2]).toBe(token);
  });

  it("distinguishes a query failure from an empty tree and preserves only its dated prior sample", () => {
    const failed = JSON.parse(formatInstalledWindowDiagnostic({ phase: "successor", owner, canonicalUrl, historyText,
      evidence: evidence(), sampledAt: 123, error: new Error("native query failed"), secrets: [] }));
    expect(failed).toMatchObject({ queryStatus: "failed", sampleIsHistorical: true, sampledAt: 123 });
    expect(failed.checks.canonicalUrl).toBe(true);
    const absent = JSON.parse(formatInstalledWindowDiagnostic({ phase: "initial", owner, canonicalUrl, historyText, error: new Error("query failed"), secrets: [] }));
    expect(absent).toMatchObject({ queryStatus: "failed", sampleIsHistorical: false, checks: { urlStatus: "no-sample", canonicalUrl: false, historyVisible: false } });
  });
});

describe("shared installed recovery dialog", () => {
  const owner = { pid: 123, parentPid: 122, start: "2026-11-25T00:00:00.0000000Z", executable: "C:\\fixture\\EasyResearch.exe" };
  const canonicalUrl = "http://127.0.0.1:12345/#/work/session?cwd=C%3A%5Cfixture";
  const evidence = (): InstalledRecoveryEvidence => ({
    owner, documents: 1, invoked: false, enumerationError: null,
    windows: [{ hwnd: 1001, ownerPid: owner.pid, className: "Chrome_WidgetWin_19", visible: true, admission: "inspected",
      errorOperation: null, win32Error: null, accessibilityResult: 0 }],
    dialogs: [{ documentUrl: canonicalUrl, title: "Updates", notice: "Installation failed. Open latest Release.", releaseUrl: LATEST_RELEASE_PAGE,
      closeButtons: 1, enabledCloseButtons: 1 }],
    scan: { handles: 1, accessibleRoots: 1, rootFailures: 0, visited: 12, integerChildren: 0, resolvedIntegerChildren: 0,
      propertyErrors: 0, activationReads: 12, budgetLimited: false, depthLimited: false, valueLimited: false },
  });

  it("observes canonical document/dialog/notice/link before an independently revalidated accessible Close", async () => {
    const read = vi.fn(async (_owner: typeof owner, _url: string, perform: boolean) => ({ ...evidence(), invoked: perform }));
    const onEvidence = vi.fn();
    expect(await closeRecoveryReleaseDialog(owner, canonicalUrl, { read, onEvidence })).toBe(true);
    expect(read.mock.calls).toEqual([[owner, canonicalUrl, false], [owner, canonicalUrl, true]]);
    expect(onEvidence).toHaveBeenCalledTimes(2);
    // A modal intentionally makes background history inert; history is required
    // by the existing successor gate only after this ordinary Close action.
    expect(assessInstalledRecoveryEvidence(evidence(), owner, canonicalUrl)).toBe(true);
  });

  it.each([
    ["other document", { documentUrl: canonicalUrl.replace("session", "foreign") }],
    ["same-origin wrong route", { documentUrl: "http://127.0.0.1:12345/" }],
    ["foreign origin", { documentUrl: canonicalUrl.replace("12345", "12346") }],
    ["wrong dialog", { title: "Settings" }],
    ["no recovery failure", { notice: "Update failed" }],
    ["missing release link", { releaseUrl: null }],
    ["wrong release target", { releaseUrl: `${LATEST_RELEASE_PAGE}?forward=foreign` }],
    ["missing Close", { closeButtons: 0, enabledCloseButtons: 0 }],
    ["ambiguous Close", { closeButtons: 2 }],
    ["disabled Close", { enabledCloseButtons: 0 }],
  ])("never acts on %s evidence", async (_label, changed) => {
    const sample = evidence(); Object.assign(sample.dialogs[0]!, changed);
    const read = vi.fn(async () => sample);
    expect(await closeRecoveryReleaseDialog(owner, canonicalUrl, { read })).toBe(false);
    expect(read).toHaveBeenCalledExactlyOnceWith(owner, canonicalUrl, false);
  });

  it("refuses ambiguous documents/dialogs and incomplete bounded scans", async () => {
    for (const change of [
      { documents: 0 }, { documents: 2 }, { dialogs: [] }, { dialogs: [evidence().dialogs[0]!, evidence().dialogs[0]!] },
      ...["budgetLimited", "depthLimited", "valueLimited"].map(key => ({ scan: { ...evidence().scan, [key]: true } })),
      ...["rootFailures", "propertyErrors"].map(key => ({ scan: { ...evidence().scan, [key]: 1 } })),
    ]) {
      const read = vi.fn(async () => ({ ...evidence(), ...change }));
      expect(await closeRecoveryReleaseDialog(owner, canonicalUrl, { read })).toBe(false);
      expect(read).toHaveBeenCalledOnce();
    }
  });

  it("retains every bounded HWND admission reason without authorizing a zero-root sample", async () => {
    const base = evidence().windows[0]!;
    const windows: InstalledRecoveryWindow[] = [
      { ...base, admission: "hidden", visible: false, accessibilityResult: null },
      { ...base, hwnd: 1002, admission: "other-class", className: "Electron_NotifyIconHostWindow", accessibilityResult: null },
      { ...base, hwnd: 1003, admission: "foreign-owner", ownerPid: owner.pid + 1, accessibilityResult: null },
      { ...base, hwnd: 1004, admission: "owner-unavailable", ownerPid: 0, className: "", visible: false,
        errorOperation: "owner", win32Error: 1400, accessibilityResult: null },
      { ...base, hwnd: 1005, admission: "class-unavailable", className: "", errorOperation: "class", win32Error: 1400, accessibilityResult: null },
      { ...base, hwnd: 1006, admission: "accessibility-unavailable", accessibilityResult: -2147467259 },
    ];
    const sample = { ...evidence(), documents: 0, dialogs: [], windows,
      scan: { ...evidence().scan, handles: windows.length, accessibleRoots: 0, rootFailures: 1, visited: 0, activationReads: 0 } };
    const read = vi.fn(async () => sample), onEvidence = vi.fn();
    expect(await closeRecoveryReleaseDialog(owner, canonicalUrl, { read, onEvidence })).toBe(false);
    expect(read).toHaveBeenCalledOnce(); expect(onEvidence).toHaveBeenCalledOnce();
    const retained = JSON.parse(fixtureDiagnosticError(JSON.stringify(onEvidence.mock.calls[0]![0])));
    expect(retained.windows).toEqual(windows);
    expect(retained.scan.accessibleRoots).toBe(0);
    expect(retained.windowAdmissions).toMatchObject({ hidden: 1, "other-class": 1, "foreign-owner": 1, "owner-unavailable": 1,
      "class-unavailable": 1, "accessibility-unavailable": 1 });
  });

  it("bounds valid UTF-8 diagnostic JSON while retaining rejection totals and excluding arbitrary native fields", () => {
    const base = evidence();
    const windows = Array.from({ length: 64 }, (_, index) => ({ ...base.windows[0]!, hwnd: 1001 + index, admission: "other-class" as const,
      className: `unknown-${"界".repeat(240)}`, accessibilityResult: null, privateExtra: "never retain" }));
    const raw = { ...base, documents: 0, dialogs: [], windows, scan: { ...base.scan, handles: windows.length, accessibleRoots: 0, visited: 0, activationReads: 0 } };
    const projected = projectInstalledRecoveryDiagnostic(raw);
    const encoded = fixtureDiagnosticError(JSON.stringify(projected));
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(7000);
    const retained = JSON.parse(encoded);
    expect(retained).toMatchObject({ truncated: true, totals: { windows: 64 }, windowAdmissions: { "other-class": 64 } });
    expect(retained.windows.length).toBeGreaterThan(0); expect(retained.windows.length).toBeLessThan(64);
    expect(encoded).not.toContain("privateExtra"); expect(encoded).not.toContain("never retain"); expect(encoded).not.toContain("\uFFFD");
    expect(raw.windows[0]!.className).toBe(windows[0]!.className);
  });

  it("requires an inspected owned visible root even when dialog fields claim success", async () => {
    const sample = evidence();
    for (const change of [
      { windows: [] },
      { windows: [{ ...sample.windows[0]!, admission: "hidden" as const, visible: false, accessibilityResult: null }] },
      { scan: { ...sample.scan, accessibleRoots: 0 } },
      { enumerationError: 5 },
    ]) {
      const read = vi.fn(async () => ({ ...sample, ...change }));
      expect(await closeRecoveryReleaseDialog(owner, canonicalUrl, { read })).toBe(false);
      expect(read).toHaveBeenCalledOnce();
    }
  });

  it("rejects contradictory, unbounded or foreign admitted HWND projections before any action", async () => {
    const base = evidence().windows[0]!;
    for (const change of [
      { windows: [{ ...base, ownerPid: owner.pid + 1 }] },
      { windows: [{ ...base, visible: false }] },
      { windows: [{ ...base, className: "Chrome_WidgetWin_19_other" }] },
      { windows: [{ ...base, className: "Chrome_WidgetWin_019" }] },
      { windows: [{ ...base, className: "Chrome_WidgetWin_2147483648" }] },
      { windows: [{ ...base, admission: "unexpected" }] },
      { windows: [{ ...base, errorOperation: "class", win32Error: 5 }] },
      { windows: [{ ...base, win32Error: "private error" }] },
      { windows: [{ ...base, accessibilityResult: -2147467259 }] },
      { windows: [base, base], scan: { ...evidence().scan, handles: 2 } },
      { windows: Array.from({ length: 65 }, (_, index) => ({ ...base, hwnd: 1001 + index })), scan: { ...evidence().scan, handles: 65 } },
    ]) {
      const read = vi.fn(async () => ({ ...evidence(), ...change }) as InstalledRecoveryEvidence);
      await expect(closeRecoveryReleaseDialog(owner, canonicalUrl, { read })).rejects.toThrow();
      expect(read).toHaveBeenCalledOnce();
    }
  });

  it.skipIf(process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted")(
    "admits real visible Windows counter-class HWNDs while excluding hidden/foreign/child controls", async () => {
      const result = await nativeRecoveryWindowAdmissionControls();
      expect(result.allTopLevelsEnumerated).toBe(true); expect(result.childExcluded).toBe(true);
      const first = result.samples.visibleCounter!, second = result.samples.secondCounter!;
      expect(first.className).not.toBe(second.className);
      for (const sample of [first, second]) {
        expect(sample).toMatchObject({ ownerPid: result.ownerPid, visible: true, admission: "eligible", errorOperation: null, win32Error: null });
        expect(sample.accessibilityResult).toBeNull();
      }
      expect(result.samples.hidden).toMatchObject({ ownerPid: result.ownerPid, visible: false, admission: "hidden" });
      expect(result.samples.otherClass).toMatchObject({ ownerPid: result.ownerPid, visible: true, admission: "other-class" });
      expect(result.samples.foreignOwner).toMatchObject({ ownerPid: result.ownerPid, visible: true, admission: "foreign-owner" });
      expect(result.samples.destroyed).toMatchObject({ admission: "owner-unavailable", errorOperation: "owner" });
      expect(result.samples.destroyed!.win32Error).toBeGreaterThan(0);
    });

  it("rejects reused-PID and foreign-process evidence before any action", async () => {
    for (const change of [{ pid: 124 }, { parentPid: 999 }, { start: "reused" }, { executable: "C:\\foreign\\EasyResearch.exe" }]) {
      const read = vi.fn(async () => ({ ...evidence(), owner: { ...owner, ...change } }));
      await expect(closeRecoveryReleaseDialog(owner, canonicalUrl, { read })).rejects.toThrow(/identity/);
      expect(read).toHaveBeenCalledOnce();
    }
  });

  it("requires fresh valid dialog evidence at the action boundary and never claims an unperformed Close", async () => {
    for (const result of [
      evidence(),
      { ...evidence(), dialogs: [{ ...evidence().dialogs[0]!, enabledCloseButtons: 0 }] },
    ]) {
      const read = vi.fn().mockResolvedValueOnce(evidence()).mockResolvedValueOnce(result);
      expect(await closeRecoveryReleaseDialog(owner, canonicalUrl, { read })).toBe(false);
    }
    const read = vi.fn().mockResolvedValueOnce(evidence()).mockResolvedValueOnce({ ...evidence(), invoked: true, dialogs: [] });
    await expect(closeRecoveryReleaseDialog(owner, canonicalUrl, { read })).rejects.toThrow(/lacked the exact dialog evidence/);
    const replaced = vi.fn().mockResolvedValueOnce(evidence()).mockResolvedValueOnce({ ...evidence(), owner: { ...owner, start: "reused" } });
    await expect(closeRecoveryReleaseDialog(owner, canonicalUrl, { read: replaced })).rejects.toThrow(/identity/);
  });

  it("rejects malformed native projections and an observation that unexpectedly acts", async () => {
    for (const sample of [
      { ...evidence(), documents: -1 },
      { ...evidence(), dialogs: Array.from({ length: 17 }, () => evidence().dialogs[0]!) },
      { ...evidence(), dialogs: [{ ...evidence().dialogs[0]!, title: "x".repeat(8192) }] },
      { ...evidence(), dialogs: [{ ...evidence().dialogs[0]!, closeButtons: 0.5 }] },
      { ...evidence(), scan: { ...evidence().scan, handles: 65537 } },
      { ...evidence(), invoked: true },
    ]) {
      const read = vi.fn(async () => sample);
      await expect(closeRecoveryReleaseDialog(owner, canonicalUrl, { read })).rejects.toThrow();
      expect(read).toHaveBeenCalledOnce();
    }
  });
});

describe("fixture authority boundaries", () => {
  it("detects retained recovery directories across fixed and operation-suffixed layouts", () => {
    const directory = temporary(); const install = join(directory, "安装目录 with spaces");
    const operationId = "01234567-89ab-cdef-0123-456789abcdef";
    mkdirSync(install);
    const leftovers = [
      `${install}.update-backup`, `${install}.update-failed`,
      `${install}.update-backup-${operationId}`, `${install}.update-failed-${operationId}`,
      `${install}.update-backup-previous-operation`,
    ];
    for (const path of leftovers) { mkdirSync(path); writeFileSync(join(path, "retained.exe"), "owned recovery bytes"); }
    mkdirSync(join(directory, "another-install.update-backup"));
    expect(remainingDesktopRecoveryArtifacts(install, operationId).sort()).toEqual([...leftovers].sort());
    for (const path of leftovers) expect(readFileSync(join(path, "retained.exe"), "utf8")).toBe("owned recovery bytes");
    for (const path of leftovers) rmSync(path, { recursive: true });
    expect(remainingDesktopRecoveryArtifacts(install, operationId)).toEqual([]);
    expect(existsSync(join(directory, "another-install.update-backup"))).toBe(true);
  });

  describe("creation-bound Windows update process observations", () => {
    const host = "C:\\fixture\\安装目录 with spaces\\EasyResearch.exe";
    const helper = "C:\\fixture\\userData\\updates\\update-owned\\custodian.exe";
    const installer = "C:\\fixture\\userData\\updates\\update-owned\\EasyResearch-0.1.24-windows-x64.exe";
    const sidecar = "C:\\fixture\\安装目录 with spaces\\resources\\sidecar\\easyresearch.exe";
    const start = (tick: number) => `2026-11-26T08:54:00.${String(tick).padStart(7, "0")}Z`;
    const row = (pid: number, parentPid: number, tick: number, executable: string, role?: "worker" | "job" | "installer"): WindowsFixtureProcess =>
      ({ pid, parentPid, start: start(tick), executable, worker: role === "worker", job: role === "job", installer: role === "installer" });
    function scenario() {
      // Saved-run PID relationships, with private paths and an explicitly
      // controlled old-guard birth (that row was lost from the failed archive).
      const oldHost = row(984, 5240, 1, host), worker = row(2396, 984, 2, helper, "worker");
      const guard = row(6368, 2396, 3, "C:\\Windows\\powershell.exe", "job"), nsis = row(7408, 6368, 4, installer, "installer");
      const recovery = row(2300, 2396, 5, host), native = row(2944, 2300, 6, sidecar), renderer = row(6368, 2300, 7, host);
      const history = new Map<string, WindowsFixtureProcess>();
      retainFixtureProcessHistory(history, [oldHost, worker, guard, nsis]);
      retainFixtureProcessHistory(history, [worker, recovery, native]);
      const live = [recovery, native, renderer]; retainFixtureProcessHistory(history, live);
      return { history, live, oldHost, worker, guard, nsis, recovery, native, renderer,
        options: { oldHost, sidecarPid: native.pid, host, helper, installer, sidecar } };
    }
    it("retains the guard when PID 6368 becomes a successor child, without making that child a live installer descendant", () => {
      const f = scenario(), history = [...f.history.values()];
      const instances = history.filter(value => value.pid === f.guard.pid);
      expect(instances).toHaveLength(2);
      expect(instances.map(fixtureProcessIdentity)).toEqual([fixtureProcessIdentity(f.guard), fixtureProcessIdentity(f.renderer)]);
      const lineage = findDesktopUpdateLineage(history, f.live, f.options)!;
      expect(lineage.guard).toMatchObject({ pid: 6368, start: f.guard.start, job: true });
      expect(lineage.installer.pid).toBe(7408);
      expect(desktopUpdateProcessesSettled(history, f.live, lineage)).toBe(true);
      expect(f.history.get(fixtureProcessIdentity(f.renderer))).toMatchObject({ worker: false, installer: false, job: false, parentStart: f.recovery.start });
      expect(f.live[2]).not.toHaveProperty("parentStart");
      expect(desktopUpdateProcessesSettled(history, [...f.live, f.nsis], lineage)).toBe(false);
    });
    it("allows the worker PID to be reused by the accepted host without reviving its old custody instance", () => {
      const f = scenario();
      const reusedWorker = row(f.worker.pid, f.recovery.pid, 8, host);
      const live = [...f.live, reusedWorker]; retainFixtureProcessHistory(f.history, live);
      const history = [...f.history.values()], lineage = findDesktopUpdateLineage(history, live, f.options)!;
      expect(lineage.worker.start).toBe(f.worker.start);
      expect(desktopUpdateProcessesSettled(history, live, lineage)).toBe(true);
      expect(desktopUpdateProcessesSettled(history, [...f.live, f.worker], lineage)).toBe(false);
      expect(() => selectFixtureWindowsProcesses([f.worker], new Set(), history)).toThrow(/Stale/);
    });
    it("cannot repair the failed archive's missing guard or other incomplete ancestry from a receipt/PID alone", () => {
      const f = scenario(), history = [...f.history.values()];
      for (const missing of [f.guard, f.worker, f.nsis, f.oldHost]) {
        expect(findDesktopUpdateLineage(history.filter(value => fixtureProcessIdentity(value) !== fixtureProcessIdentity(missing)), f.live, f.options)).toBeUndefined();
      }
      expect(findDesktopUpdateLineage(history, f.live, { ...f.options, oldHost: { ...f.oldHost, start: start(0) } })).toBeUndefined();
      expect(findDesktopUpdateLineage(history, [f.recovery, { ...f.native, start: start(8) }, f.renderer], f.options)).toBeUndefined();
      expect(findDesktopUpdateLineage(history, f.live.filter(value => value.pid !== f.recovery.pid), f.options)).toBeUndefined();
      const unbound = history.map(value => fixtureProcessIdentity(value) === fixtureProcessIdentity(f.nsis) ? { ...value, parentStart: undefined } : value);
      expect(findDesktopUpdateLineage(unbound, f.live, f.options)?.guard.start).toBe(f.guard.start);
    });
    it("admits the real sampling order when the old host and worker/host overlaps end before CIM completes", () => {
      const f = scenario(), history = new Map<string, WindowsFixtureProcess>();
      // driveScenario captures the old host before the second install, but its
      // first completed worker sample may arrive only after that host has exited.
      retainFixtureProcessHistory(history, [f.oldHost]);
      retainFixtureProcessHistory(history, [f.worker, f.guard, f.nsis]);
      // The same observation gap can affect the worker -> recovery-host edge.
      retainFixtureProcessHistory(history, [f.recovery, f.native]);
      retainFixtureProcessHistory(history, f.live);
      expect(history.get(fixtureProcessIdentity(f.worker))!.parentStart).toBeUndefined();
      expect(history.get(fixtureProcessIdentity(f.recovery))!.parentStart).toBeUndefined();
      const lineage = findDesktopUpdateLineage([...history.values()], f.live, f.options)!;
      expect(lineage.worker.start).toBe(f.worker.start);
      expect(lineage.guard.start).toBe(f.guard.start);
      expect(desktopUpdateProcessesSettled([...history.values()], f.live, lineage)).toBe(true);
      // There is still no grant if the earlier parent instance was never captured.
      history.delete(fixtureProcessIdentity(f.oldHost));
      expect(findDesktopUpdateLineage([...history.values()], f.live, f.options)).toBeUndefined();
    });
    it("requires the unique historical interval to agree with any explicit parent-start hint", () => {
      const f = scenario();
      const history = [...f.history.values()].map(value => ({ ...value, parentStart: undefined }));
      expect(findDesktopUpdateLineage(history, f.live, f.options)?.guard.start).toBe(f.guard.start);
      const contradictory = history.map(value => value.pid === f.nsis.pid ? { ...value, parentStart: f.worker.start } : value);
      expect(findDesktopUpdateLineage(contradictory, f.live, f.options)).toBeUndefined();
      const boundary = history.map(value => value.pid === f.guard.pid && value.start === f.renderer.start ? { ...value, start: f.nsis.start } : value);
      expect(findDesktopUpdateLineage(boundary, [f.recovery, f.native], f.options)).toBeUndefined();
    });
    it("requires a single installer chain and refuses unresolved live processes outside the accepted host subtree", () => {
      const f = scenario(), history = [...f.history.values()];
      const lineage = findDesktopUpdateLineage(history, f.live, f.options)!;
      const orphan = row(999, 998, 8, "C:\\fixture\\unresolved.exe");
      expect(desktopUpdateProcessesSettled([...history, orphan], [...f.live, orphan], lineage)).toBe(false);
      const another = { ...f.history.get(fixtureProcessIdentity(f.nsis))!, pid: 7409 };
      expect(findDesktopUpdateLineage([...history, another], f.live, f.options)).toBeUndefined();
    });
    it("uses observed parent lifetimes and rejects a replaced parent born before or exactly with the child", () => {
      const f = scenario(), history = [...f.history.values()];
      for (const nextBirth of [f.nsis.start, start(3)]) {
        const conflicting = { ...f.renderer, start: nextBirth, parentStart: undefined };
        const records = history.filter(value => fixtureProcessIdentity(value) !== fixtureProcessIdentity(f.renderer));
        if (nextBirth === f.guard.start) expect(() => findDesktopUpdateLineage([...records, conflicting], f.live, f.options)).toThrow(/Duplicate/);
        else {
          records.push(conflicting);
          expect(findDesktopUpdateLineage(records, [f.recovery, f.native], f.options)).toBeUndefined();
        }
      }
      const laterOnly = history.filter(value => fixtureProcessIdentity(value) !== fixtureProcessIdentity(f.guard));
      expect(findDesktopUpdateLineage(laterOnly, f.live, f.options)).toBeUndefined();
    });
    it("preserves 100ns creation precision and rejects ties, noncanonical timestamps and invalid calendar values", () => {
      const f = scenario();
      // Every fixture birth above falls in the same millisecond.
      expect(Date.parse(f.guard.start)).toBe(Date.parse(f.renderer.start));
      expect(fixtureProcessIdentity(f.guard)).not.toBe(fixtureProcessIdentity(f.renderer));
      expect(parseFixtureProcessHistory(JSON.stringify([f.guard, f.renderer]))).toHaveLength(2);
      const tied = new Map<string, WindowsFixtureProcess>();
      retainFixtureProcessHistory(tied, [f.oldHost, f.worker, { ...f.guard, start: f.worker.start }, f.nsis, f.recovery, f.native]);
      expect(findDesktopUpdateLineage([...tied.values()], [f.recovery, f.native], f.options)).toBeUndefined();
      for (const invalid of ["2026-11-26T08:54:00.000Z", "2026-11-26T08:54:00.0000001+00:00", "2026-02-29T00:00:00.0000000Z",
        "2026-11-31T00:00:00.0000000Z", "2026-11-26T24:00:00.0000000Z", "later-creation"]) {
        expect(() => parseFixtureProcessHistory(JSON.stringify([{ ...f.guard, start: invalid }]))).toThrow(/creation identity/);
      }
    });
    it("keeps current snapshots unique by PID and histories unique by full identity, with bounded atomic retention", () => {
      const f = scenario();
      expect(() => parseFixtureWindowsProcesses(JSON.stringify([f.guard, f.renderer]))).toThrow(/Duplicate/);
      expect(() => parseFixtureProcessHistory(JSON.stringify([f.guard, f.guard]))).toThrow(/Duplicate/);
      const before = [...f.history.entries()];
      expect(() => retainFixtureProcessHistory(f.history, [f.guard, f.renderer])).toThrow(/Duplicate/);
      expect([...f.history.entries()]).toEqual(before);
      const tooMany = Array.from({ length: 4097 }, (_, index) => row(10000 + index, 0, 1, ""));
      expect(() => retainFixtureProcessHistory(f.history, tooMany)).toThrow(/bounded/);
      expect([...f.history.entries()]).toEqual(before);
      const full = new Map<string, WindowsFixtureProcess>();
      retainFixtureProcessHistory(full, tooMany.slice(0, 4096));
      expect(() => retainFixtureProcessHistory(full, [tooMany[4096]!])).toThrow(/history exceeds/);
      expect(full.size).toBe(4096);
    });
    it("preserves partial exact-instance metadata but rejects conflicting parent/path/positive-role evidence", () => {
      const f = scenario(), previous = f.history.get(fixtureProcessIdentity(f.guard))!;
      const partial = { ...f.guard, executable: "", job: false };
      const retained = retainFixtureProcessObservation(previous, partial);
      expect(retained).toMatchObject({ executable: f.guard.executable, job: true, parentStart: f.worker.start });
      expect(partial).toMatchObject({ executable: "", job: false });
      expect(retainFixtureProcessObservation(previous, f.renderer)).toEqual(f.renderer);
      for (const change of [{ parentPid: 999 }, { parentStart: f.oldHost.start }, { executable: "C:\\foreign\\host.exe" }, { worker: true }]) {
        const before = [...f.history.entries()];
        expect(() => retainFixtureProcessHistory(f.history, [{ ...partial, ...change }])).toThrow(/Conflicting/);
        expect([...f.history.entries()]).toEqual(before);
      }
    });
    it("does not grant current descendants an old PID's ownership or a newer/tied parent's ancestry", () => {
      const f = scenario();
      const foreign = { ...f.renderer, executable: "C:\\foreign\\app.exe" }, child = row(998, foreign.pid, 8, "C:\\foreign\\child.exe");
      expect(selectFixtureWindowsProcesses([foreign, child], new Set(), [f.guard])).toEqual([]);
      // A newly owned root cannot adopt an older orphan whose parent reused its PID.
      const olderOrphan = row(997, foreign.pid, 6, "C:\\foreign\\older.exe"), tied = row(996, foreign.pid, 7, "C:\\foreign\\tied.exe");
      const selected = selectFixtureWindowsProcesses([foreign, olderOrphan, tied, child], new Set([fixtureProcessIdentity(foreign)]), [f.guard]);
      expect(selected.map(value => value.pid)).toEqual([foreign.pid, child.pid]);
      expect(selected[0]).toMatchObject({ job: false, worker: false, installer: false });
      expect(selected[1]!.parentStart).toBe(foreign.start);
    });
    it("cleanup accepts multi-lifetime history but signals only freshly owned instances, never a reused foreign PID", async () => {
      const f = scenario(), snapshots = [f.live, [] as WindowsFixtureProcess[]];
      const stop = vi.fn(async (_rows: readonly WindowsFixtureProcess[]) => {}), wait = vi.fn(async () => {});
      const observe = vi.fn(async (_root: string, known: readonly WindowsFixtureProcess[] = []) => {
        expect(known.filter(value => value.pid === f.guard.pid)).toHaveLength(2);
        return selectFixtureWindowsProcesses(snapshots.shift()!, new Set(), known);
      });
      await stopFixtureWindowsProcesses("C:\\fixture", [...f.history.values()], { observe, stop, wait });
      expect(stop).toHaveBeenCalledOnce();
      expect(stop.mock.calls[0]![0].find(value => value.pid === f.guard.pid)!.start).toBe(f.renderer.start);
      const foreign = { ...f.renderer, executable: "C:\\foreign\\app.exe" };
      const neverStop = vi.fn(async () => {});
      await stopFixtureWindowsProcesses("C:\\fixture", [f.guard], {
        observe: async (_root, known) => selectFixtureWindowsProcesses([foreign], new Set(), known ?? []), stop: neverStop, wait,
      });
      expect(neverStop).not.toHaveBeenCalled();
    });

    type CimRow = { ProcessId: number; ParentProcessId: number; CreationDate: string | null; ExecutablePath: string | null; CommandLine: string | null; Name: string | null };
    const cim = (value: WindowsFixtureProcess, inside = false): CimRow => ({ ProcessId: value.pid, ParentProcessId: value.parentPid,
      CreationDate: value.start, ExecutablePath: inside ? "C:\\fixture\\host.exe" : value.executable,
      CommandLine: "", Name: value.job ? "powershell.exe" : "host.exe" });
    const nativeProjection = (rows: CimRow[], known: readonly WindowsFixtureProcess[] = []) => {
      // Execute the actual production observation script against controlled CIM
      // results; this creates no product hook and never signals a real process.
      const query: typeof powershell = (script, env, timeout, label, input) => powershell(`
        $script:controlRows=ConvertFrom-Json $env:ER_FIXTURE_CIM_CONTROL;
        foreach($control in $script:controlRows){
          if($null -ne $control.CreationDate){$control.CreationDate=[DateTime]::ParseExact($control.CreationDate,'o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind)}
        }
        function Get-CimInstance { $script:controlRows }
        ${script}
      `, { ...env, ER_FIXTURE_CIM_CONTROL: JSON.stringify(rows) }, timeout, label, input);
      return fixtureWindowsProcesses("C:\\fixture", known, query);
    };
    it.skipIf(process.platform !== "win32")("native projection through Windows PowerShell handles empty, single and multi-lifetime known arrays without nesting", async () => {
      const oldGuard = row(705, 701, 2, "C:\\Windows\\powershell.exe", "job");
      const owner = row(709, 0, 5, "C:\\outside\\host.exe");
      const reused = row(oldGuard.pid, owner.pid, 6, "C:\\outside\\renderer.exe");
      // None of these current paths independently grants fixture ownership.
      // The repeated PID has distinct exact births; input order is deliberately
      // newest first so the native latest-incarnation comparison is exercised.
      const known = [reused, owner, oldGuard];
      const current = [cim(owner), cim(reused)];
      expect(await nativeProjection([], known)).toEqual([]);
      expect(await nativeProjection(current, [])).toEqual([]);
      const single = await nativeProjection([cim(owner)], [owner]);
      expect(single.map(value => fixtureProcessIdentity(value))).toEqual([fixtureProcessIdentity(owner)]);
      const values = await nativeProjection(current, known);
      expect(values.map(value => value.pid).sort()).toEqual([reused.pid, owner.pid]);
      expect(values.find(value => value.pid === reused.pid)).toMatchObject({
        start: reused.start, parentStart: owner.start, executable: reused.executable, worker: false, installer: false, job: false,
      });
      expect(values.some(value => value.start === oldGuard.start)).toBe(false);
    });
    it.skipIf(process.platform !== "win32")("native projection ignores unrelated unavailable metadata while retaining exact scoped parent births", async () => {
      const owned = row(701, 0, 1, "C:\\fixture\\host.exe"), child = row(705, 701, 2, "C:\\Windows\\powershell.exe", "job");
      const foreign = { ...cim(row(709, 0, 3, "C:\\foreign\\private.exe")), CreationDate: null, CommandLine: "unrelated private metadata" };
      const values = await nativeProjection([cim(owned, true), foreign, cim(child)]);
      expect(values.map(value => value.pid).sort()).toEqual([owned.pid, child.pid]);
      expect(values.find(value => value.pid === child.pid)?.parentStart).toBe(owned.start);
      expect(JSON.stringify(values)).not.toContain("unrelated private metadata");
      expect(values.find(value => value.pid === child.pid)?.start).toBe(child.start);
    });
    it.skipIf(process.platform !== "win32").each(["rooted", "known-reused", "descendant", "ancestor"] as const)(
      "native projection fails closed for unavailable %s creation identity", async kind => {
        const owned = row(701, 0, 1, "C:\\fixture\\host.exe");
        const unknown = { ...cim(row(705, kind === "descendant" ? owned.pid : 0, 2, "C:\\foreign\\host.exe")), CreationDate: null };
        const known = kind === "known-reused" ? [row(705, 0, 1, "C:\\fixture\\prior.exe")] : [];
        let controls: CimRow[];
        if (kind === "rooted") controls = [{ ...cim(owned, true), CreationDate: null }];
        else if (kind === "ancestor") controls = [{ ...cim(owned, true), ParentProcessId: unknown.ProcessId }, unknown];
        else controls = [cim(owned, true), unknown];
        await expect(nativeProjection(controls, known)).rejects.toThrow(/Scoped Windows process creation identity is unavailable/);
      });
    it.skipIf(process.platform !== "win32")("native projection excludes a verified foreign PID reincarnation and its unverified family", async () => {
      const old = row(705, 0, 1, "C:\\fixture\\prior.exe"), foreign = row(705, 0, 2, "C:\\foreign\\new.exe");
      const unknownChild = { ...cim(row(709, foreign.pid, 3, "")), CreationDate: null };
      expect(await nativeProjection([cim(foreign), unknownChild], [old])).toEqual([]);
    });
    it.skipIf(process.platform !== "win32")("native projection rejects exact 100ns ties and excludes children older than a reused current parent", async () => {
      const owned = row(701, 0, 7, "C:\\fixture\\host.exe"), older = row(705, owned.pid, 6, "C:\\foreign\\old-child.exe");
      expect((await nativeProjection([cim(owned, true), cim(older)])).map(value => value.pid)).toEqual([owned.pid]);
      await expect(nativeProjection([cim(owned, true), { ...cim(older), CreationDate: owned.start }])).rejects.toThrow(/Ambiguous Windows parent creation identity/);
    });
  });

  it("streams bounded observation input without environment-size truncation or input disclosure", async () => {
    const input = JSON.stringify(Array.from({ length: 2000 }, (_, index) => ({ pid: 10000 + index, start: "2026-11-26T08:54:00.0000001Z" })));
    expect(Buffer.byteLength(input)).toBeGreaterThan(32767);
    const result = await runFixtureCommand(process.execPath, ["-e",
      "let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>data+=part);process.stdin.on('end',()=>process.stdout.write(String(JSON.parse(data).length)));"],
    { input });
    expect(result).toBe("2000");
    await expect(runFixtureCommand("must-not-spawn", [], { input: "x".repeat(2 * 1024 * 1024 + 1) })).rejects.toThrow(/input exceeds its bound/);
  });

  it("does not allow a receipt to replace candidate source or an escaped link", () => {
    const source = temporary(); const external = temporary();
    writeFileSync(join(source, "package.json"), "accepted package");
    expect(() => assertExternalFixtureReceipt(source, join(source, "package.json"))).toThrow(/outside/);
    expect(() => assertExternalFixtureReceipt(source, join(external, "receipt.json"))).not.toThrow();
    symlinkSync(source, join(external, "redirect"), process.platform === "win32" ? "junction" : "dir");
    expect(() => assertExternalFixtureReceipt(source, join(external, "redirect/package.json"))).toThrow(/outside/);
    expect(readFileSync(join(source, "package.json"), "utf8")).toBe("accepted package");
  });

  it("times out and settles a real owned command rather than leaving it running", async () => {
    const directory = temporary(); const pidFile = join(directory, "child.pid");
    const execution = runFixtureCommand(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`], { cwd: directory, timeoutMs: 1000 });
    await expect(execution).rejects.toThrow(/timed out/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);

  it("rejects sibling-prefix, root and link escapes before cleanup", () => {
    const parent = temporary(); const other = temporary(); mkdirSync(join(parent, "owned"));
    expect(assertFixtureChild(parent, join(parent, "owned"))).toBe(realpathSync(join(parent, "owned")));
    for (const path of [parent, `${parent}-other`, other]) expect(() => assertFixtureChild(parent, path)).toThrow();
    symlinkSync(other, join(parent, "escape"), process.platform === "win32" ? "junction" : "dir");
    expect(() => assertFixtureChild(parent, join(parent, "escape"))).toThrow();
  });

  it("removes only its exact CA after success, body failure and partial import failure", async () => {
    for (const stage of ["ok", "body", "import"]) {
      const certificates = new Set(["unrelated-user-root"]);
      const thumbprint = "A".repeat(40);
      const operation = withFixtureTrust(thumbprint, {
        async contains(value) { return certificates.has(value); },
        async add(value) { certificates.add(value); if (stage === "import") throw new Error("partial import"); },
        async remove(value) { certificates.delete(value); },
      }, async () => { if (stage === "body") throw new Error("fixture failed"); return "done"; });
      if (stage === "ok") await expect(operation).resolves.toBe("done"); else await expect(operation).rejects.toThrow();
      expect([...certificates]).toEqual(["unrelated-user-root"]);
    }
  });

  it("preserves an existing certificate and surfaces failed CA removal", async () => {
    const thumbprint = "B".repeat(40); const certificates = new Set([thumbprint]);
    const store = { async contains(value: string) { return certificates.has(value); }, async add(value: string) { certificates.add(value); }, async remove(value: string) { certificates.delete(value); } };
    await expect(withFixtureTrust(thumbprint, store, async () => "unused")).rejects.toThrow(/already/);
    expect(certificates.has(thumbprint)).toBe(true);
    certificates.clear();
    await expect(withFixtureTrust(thumbprint, { ...store, async remove() { throw new Error("trust cleanup failed"); } }, async () => "done")).rejects.toThrow(/cleanup/);
  });

  it("admits machine trust only on a disposable GitHub-hosted Windows runner", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      for (const [actions, runner] of [[undefined, undefined], ["true", "self-hosted"], ["false", "github-hosted"]]) {
        vi.stubEnv("GITHUB_ACTIONS", actions); vi.stubEnv("RUNNER_ENVIRONMENT", runner);
        expect(() => windowsFixtureTrust("unused fixture certificate")).toThrow(/GitHub-hosted Windows/);
      }
      vi.stubEnv("GITHUB_ACTIONS", "true"); vi.stubEnv("RUNNER_ENVIRONMENT", "github-hosted");
      // Construction alone does not read or mutate either certificate store.
      expect(() => windowsFixtureTrust("unused fixture certificate")).not.toThrow();
      Object.defineProperty(process, "platform", { value: "linux" });
      expect(() => windowsFixtureTrust("unused fixture certificate")).toThrow(/GitHub-hosted Windows/);
    } finally { Object.defineProperty(process, "platform", platform); vi.unstubAllEnvs(); }
  });

  it("verifies NSIS install and uninstall keys by their separate ownership contracts", () => {
    const directory = "C:\\安装目录 with spaces\\EasyResearch";
    const id = windowsInstallerRegistryId();
    const rows = [
      { hive: "CurrentUser", view: "Registry64", key: `Software\\${id}`, location: directory, version: "", uninstall: "" },
      { hive: "CurrentUser", view: "Registry64", key: `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${id}`, location: "", version: "0.1.24", uninstall: `"${directory}\\Uninstall EasyResearch.exe" /currentuser` },
    ];
    expect(() => assertWindowsFixtureInstallation(rows, directory, "0.1.24")).not.toThrow();
    for (const patch of [{ hive: "LocalMachine" }, { uninstall: '"C:\\foreign\\Uninstall EasyResearch.exe" /currentuser' },
      { uninstall: `"${directory}\\Uninstall EasyResearch.exe" /allusers` }, { version: "0.1.23" }]) {
      expect(() => assertWindowsFixtureInstallation([rows[0]!, { ...rows[1]!, ...patch }], directory, "0.1.24")).toThrow();
    }
    expect(() => assertWindowsFixtureInstallation(rows.slice(0, 1), directory, "0.1.24")).toThrow();
    expect(() => assertWindowsFixtureInstallation(rows.slice(1), directory, "0.1.24")).toThrow();
  });

  it("restores the native profile binding after success, body failure or a partially applied setter", async () => {
    const original = "C:\\runner\\AppData\\Roaming", isolated = "D:\\fixture\\appdata";
    for (const failure of ["none", "body", "setter"]) {
      let current = original;
      const task = withFixtureRoamingBinding(isolated, {
        async read() { return current; },
        async write(path) { current = path; if (failure === "setter" && path === isolated) throw new Error("partial binding failure"); },
      }, async () => { expect(current).toBe(isolated); if (failure === "body") throw new Error("scenario failed"); return "accepted"; });
      if (failure === "none") await expect(task).resolves.toBe("accepted");
      else await expect(task).rejects.toThrow();
      expect(current).toBe(original);
    }
  });

  it("does not overwrite an independently changed Windows profile binding during cleanup", async () => {
    let current = "C:\\runner\\AppData\\Roaming";
    await expect(withFixtureRoamingBinding("D:\\fixture\\appdata", {
      async read() { return current; }, async write(path) { current = path; },
    }, async () => { current = "C:\\foreign\\AppData"; })).rejects.toThrow(/changed|binding/);
    expect(current).toBe("C:\\foreign\\AppData");
  });

  it("admits only flat, positive-PID process observations with creation identities", () => {
    const row = { pid: 123, parentPid: 122, start: "2026-11-24T00:00:00.0000000Z", executable: "C:\\fixture\\host.exe", worker: false, installer: false, job: false };
    expect(parseFixtureWindowsProcesses(JSON.stringify([row, { ...row, pid: 124 }])).map(value => value.pid)).toEqual([123, 124]);
    expect(parseFixtureWindowsProcesses("[]")).toEqual([]);
    expect(parseFixtureWindowsProcesses(JSON.stringify([{ ...row, parentPid: 0, requestedFrench: true }]))[0]?.requestedFrench).toBe(true);
    for (const rows of [null, {}, row, [[row]], [row, row], [{ ...row, pid: 0 }], [{ ...row, pid: "123" }],
      [{ ...row, pid: 1.5 }], [{ ...row, pid: 2 ** 32 }], [{ ...row, parentPid: -1 }], [{ ...row, parentPid: [122] }],
      [{ ...row, start: "" }], [{ ...row, start: "  " }], [{ ...row, start: "x".repeat(129) }],
      [{ ...row, executable: null }], [{ ...row, worker: "false" }], [{ ...row, installer: undefined }],
      [{ ...row, job: [] }], [{ ...row, requestedFrench: 1 }]]) {
      expect(() => parseFixtureWindowsProcesses(JSON.stringify(rows))).toThrow();
    }
    expect(() => parseFixtureWindowsProcesses("")).toThrow();
    expect(() => parseFixtureWindowsProcesses(" ".repeat(2 * 1024 * 1024) + "[]")).toThrow();
  });
});
