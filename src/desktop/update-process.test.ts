import { expect, it, vi } from "vitest";
import { ownDesktopInstallerJob, spawnUpdateProcess, verifyDesktopSidecarVersion } from "./update-process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { WindowsUpdateJob } from "../runtime/windows-update-job";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { desktopUpdateFailure } from "./update-protocol";
import { createRequire } from "node:module";
import { win32 } from "node:path";

it("owns the real child before acknowledgement and waits for its actual close", async () => {
  const token = "t".repeat(43);
  const child = spawnUpdateProcess(process.execPath, ["-e", `process.stdout.write('@easyresearch-update '+JSON.stringify({type:'prepared',token:'${token}'})+'\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`]);
  try {
    expect(child.child.pid).toBeGreaterThan(0);
    await expect(child.event("prepared", token, 2000)).resolves.toMatchObject({ type: "prepared", token });
    expect(child.closed).toBe(false);
    await child.stop();
    expect(child.closed).toBe(true);
    expect(await child.exited).toEqual({ code: 0, signal: null });
  } finally { await child.stop(); }
});

it("keeps process-only owners hidden and preserves an explicit visible GUI launch with detached pipe custody", async () => {
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    });
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  });
  vi.doMock("node:child_process", async (original) => ({
    ...await original<typeof import("node:child_process")>(), spawn,
  }));
  vi.resetModules();
  try {
    const launcher = await import("./update-process");
    const env = { FIXTURE: "isolated" };
    for (const windowsHide of [undefined, true, false]) {
      const child = launcher.spawnUpdateProcess("fixture.exe", [], { env, windowsHide });
      expect(spawn).toHaveBeenLastCalledWith("fixture.exe", [], expect.objectContaining({
        env, windowsHide: windowsHide ?? true, stdio: ["pipe", "pipe", "pipe"],
      }));
      await child.treeSettled;
    }
    for (const windowsHide of [undefined, false]) {
      const child = launcher.spawnDesktopUpdateOwner("owner.exe", [], "durable-user-data", env, { windowsHide });
      expect(spawn).toHaveBeenLastCalledWith("owner.exe", [], {
        env, cwd: "durable-user-data", detached: true, windowsHide: windowsHide ?? true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      await child.treeSettled;
    }
  } finally {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }
});

