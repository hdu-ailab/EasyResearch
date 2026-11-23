import { expect, it, vi } from "vitest";
import { ownDesktopInstallerJob, spawnUpdateProcess, verifyDesktopSidecarVersion } from "./update-process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { WindowsUpdateJob } from "../runtime/windows-update-job";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

it("reports a spawn failure without treating it as installer completion", async () => {
  const child = spawnUpdateProcess("/definitely-missing-easyresearch-update-process", []);
  await expect(child.event("prepared", "t".repeat(43), 1000)).rejects.toThrow();
  await child.stop(); expect(child.closed).toBe(true);
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
