/** Private native Electron/Bun acceptance, before any Desktop build or installation. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, win32 } from "node:path";
import { createDesktopSuccessorChannel, type DesktopSuccessorReady } from "../src/desktop/update-successor-channel";
import { spawnDesktopUpdateOwner, type OwnedUpdateProcess } from "../src/desktop/update-process";
import { assertFixtureChild, assertHostedWindowsFixture, assertStableVersion, digestFile, fixtureDiagnosticError } from "./smoke-desktop-update-fixture";
import { fixtureWindowsProcesses, stopFixtureWindowsProcesses } from "./smoke-desktop-update-windows";
import { createDesktopSmokeEnvironment } from "./smoke-desktop-support";

type SuccessorChannel = Awaited<ReturnType<typeof createDesktopSuccessorChannel>>;
const CASE_TIMEOUT_MS = 30_000;

async function bounded<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Electron successor preflight timed out: ${label}`)), Math.max(1, timeoutMs));
    })]);
  } finally { clearTimeout(timer); }
}

function publish(directory: string, name: string, value: Record<string, unknown> = {}): void {
  const path = assertFixtureChild(directory, join(directory, `${name}.json`));
  writeFileSync(`${path}.partial`, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  renameSync(`${path}.partial`, path);
}

function marker(directory: string, name: string): Record<string, unknown> | undefined {
  const path = assertFixtureChild(directory, join(directory, `${name}.json`));
  if (!existsSync(path)) return;
  assert(statSync(path).isFile() && statSync(path).size <= 4096, "Invalid Electron preflight marker");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert(value && typeof value === "object" && !Array.isArray(value), "Invalid Electron preflight record");
  return value as Record<string, unknown>;
}

async function prepareElectron(root: string): Promise<{ executable: string; electronVersion: string; appVersion: string; archiveSha256: string }> {
  const repository = resolve(import.meta.dir, "..");
  const pkg = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
  const electronVersion: string = pkg.devDependencies.electron;
  const appVersion: string = pkg.version;
  assertStableVersion(electronVersion); assertStableVersion(appVersion);
  const installed = JSON.parse(readFileSync(join(repository, "node_modules", "electron", "package.json"), "utf8"));
  assert.equal(installed.version, electronVersion, "Installed Electron metadata differs from the root pin");
  const filename = `electron-v${electronVersion}-win32-x64.zip`;
  const checksums = JSON.parse(readFileSync(join(repository, "node_modules", "electron", "checksums.json"), "utf8")) as Record<string, string>;
  const archiveSha256 = checksums[filename];
  assert(archiveSha256 && /^[a-f0-9]{64}$/u.test(archiveSha256), "Pinned Electron ZIP checksum is missing");
  const cache = join(root, "download-cache"), temporary = join(root, "download-temp"), extracted = join(root, "electron");
  for (const directory of [cache, temporary, extracted]) mkdirSync(directory, { mode: 0o700 });
  const { downloadArtifact } = await import("@electron/get");
  const archive = await downloadArtifact({
    version: electronVersion, artifactName: "electron", platform: "win32", arch: "x64",
    checksums: { [filename]: archiveSha256 }, cacheRoot: cache, tempDirectory: temporary,
    downloadOptions: { quiet: true, signal: AbortSignal.timeout(120_000) },
    mirrorOptions: { resolveAssetURL: async details => {
      assert.equal(details.version, `v${electronVersion}`, "Electron download version was overridden");
      return `https://github.com/electron/electron/releases/download/v${electronVersion}/${filename}`;
    } },
  });
  assertFixtureChild(cache, archive);
  assert.equal(await digestFile(archive), archiveSha256, "Electron ZIP differs from the locked package checksum");
  const { default: extract } = await import("extract-zip");
  await extract(archive, { dir: extracted, onEntry: entry => {
    assertFixtureChild(extracted, join(extracted, entry.fileName));
    assert((entry.externalFileAttributes >>> 16 & 0xf000) !== 0xa000, "Electron fixture ZIP contains a link");
  } });
  assert.equal(readFileSync(join(extracted, "version"), "utf8").trim(), electronVersion);
  const executable = assertFixtureChild(extracted, join(extracted, "electron.exe"));
  assert(statSync(executable).isFile(), "Pinned Electron executable is missing");

  // resources/app makes this the ordinary, argument-free Windows GUI entry.
  // Bundle only the shared channel and this private main script, never the product host.
  const app = join(extracted, "resources", "app"); mkdirSync(app, { mode: 0o700 });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "easyresearch-successor-channel-probe", version: appVersion, main: "main.cjs" }));
  const entry = join(root, "probe-main.ts");
  writeFileSync(entry, desktopSuccessorProbeMain(join(repository, "src", "desktop", "update-successor-channel.ts")));
  const bundle = await Bun.build({ entrypoints: [entry], outdir: app, naming: "main.cjs", target: "node", format: "cjs", external: ["electron"], sourcemap: "none" });
  assert(bundle.success, "Private Electron successor fixture could not bundle the shared channel");
  return { executable, electronVersion, appVersion, archiveSha256 };
}

export function desktopSuccessorProbeMain(channelModule: string): string {
  return `
import { app } from "electron";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectDesktopSuccessorChannel } from ${JSON.stringify(channelModule)};
const config = JSON.parse(process.env.ER_SUCCESSOR_CHANNEL_PROBE);
delete process.env.ER_SUCCESSOR_CHANNEL_PROBE;
const file = name => join(config.directory, name + ".json");
const publish = (name, value = {}) => {
  const path = file(name);
  writeFileSync(path + ".partial", JSON.stringify({ pid: process.pid, ...value }), { flag: "wx", mode: 0o600 });
  renameSync(path + ".partial", path);
};
let accepted = false, lost = false, ending = false, readyStarted = false, checked = false, proved = false;
let channel;
const finish = code => { ending = true; channel?.close(); app.exit(code); };
const fail = phase => { if (!ending) { publish("failure", { phase }); finish(1); } };
process.on("uncaughtException", () => fail("uncaught-exception"));
process.on("unhandledRejection", () => fail("unhandled-rejection"));
setTimeout(() => fail("child-deadline"), 45000);
app.setPath("appData", config.appData);
app.setPath("userData", config.userData);
app.setPath("sessionData", config.userData);
app.setPath("logs", join(config.userData, "logs"));
app.setPath("crashDumps", join(config.userData, "crashdumps"));
app.on("window-all-closed", () => {});
publish("birth", { parentPid: process.ppid, electron: process.versions.electron, node: process.versions.node,
  processType: process.type, platform: process.platform, arch: process.arch, bun: process.versions.bun ?? null,
  appVersion: app.getVersion(), cwd: process.cwd(), userData: app.getPath("userData") });
const waitForConnect = setInterval(() => {
  if (existsSync(file("exit"))) { clearInterval(waitForConnect); finish(0); return; }
  if (!existsSync(file("connect"))) return;
  clearInterval(waitForConnect);
  void (async () => {
    channel = await connectDesktopSuccessorChannel(config.context, () => {
      if (ending) return;
      lost = true; publish("parent-lost", { accepted }); finish(0);
    });
    publish("attached");
    await app.whenReady(); publish("app-ready");
    setInterval(() => {
      if (ending) return;
      if (existsSync(file("exit"))) { finish(0); return; }
      if (!readyStarted && existsSync(file("send-ready"))) {
        readyStarted = true; publish("ready-started");
        // No sidecar is launched: its PID field is a synthetic transport fixture.
        void channel.ready({ version: app.getVersion(), pid: process.pid, bootId: config.bootId, sidecarPid: process.pid }).then(() => {
          accepted = true; publish("accepted");
        }, () => { if (!ending) fail("ready-rejected"); });
      }
      if (!checked && existsSync(file("check-acceptance"))) {
        checked = true; publish("awaiting-acceptance", { readyStarted, accepted });
      }
      if (!proved && existsSync(file("channel-gone"))) {
        proved = true;
        const challenge = JSON.parse(readFileSync(file("channel-gone"), "utf8")).challenge;
        if (!accepted || lost) { fail("survival-before-acceptance"); return; }
        publish("survived", { challenge, accepted, lost });
      }
    }, 25);
  })().catch(() => { if (!ending) fail("connect-rejected"); });
}, 25);
`;
}

/** Uses only fresh private fixtures; no installed app, real profile or product setup. */
export async function verifyWindowsElectronSuccessorChannel(root: string): Promise<Record<string, unknown>> {
  assertHostedWindowsFixture();
  assert(process.arch === "x64" && process.versions.bun, "Electron successor preflight requires native Windows x64 Bun");
  const directory = realpathSync(mkdtempSync(join(root, "electron-channel-"))); assertFixtureChild(root, directory);
  const owners: Array<{ handle: OwnedUpdateProcess; directory: string }> = [];
  const channels: SuccessorChannel[] = [];
  const secrets: string[] = [];
  let result: Record<string, unknown> | undefined;
  const errors: unknown[] = [];
  try {
    const electron = await prepareElectron(directory);
    const cases: Record<string, unknown>[] = [];
    for (const name of ["wrong-token", "wrong-child-pid", "before-ready-parent-loss", "accepted-parent-loss"] as const) {
      const run = join(directory, name); mkdirSync(run, { mode: 0o700 });
      const env = createDesktopSmokeEnvironment(run, process.env);
      const userData = join(run, "user-data");
      env.TEMP = join(run, "tmp"); env.TMP = env.TEMP;
      for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TEMP"])
        mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
      for (const path of [userData, join(userData, "logs"), join(userData, "crashdumps")]) mkdirSync(path, { recursive: true, mode: 0o700 });
      const token = randomBytes(32).toString("base64url"), bootId = randomUUID();
      const hostToken = name === "wrong-token" ? randomBytes(32).toString("base64url") : token;
      secrets.push(token, hostToken);
      const channel = await createDesktopSuccessorChannel(token); channels.push(channel); secrets.push(channel.path);
      assert(channel.path.startsWith("\\\\.\\pipe\\"), "Native Electron preflight must use a Windows named pipe");
      env.ER_SUCCESSOR_CHANNEL_PROBE = JSON.stringify({ directory: run, userData, appData: env.APPDATA, bootId,
        context: { directory: run, token: hostToken, workerPid: process.pid, pipe: channel.path } });
      const handle = spawnDesktopUpdateOwner(electron.executable, [], userData, env);
      owners.push({ handle, directory: run });
      assert(handle.child.pid && handle.child.pid !== process.pid && handle.child.pid !== process.ppid, "Electron preflight child did not spawn");
      channel.bindChild(name === "wrong-child-pid" ? process.pid : handle.child.pid);
      const deadline = Date.now() + CASE_TIMEOUT_MS;
      const waitMarker = async (phase: string): Promise<Record<string, unknown>> => {
        while (true) {
          const failed = marker(run, "failure");
          assert(!failed, `Electron preflight ${name} failed at ${failed?.phase ?? "unknown"}`);
          const value = marker(run, phase);
          if (value) { assert.equal(value.pid, handle.child.pid, "Electron marker has the wrong process identity"); return value; }
          assert(!handle.closed, `Electron preflight ${name} exited before ${phase}`);
          assert(Date.now() < deadline, `Electron preflight ${name} timed out before ${phase}`);
          await new Promise(resolveWait => setTimeout(resolveWait, 25));
        }
      };
      const birth = await waitMarker("birth");
      assert(birth.parentPid === process.pid && birth.electron === electron.electronVersion && birth.processType === "browser"
        && birth.platform === "win32" && birth.arch === "x64" && birth.bun === null && typeof birth.node === "string"
        && birth.appVersion === electron.appVersion, "Probe is not the pinned native Electron browser process");
      for (const path of [birth.cwd, birth.userData]) assert(typeof path === "string" && win32.resolve(path).toLowerCase() === win32.resolve(userData).toLowerCase(), "Electron escaped its private userData/cwd");
      publish(run, "connect");
      if (name === "wrong-token" || name === "wrong-child-pid") {
        const exit = await bounded(handle.exited, deadline - Date.now(), `${name} rejection`);
        assert.equal(exit.code, 0); assert.equal(exit.signal, null);
        assert.equal(marker(run, "parent-lost")?.accepted, false, "Rejected attach did not signal parent loss");
        assert(!marker(run, "attached") && !marker(run, "ready-started") && !marker(run, "accepted"), "Unauthenticated Electron reached the channel");
        await bounded(channel.close(), 5000, "rejected channel cleanup");
        cases.push({ name, rejected: true, cleanExit: true });
        continue;
      }
      await waitMarker("attached"); await waitMarker("app-ready");
      if (name === "before-ready-parent-loss") {
        assert(!marker(run, "ready-started"), "Pre-ready loss probe already sent readiness");
        await bounded(channel.close(), 5000, "pre-ready parent close");
        const loss = await waitMarker("parent-lost"); assert.equal(loss.accepted, false);
        const exit = await bounded(handle.exited, deadline - Date.now(), "pre-ready parent-loss exit");
        assert.equal(exit.code, 0); assert.equal(exit.signal, null);
        assert(!marker(run, "accepted"), "Disconnected Electron claimed acceptance");
        cases.push({ name, attached: true, parentLossObserved: true, cleanExit: true });
        continue;
      }
      publish(run, "send-ready");
      const ready = await bounded(Promise.race([channel.ready, handle.exited.then(() => { throw new Error("Electron exited before named-pipe readiness"); })]), deadline - Date.now(), "authenticated readiness");
      const expected: DesktopSuccessorReady = { version: electron.appVersion, pid: handle.child.pid, bootId, sidecarPid: handle.child.pid };
      assert.deepEqual(ready, expected, "Named-pipe readiness did not match the owned native host");
      publish(run, "check-acceptance");
      const waiting = await waitMarker("awaiting-acceptance");
      assert(waiting.readyStarted === true && waiting.accepted === false && !marker(run, "accepted"), "Host ready() resolved before parent acceptance");
      await bounded(channel.accept(), deadline - Date.now(), "readiness acceptance");
      await waitMarker("accepted");
      await bounded(channel.close(), 5000, "accepted parent close");
      const challenge = randomUUID(); publish(run, "channel-gone", { challenge });
      const survival = await waitMarker("survived");
      assert(survival.challenge === challenge && survival.accepted === true && survival.lost === false && !marker(run, "parent-lost") && !handle.closed,
        "Accepted Electron did not survive the causally closed parent channel");
      publish(run, "exit");
      const exit = await bounded(handle.exited, deadline - Date.now(), "accepted host cleanup");
      assert.equal(exit.code, 0); assert.equal(exit.signal, null);
      cases.push({ name, attached: true, readinessTupleVerified: true, acknowledgementRequired: true, survivedClosedParentChannel: true, cleanExit: true });
    }
    result = { electronVersion: electron.electronVersion, archiveSha256: electron.archiveSha256, processType: "browser", parentRuntime: `Bun ${process.versions.bun}`, cases };
  } catch (error) { errors.push(error); }
  finally {
    for (const channel of channels) {
      try { await bounded(channel.close(), 5000, "final channel cleanup"); } catch (error) { errors.push(error); }
    }
    for (const owner of owners) {
      try {
        if (!owner.handle.closed && !marker(owner.directory, "exit")) publish(owner.directory, "exit");
        await owner.handle.stop();
      } catch (error) { errors.push(error); }
    }
    try {
      // Close events alone cannot prove Chromium descendants have stopped.
      await stopFixtureWindowsProcesses(directory);
      assert.equal((await fixtureWindowsProcesses(directory)).length, 0, "Electron preflight left native descendants");
      for (const owner of owners) {
        await bounded(owner.handle.treeSettled, 5000, "owned Electron handle close");
        assert(owner.handle.closed && owner.handle.treeClosed, "Electron preflight lost owned process custody");
      }
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new Error(fixtureDiagnosticError(new AggregateError(errors, "Native Electron successor channel preflight failed"), secrets));
  return { ...result!, ownedChildrenClosed: true, nativeProcessCleanupVerified: true };
}