it.skipIf(process.platform !== "win32")("shows a pinned Electron owner's first loaded window under the visible GUI policy, measured by Win32", async () => {
  // A real Bun custodian exercises the same launch implementation as the compiled
  // process-only worker. The fixture has one sandboxed window, one show() call,
  // no preload/debugger/product hooks, and private HOME/userData for each launch.
  const require = createRequire(import.meta.url);
  const electronRequire = createRequire(require.resolve("electron/package.json"));
  const electronVersion = (electronRequire("./package.json") as { version: string }).version;
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-first-window-")));
  const parents: Array<ReturnType<typeof spawnUpdateProcess>> = [];
  const stops: string[] = [];
  let observer: ReturnType<typeof spawnUpdateProcess> | undefined;
  const token = "w".repeat(43);
  try {
    // Do not invoke electron's lazy installer: it writes into node_modules and
    // the user's default cache. Provision the locked, checksum-verified runtime
    // through its existing downloader into this test's private directory.
    const { downloadArtifact } = await import(pathToFileURL(electronRequire.resolve("@electron/get")).href) as typeof import("@electron/get");
    const archive = await downloadArtifact({
      version: electronVersion, artifactName: "electron", platform: "win32", arch: process.arch,
      checksums: electronRequire("./checksums.json"), cacheRoot: join(root, "cache"), tempDirectory: root,
      downloadOptions: { quiet: true, signal: AbortSignal.timeout(120_000) },
    });
    await (electronRequire("extract-zip") as (path: string, options: { dir: string }) => Promise<void>)(archive, { dir: join(root, "electron") });
    const electron = join(root, "electron", "electron.exe");
    const windows: Array<{ policy: "hidden" | "visible"; pid: number; hwnd: string; cwd: string }> = [];
    for (const policy of ["hidden", "visible"] as const) {
      const directory = join(root, policy), userData = join(directory, "user-data"), project = join(directory, "project");
      const report = join(directory, "window.json"), stop = join(directory, "stop");
      stops.push(stop);
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (/^(?:EASYRESEARCH_|ELECTRON_)/i.test(key) || key === "NODE_OPTIONS") delete env[key];
      }
      Object.assign(env, {
        HOME: join(directory, "home"), USERPROFILE: join(directory, "home"),
        APPDATA: join(directory, "roaming"), LOCALAPPDATA: join(directory, "local"),
        TEMP: join(directory, "temp"), TMP: join(directory, "temp"),
        EASYRESEARCH_CODING_AGENT_DIR: join(directory, "agent"),
      });
      for (const path of new Set([userData, project, env.HOME!, env.APPDATA!, env.LOCALAPPDATA!, env.TEMP!, env.EASYRESEARCH_CODING_AGENT_DIR!])) {
        await mkdir(path, { recursive: true });
      }
      const entry = join(directory, "first-window.cjs"), custodian = join(directory, "custodian.ts");
      await writeFile(entry, `
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
app.setPath("userData", ${JSON.stringify(userData)});
let window;
const stop = setInterval(() => { if (fs.existsSync(${JSON.stringify(stop)})) app.quit(); }, 25);
const deadline = setTimeout(() => app.exit(3), 120000);
app.on("will-quit", () => { clearInterval(stop); clearTimeout(deadline); });
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 640, height: 400, title: "EasyResearch first-window fixture",
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  window.webContents.once("did-finish-load", () => {
    window.show();
    const bytes = window.getNativeWindowHandle();
    const hwnd = bytes.length === 8 ? bytes.readBigUInt64LE().toString() : bytes.readUInt32LE().toString();
    const prefs = window.webContents.getLastWebPreferences();
    fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ pid: process.pid, hwnd, cwd: process.cwd(), electron: process.versions.electron,
      windows: BrowserWindow.getAllWindows().length, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration,
      contextIsolation: prefs.contextIsolation, preload: Boolean(prefs.preload) }));
  });
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent("<!doctype html><title>EasyResearch fixture</title><h1>First real application window</h1>"));
}).catch(error => { console.error(error); app.exit(2); });
`);
      await writeFile(custodian, `
import { writeFileSync } from "node:fs";
import { spawnDesktopUpdateOwner } from ${JSON.stringify(pathToFileURL(resolve("src/desktop/update-process.ts")).href)};
const host = spawnDesktopUpdateOwner(${JSON.stringify(electron)}, [${JSON.stringify(entry)}], ${JSON.stringify(userData)}, process.env, { windowsHide: ${policy === "hidden"} });
process.stdout.write("@easyresearch-update " + JSON.stringify({ type: "spawned", token: ${JSON.stringify(token)}, pid: host.child.pid }) + "\\n");
process.stdin.resume();
process.stdin.once("end", () => {
  writeFileSync(${JSON.stringify(stop)}, "stop");
  void host.stop().catch(error => { console.error(error); process.exitCode = 2; });
});
const exited = await host.exited;
process.exit(exited.code ?? 1);
`);
      const parent = spawnUpdateProcess("bun.exe", [custodian], { env, cwd: project });
      parents.push(parent);
      const spawned = await parent.event("spawned", token, 15_000);
      let observed!: { pid: number; hwnd: string; cwd: string; electron: string; windows: number; sandbox: boolean; nodeIntegration: boolean; contextIsolation: boolean; preload: boolean };
      await expect.poll(async () => {
        if (parent.closed) throw parent.exitError();
        observed = JSON.parse(await readFile(report, "utf8"));
        return observed.pid;
      }, { timeout: 30_000 }).toBe(spawned.pid);
      expect(observed).toMatchObject({
        electron: electronVersion, windows: 1, sandbox: true, nodeIntegration: false, contextIsolation: true, preload: false,
      });
      expect(BigInt(observed.hwnd)).toBeGreaterThan(0n);
      expect(await realpath(observed.cwd)).toBe(await realpath(userData));
      windows.push({ policy, pid: observed.pid, hwnd: observed.hwnd, cwd: observed.cwd });
    }

    // Observe both exact HWNDs in one native helper invocation. The hidden-launch
    // control is recorded rather than assumed to fail on every Windows version.
    const script = join(root, "window-visibility.ps1");
    await writeFile(script, `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public sealed class FirstWindowObservation {
  public string Hwnd;
  public uint OwnerPid;
  public uint ThreadId;
  public bool Exists;
  public bool TopLevel;
  public bool Visible;
  public string ClassName;
}
public static class FirstWindowVisibility {
  private delegate bool EnumProc(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int length);
  public static FirstWindowObservation Read(long value) {
    IntPtr hwnd = new IntPtr(value);
    FirstWindowObservation result = new FirstWindowObservation();
    result.Hwnd = value.ToString();
    result.Exists = IsWindow(hwnd);
    uint pid;
    result.ThreadId = GetWindowThreadProcessId(hwnd, out pid);
    result.OwnerPid = pid;
    int visited = 0;
    EnumWindows(delegate(IntPtr candidate, IntPtr unused) {
      if (candidate == hwnd) { result.TopLevel = true; return false; }
      return ++visited < 8192;
    }, IntPtr.Zero);
    result.Visible = IsWindowVisible(hwnd);
    StringBuilder name = new StringBuilder(256);
    GetClassName(hwnd, name, name.Capacity);
    result.ClassName = name.ToString();
    return result;
  }
}
'@
$windows = @([FirstWindowVisibility]::Read([Int64]$args[0]), [FirstWindowVisibility]::Read([Int64]$args[1]))
$result = @{ type = 'visibility'; token = $args[2]; windows = $windows }
Write-Output ('@easyresearch-update ' + ($result | ConvertTo-Json -Depth 4 -Compress))
`);
    const observerEnv = { ...process.env, HOME: root, USERPROFILE: root, TEMP: root, TMP: root,
      APPDATA: join(root, "observer-roaming"), LOCALAPPDATA: join(root, "observer-local"),
      EASYRESEARCH_CODING_AGENT_DIR: join(root, "observer-agent") };
    await Promise.all([observerEnv.APPDATA, observerEnv.LOCALAPPDATA, observerEnv.EASYRESEARCH_CODING_AGENT_DIR].map(path => mkdir(path)));
    observer = spawnUpdateProcess(win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, windows[0]!.hwnd, windows[1]!.hwnd, token],
      { cwd: root, env: observerEnv });
    const measurement = await observer.event("visibility", token, 60_000);
    expect(await observer.exited).toEqual({ code: 0, signal: null });
    const samples = measurement.windows as Array<{ Hwnd: string; OwnerPid: number; ThreadId: number; Exists: boolean; TopLevel: boolean; Visible: boolean; ClassName: string }>;
    console.info("Desktop first-window Win32 evidence:", JSON.stringify({ electron: electronVersion, samples: windows.map((window, index) => ({ policy: window.policy, expectedPid: window.pid, ...samples[index] })) }));
    expect(samples).toHaveLength(windows.length);
    for (const [index, window] of windows.entries()) {
      expect(samples[index]).toMatchObject({ Hwnd: window.hwnd, OwnerPid: window.pid, Exists: true, TopLevel: true });
      expect(samples[index]!.ThreadId).toBeGreaterThan(0);
      expect(samples[index]!.ClassName).toMatch(/^Chrome_WidgetWin_\d+$/);
      expect(parents[index]!.closed).toBe(false);
    }
    expect(samples[1]!.Visible).toBe(true);
  } finally {
    await Promise.all(stops.map(path => writeFile(path, "stop")));
    await observer?.stop();
    await Promise.all(parents.map(parent => parent.stop()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 300_000);

it("keeps an accepted host alive after its real Bun custodian exits and uses durable cwd", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-owner-survival-")));
  const installed = join(root, "installation"), durable = join(root, "userdata");
  const birth = join(root, "birth.json"), trigger = join(root, "after-parent-exit"), proof = join(root, "survived");
  await mkdir(installed); await mkdir(durable);
  const childScript = join(root, "host.cjs"), parentScript = join(root, "custodian.ts");
  const token = "t".repeat(43);
  await writeFile(childScript, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(birth)},JSON.stringify({pid:process.pid,cwd:process.cwd()}));process.stdout.write('@easyresearch-update '+JSON.stringify({type:'accepted',token:${JSON.stringify(token)}})+'\\n');process.stdin.resume();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(trigger)})){fs.writeFileSync(${JSON.stringify(proof)},'alive after custodian exit');clearInterval(timer);process.exit(0)}},20);setTimeout(()=>process.exit(2),8000).unref();`);
  await writeFile(parentScript, `import {spawnDesktopUpdateOwner} from ${JSON.stringify(pathToFileURL(resolve("src/desktop/update-process.ts")).href)};
