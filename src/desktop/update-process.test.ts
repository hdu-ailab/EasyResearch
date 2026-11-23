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
