import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertExternalFixtureReceipt, copyUpdateFixtureSource, parseUpdateFixtureOptions, removeUpdateFixture } from "../../scripts/build-update-fixture";
import { assertFixtureChild, captureDesktopUpdateFailure, createDesktopFixtureCertificate, createReleaseFixture, desktopCustodyDiagnostic, desktopUpdateFixtureInput, findDesktopUpdateLineage, observeFixtureUpdateAction, remainingDesktopRecoveryArtifacts, runFixtureCommand, startDesktopReleaseFixture, windowsFixtureTrust, withFixtureTrust, withFixtureRoamingBinding } from "../../scripts/smoke-desktop-update-fixture";
import { discoverDesktopRelease, downloadDesktopAsset } from "../desktop/update-download";
import { windowsInstallerRegistryId } from "../desktop/update-worker";
import { assertWindowsFixtureInstallation, parseFixtureWindowsProcesses, retainFixtureProcessObservation } from "../../scripts/smoke-desktop-update-windows";
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

  it("requires the actual installer and successor to descend from the same owned native worker without a receipt", () => {
    const host = "C:\\fixture\\安装目录 with spaces\\EasyResearch.exe";
    const helper = "C:\\fixture\\userData\\updates\\update-owned\\custodian.exe";
    const installer = "C:\\fixture\\userData\\updates\\update-owned\\EasyResearch-0.1.24-windows-x64.exe";
    const sidecar = "C:\\fixture\\安装目录 with spaces\\resources\\sidecar\\easyresearch.exe";
    const options = { oldHostPid: 10, sidecarPid: 60, host, helper, installer, sidecar };
    const process = (pid: number, parentPid: number, executable: string, role?: "worker" | "job" | "installer") => ({ pid, parentPid, executable,
      start: "2026-11-23T01:02:03.000Z", worker: role === "worker", job: role === "job", installer: role === "installer" });
    const records = [process(20, 10, helper, "worker"), process(30, 20, "C:\\Windows\\powershell.exe", "job"),
      process(40, 30, installer, "installer"), process(50, 20, host), process(60, 50, sidecar)];
    expect(findDesktopUpdateLineage(records, options)).toMatchObject({ worker: { pid: 20 }, guard: { pid: 30 }, installer: { pid: 40 }, host: { pid: 50 }, sidecar: { pid: 60 } });
    // Spawned host/sidecar alone cannot satisfy native installer acceptance.
    expect(findDesktopUpdateLineage(records.filter(row => row.pid !== 40), options)).toBeUndefined();
    expect(findDesktopUpdateLineage(records.map(row => row.pid === 30 ? { ...row, parentPid: 99 } : row), options)).toBeUndefined();
    expect(findDesktopUpdateLineage(records.map(row => row.pid === 50 ? { ...row, parentPid: 99 } : row), options)).toBeUndefined();
    expect(findDesktopUpdateLineage(records.map(row => row.pid === 20 ? { ...row, parentPid: 99 } : row), options)).toBeUndefined();
    expect(findDesktopUpdateLineage(records.map(row => row.pid === 60 ? { ...row, executable: "C:\\foreign\\easyresearch.exe" } : row), options)).toBeUndefined();
    expect(findDesktopUpdateLineage(records, { ...options, oldHostPid: 50 })).toBeUndefined();
    const partial = { ...records[0]!, executable: "", worker: false };
    const retained = retainFixtureProcessObservation(records[0], partial);
    expect(findDesktopUpdateLineage([retained, ...records.slice(1)], options)).toMatchObject({ worker: { pid: 20, executable: helper } });
    expect(partial.executable).toBe(""); // The live snapshot is not enriched or mutated.
    const reused = retainFixtureProcessObservation(records[0], { ...partial, start: "later-creation" });
    expect(findDesktopUpdateLineage([reused, ...records.slice(1)], options)).toBeUndefined();
    for (const change of [{ parentPid: 999 }, { executable: "C:\\foreign\\helper.exe" }]) {
      expect(() => retainFixtureProcessObservation(records[0], { ...partial, ...change })).toThrow();
    }
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