const host=spawnDesktopUpdateOwner(${JSON.stringify(process.execPath)},[${JSON.stringify(childScript)}],${JSON.stringify(durable)},process.env);
await host.event('accepted',${JSON.stringify(token)},5000);host.child.stdin.end();host.child.stdout.destroy();host.child.stderr.destroy();host.child.unref();process.exit(0);`);
  const parent = spawnUpdateProcess(process.platform === "win32" ? "bun.exe" : "bun", [parentScript], {
    cwd: installed, env: { ...process.env, HOME: root, USERPROFILE: root, EASYRESEARCH_CODING_AGENT_DIR: join(root, "agent") },
  });
  try {
    expect((await parent.exited).code).toBe(0);
    const child = JSON.parse(await readFile(birth, "utf8"));
    expect(await realpath(child.cwd)).toBe(durable);
    await writeFile(trigger, "request sent after custodian exit");
    await expect.poll(() => readFile(proof, "utf8"), { timeout: 4000 }).toBe("alive after custodian exit");
  } finally {
    await parent.stop(); await writeFile(trigger, "stop");
    // The fixed child has an eight-second self-termination bound even on failure.
    const child = await readFile(birth, "utf8").then(text => JSON.parse(text)).catch(() => undefined);
    const deadline = Date.now() + 10_000;
    while (child) {
      let running = false;
      try {
        process.kill(child.pid, 0); running = true;
        if (process.platform === "linux") running = !/\) [ZX] /u.test(await readFile(`/proc/${child.pid}/stat`, "utf8"));
      } catch { /* Closed process. */ }
      if (!running) break;
      if (Date.now() >= deadline) throw new Error("Owned host fixture did not settle");
      await delay(25);
    }
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

it("reports a spawn failure without treating it as installer completion", async () => {
  const child = spawnUpdateProcess("/definitely-missing-easyresearch-update-process", []);
  await expect(child.event("prepared", "t".repeat(43), 1000)).rejects.toThrow();
  await child.stop(); expect(child.closed).toBe(true);
});

it("retains actual early child exit evidence without leaking credential-bearing stderr", async () => {
  const child = spawnUpdateProcess(process.execPath, ["-e", "process.stderr.write('fatal: startup resource missing\\nAuthorization: Bearer private-value\\nworker_token=private-token\\n');process.exitCode=17"]);
  try {
    const error = await child.event("successor-ready", "t".repeat(43), 5000).catch(error => error);
    const failure = desktopUpdateFailure("recovery-launch", error);
    expect(failure).toMatchObject({ operation: "recovery-launch", code: "UPDATE_PROCESS_EXIT", childExitCode: 17 });
    expect(failure.stderr).toContain("startup resource missing");
    expect(JSON.stringify(failure)).not.toMatch(/private-value|private-token/);
  } finally { await child.stop(); }
});

it("drops a truncated credential line before redacting the bounded child stderr", async () => {
  const secret = "a".repeat(42) + "Z";
  const label = "worker_token=";
  const start = `${label}${secret}\n`;
  const lines = `Authorization: Bearer ${"x".repeat(2030)}\n`.repeat(3);
  const remaining = 8192 + label.length + 1 - Buffer.byteLength(start + lines + "Authorization: Bearer \n");
  const text = `${start}${lines}Authorization: Bearer ${"x".repeat(remaining)}\n`;
  const child = spawnUpdateProcess(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(text)});process.exitCode=17`]);
  try {
    const error = await child.event("successor-ready", "t".repeat(43), 5000).catch(error => error);
    const failure = desktopUpdateFailure("recovery-launch", error);
    expect(failure.childExitCode).toBe(17);
    expect(JSON.stringify(failure)).not.toContain(secret.slice(1));
    expect(Buffer.byteLength(failure.stderr ?? "")).toBeLessThanOrEqual(4096);
    const normalized = desktopUpdateFailure("recovery-launch", { code: "UPDATE_PROCESS_EXIT", stderr: text });
    expect(JSON.stringify(normalized)).not.toContain(secret.slice(1));
    const unicode = desktopUpdateFailure("recovery-launch", { code: "UPDATE_PROCESS_EXIT", stderr: "错误".repeat(1000) });
    expect(Buffer.byteLength(unicode.stderr ?? "")).toBeLessThanOrEqual(4096);
    expect(unicode.stderr).toContain("错误");
    expect(unicode.stderr).not.toContain("\ufffd");
  } finally { await child.stop(); }
});

