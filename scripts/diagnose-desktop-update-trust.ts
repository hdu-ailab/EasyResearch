/** Diagnose the actual private Desktop TLS prerequisite without installing the app. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { assertFixtureChild, assertHostedWindowsFixture, createDesktopFixtureCertificate, fixtureDiagnosticError, powershell, runFixtureCommand, windowsFixtureTrust, withFixtureTrust } from "./smoke-desktop-update-fixture";
import { fixtureWindowsProcesses, stopFixtureWindowsProcesses, withWindowsFixtureRoamingAppData } from "./smoke-desktop-update-windows";
import { createDesktopSmokeEnvironment } from "./smoke-desktop-support";
import { selectShell } from "../src/background/shell/process";

async function verifyWindowsFixtureProcessCleanup(root: string): Promise<Record<string, unknown>> {
  assertHostedWindowsFixture();
  const directory = realpathSync(mkdtempSync(join(root, "processes-"))); assertFixtureChild(root, directory);
  const script = assertFixtureChild(directory, join(directory, "owned-process.cjs"));
  writeFileSync(script, `const fs=require('node:fs'); const [file,nonce]=process.argv.slice(2); fs.writeFileSync(file+'.partial',JSON.stringify({pid:process.pid,parentPid:process.ppid,nonce}),{flag:'wx'}); fs.renameSync(file+'.partial',file); setInterval(()=>{},1000);\n`);
  const owned: Array<{ child: ChildProcess; marker: string; nonce: string; closed: Promise<void>; isClosed: boolean; error?: Error }> = [];
  const joinChildren = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      assert(await Promise.race([Promise.all(owned.map(item => item.closed)).then(() => true), new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), 5000);
      })]), "Owned process preflight children did not close");
    } finally { clearTimeout(timer); }
  };
  let failure: unknown; const cleanupErrors: unknown[] = [];
  let result: Record<string, unknown> | undefined;
  try {
    for (let index = 0; index < 2; index++) {
      const marker = assertFixtureChild(directory, join(directory, `child-${index}.json`)); const nonce = randomUUID();
      const child = spawn(process.execPath, [script, marker, nonce], { cwd: directory, env: process.env, windowsHide: true, stdio: "ignore" });
      let close!: () => void;
      const item: typeof owned[number] = { child, marker, nonce, isClosed: false, closed: new Promise<void>(resolve => { close = resolve; }) };
      owned.push(item); // Retain the actual handle even when spawn/readiness fails.
      child.once("error", error => { item.error = error; });
      child.once("close", () => { item.isClosed = true; close(); });
    }
    const deadline = Date.now() + 10_000;
    while (true) {
      for (const item of owned) { if (item.error) throw item.error; assert(!item.isClosed, "Process preflight child exited before its birth marker"); }
      if (owned.every(item => existsSync(item.marker))) break;
      assert(Date.now() < deadline, "Process preflight child birth timed out");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const expected = new Set<number>();
    for (const item of owned) {
      assertFixtureChild(directory, item.marker);
      const bytes = readFileSync(item.marker); assert(bytes.length <= 1024, "Invalid process preflight birth marker");
      const birth = JSON.parse(bytes.toString());
      assert(Number.isSafeInteger(item.child.pid) && item.child.pid! > 0 && birth.pid === item.child.pid
        && birth.parentPid === process.pid && birth.nonce === item.nonce, "Process preflight birth does not match its owned child");
      assert(item.child.pid !== process.pid && item.child.pid !== process.ppid, "Process preflight cannot own its caller or parent");
      expected.add(item.child.pid!);
    }
    assert.equal(expected.size, 2);
    const observed = await fixtureWindowsProcesses(directory);
    console.log(`[process-preflight] ${JSON.stringify({ roots: [...expected], observed })}`);
    assert([...expected].every(pid => observed.some(item => item.pid === pid)), "Process preflight missed an owned root");
    const tree = new Set(expected);
    let added = true;
    while (added) {
      added = false;
      for (const item of observed) if (!tree.has(item.pid) && tree.has(item.parentPid)) { tree.add(item.pid); added = true; }
    }
    assert(observed.every(item => tree.has(item.pid)), "Process preflight observation included a foreign process");
    for (const item of observed.filter(item => expected.has(item.pid))) {
      assert(item.parentPid === process.pid && item.start.trim().length > 0
        && win32.resolve(item.executable).toLowerCase() === win32.resolve(realpathSync(process.execPath)).toLowerCase()
        && !item.worker && !item.installer && !item.job, "Process preflight observation escaped its exact child ownership");
    }
    await stopFixtureWindowsProcesses(directory, observed);
    await joinChildren();
    assert(owned.every(item => item.isClosed), "Native process cleanup did not close both owned child handles");
    result = { observedRoots: expected.size, observedProcesses: observed.length, creationIdentitiesVerified: true, ownedChildHandlesClosed: true };
  } catch (error) { failure = error; }
  finally {
    // Never turn a failed observation into authority over an arbitrary PID.
    for (const item of owned) if (!item.isClosed) {
      try { item.child.kill("SIGKILL"); } catch (error) { cleanupErrors.push(error); }
    }
    try { await joinChildren(); } catch (error) { cleanupErrors.push(error); }
  }
  if (failure || cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "Native fixture process observation/cleanup failed");
  return result!;
}

if (process.platform !== "win32") throw new Error("Desktop trust diagnosis requires native Windows.");
const root = realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "easyresearch-desktop-trust-")));
const phases: Array<Record<string, unknown>> = [];
const started = performance.now();
let passed = false;
let profileRestored = true;
try {
  const certificate = await createDesktopFixtureCertificate(join(root, "tls"));
  const store = windowsFixtureTrust(certificate.caPath);
  const step = async <T>(phase: string, operation: () => Promise<T>): Promise<T> => {
    const record: Record<string, unknown> = { phase, startedMs: performance.now() - started }; phases.push(record);
    console.log(`[desktop-trust] ${phase}`);
    try { const result = await operation(); record.result = result; return result; }
    catch (error) { record.error = fixtureDiagnosticError(error); throw error; }
    finally { record.finishedMs = performance.now() - started; }
  };
  await step("isolated-native-shell-environment", async () => {
    const env = createDesktopSmokeEnvironment(root, process.env);
    const prefix = join(root, "python-prefix"); mkdirSync(prefix);
    env.PATH = `${prefix};${env.PATH ?? ""}`;
    const selected = selectShell("win32", env);
    assert.equal((await runFixtureCommand(selected.executable, selected.args("[Console]::Write('desktop-shell-ready')"),
      { env, cwd: root, timeoutMs: 5000, label: "isolated native shell environment" })).trim(), "desktop-shell-ready");
    return { executable: selected.executable, pathKeys: Object.keys(env).filter(key => key.toUpperCase() === "PATH") };
  });
  await withFixtureTrust(certificate.thumbprint, {
    contains: id => step("contains", () => store.contains(id)),
    add: id => step("add", () => store.add(id)),
    remove: id => step("remove", () => store.remove(id)),
  }, async () => { await step("trusted-operation", async () => true); });
  const profile = join(root, "profile"); mkdirSync(profile);
  profileRestored = false;
  await step("native-profile-binding", () => withWindowsFixtureRoamingAppData(profile, async () => {
    const observed = (await powershell("[Console]::Write([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData))")).trim();
    assert.equal(win32.resolve(observed).toLowerCase(), win32.resolve(realpathSync(join(profile, "appdata"))).toLowerCase());
    return true;
  }));
  profileRestored = true;
  await step("native-process-observation-and-cleanup", () => verifyWindowsFixtureProcessCleanup(root));
  passed = true;
} finally {
  rmSync(join(root, "tls"), { recursive: true, force: true });
  if (profileRestored && passed) rmSync(root, { recursive: true, force: true });
  const report = { passed, phases, ...(!passed ? { diagnostics: root } : {}) };
  writeFileSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "windows-desktop-trust-diagnostic.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