it("timeout does not detach a still-running helper", async () => {
  const child = spawnUpdateProcess(process.execPath, ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"]);
  try {
    await expect(child.event("prepared", "t".repeat(43), 20)).rejects.toThrow(/timed out/);
    expect(child.closed).toBe(false); await child.stop(); expect(child.closed).toBe(true);
  } finally { await child.stop(); }
});

it.skipIf(process.platform === "win32")("settles a redirected-pipe descendant after the root has already exited", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-tree-repro-")); const marker = join(root, "late-write");
  const descendant = `setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'survived');},800);setInterval(()=>{},1000);`;
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}).unref();`;
  const child = spawnUpdateProcess(process.execPath, ["-e", parent]);
  try {
    await child.exited; expect(child.closed).toBe(true);
    await child.stop(); await child.treeSettled;
    expect(child.treeClosed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await child.stop(); await rm(root, { recursive: true, force: true }); }
});

it("never interprets guard/root close as job-empty installer completion", async () => {
  let complete!: (value: { code: number; signal: null }) => void;
  let cleaned!: () => void;
  const child = Object.assign(new EventEmitter(), { pid: 42, stdout: new PassThrough(), stderr: new PassThrough() });
  const job = { child, completed: new Promise<{ code: number; signal: null }>((resolve) => { complete = resolve; }),
    cancel: vi.fn(async () => {}), dispose: vi.fn(() => new Promise<void>((resolve) => { cleaned = resolve; })) } as unknown as WindowsUpdateJob;
  const installer = ownDesktopInstallerJob(job); let settled = false;
  void installer.treeSettled.then(() => { settled = true; });
  child.emit("close", 0, null); await Promise.resolve(); expect(settled).toBe(false); expect(installer.treeClosed).toBe(false);
  complete({ code: 0, signal: null }); await Promise.resolve(); expect(settled).toBe(false);
  cleaned(); expect(await installer.treeSettled).toEqual({ code: 0, signal: null }); expect(installer.treeClosed).toBe(true);
});

it("unresolved job cleanup retains installer custody even after the guard exited", async () => {
  const unresolved = Object.assign(new Error("no empty-job receipt"), { custodyUnresolved: true });
  const child = Object.assign(new EventEmitter(), { pid: 42, stdout: new PassThrough(), stderr: new PassThrough() });
  const job = { child, completed: Promise.reject(unresolved), cancel: vi.fn(async () => { throw unresolved; }), dispose: vi.fn() } as unknown as WindowsUpdateJob;
  const installer = ownDesktopInstallerJob(job); child.emit("close", 0, null);
  await expect(installer.treeSettled).rejects.toMatchObject({ custodyUnresolved: true });
  await expect(installer.stop()).rejects.toMatchObject({ custodyUnresolved: true });
  expect(installer.treeClosed).toBe(false); expect(job.dispose).not.toHaveBeenCalled();
});

it.each(["easyresearch 2.0.0\r\n", "", "easyresearch 1.0.0\n"])("requires exact captured version bytes, even for exit zero: %j", async (output) => {
  const stdout = new PassThrough(); const stderr = new PassThrough(); stdout.end(output);
  const dispose = vi.fn(async () => {});
  const completed = new Promise<{ code: number; signal: null }>((resolve) => stdout.on("end", () => resolve({ code: 0, signal: null })));
  const startJob = vi.fn(async () => ({ child: { stdout, stderr }, completed, cancel: vi.fn(async () => {}), dispose }) as unknown as WindowsUpdateJob);
  const operation = verifyDesktopSidecarVersion("C:\\App\\easyresearch.exe", "2.0.0", {}, startJob);
  if (output.startsWith("easyresearch 2.0.0")) await expect(operation).resolves.toBeUndefined();
  else await expect(operation).rejects.toThrow(/version mismatch/);
  expect(startJob).toHaveBeenCalledExactlyOnceWith("C:\\App\\easyresearch.exe", ["--version"], { env: {} });
  expect(dispose).toHaveBeenCalledOnce();
});
