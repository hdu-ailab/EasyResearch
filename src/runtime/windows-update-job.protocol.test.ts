import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWindowsUpdateJob, type WindowsUpdateJob } from "./windows-update-job";

type InspectionPhase = "open" | "stat" | "read" | "close";
const receiptRead = vi.hoisted(() => ({
  delayMissing: undefined as undefined | (() => Promise<void>),
  stalled: undefined as undefined | {
    name: string;
    phase: InspectionPhase;
    wait(): Promise<void>;
    opened(file: FileHandle): void;
  },
}));
// Only OS process/source preflight is replaced. Custody, private-file receipts,
// cancellation, deadlines and deletion are the real adapter on every host.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  const nativePath = (path: unknown) => typeof path === "string" && [
    "C:\\Windows", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "C:\\node.exe",
  ].includes(path);
  return {
    ...fs,
    realpath: (path: string) => nativePath(path) ? Promise.resolve(path) : fs.realpath(path),
    lstat: (path: string) => nativePath(path) ? Promise.resolve({ isFile: () => true }) : fs.lstat(path),
    open: async (path: string, flags: string) => {
      if (nativePath(path)) return {
        read: async (bytes: Buffer) => { bytes.write("MZ"); return { bytesRead: 2 }; }, close: async () => {},
      };
      const stalled = path.endsWith(receiptRead.stalled?.name ?? "\0") ? receiptRead.stalled : undefined;
      const pause = async (phase: InspectionPhase) => {
        if (stalled?.phase !== phase) return;
        receiptRead.stalled = undefined;
        await stalled.wait();
      };
      await pause("open");
      let file: FileHandle;
      try { file = await fs.open(path, flags); }
      catch (error) {
        if (path.endsWith("receipt.json") && receiptRead.delayMissing) {
          const hold = receiptRead.delayMissing; receiptRead.delayMissing = undefined; await hold();
        }
        throw error;
      }
      if (!stalled) return file;
      stalled.opened(file);
      return {
        stat: async () => { await pause("stat"); return file.stat(); },
        read: async (bytes: Buffer, offset: number, length: number, position: number) => {
          await pause("read"); return file.read(bytes, offset, length, position);
        },
        close: async () => { await pause("close"); await file.close(); },
      };
    },
  };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: string[] = [];
const jobs: WindowsUpdateJob[] = [];
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.stubEnv("SystemRoot", "C:\\Windows");
});
afterEach(async () => {
  for (const job of jobs.splice(0)) await job.dispose().catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  Object.defineProperty(process, "platform", platform);
  receiptRead.delayMissing = undefined;
  receiptRead.stalled = undefined;
  vi.unstubAllEnvs(); vi.resetAllMocks();
});

async function fixture(options: Partial<Parameters<typeof startWindowsUpdateJob>[2]> = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: 51872, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: (_signal?: string): boolean => { child.signalCode = "SIGKILL"; child.emit("close", null, "SIGKILL"); return true; },
  });
  let input = "";
  child.stdin.on("data", (chunk: Buffer) => { input += chunk.toString("utf8"); });
  vi.mocked(spawn).mockReturnValue(child as never);
  const job = await startWindowsUpdateJob("C:\\node.exe", ["private-argument"], { env: { SECRET: "private-value" }, cleanupTimeoutMs: 200, ...options });
  jobs.push(job);
  const request = JSON.parse(input.split("\n")[1]!);
  roots.push(request.directory);
  const publish = async (name: string, value: unknown) => {
    await writeFile(`${request.directory}/${name}.pending`, JSON.stringify(value));
    await rename(`${request.directory}/${name}.pending`, `${request.directory}/${name}`);
  };
  const ready = () => publish("ready.json", { version: 1, nonce: request.nonce, guardPid: child.pid });
  const receipt = (overrides: Record<string, unknown> = {}) => publish("receipt.json", {
    version: 1, nonce: request.nonce, guardPid: child.pid, jobEmpty: true, rootPid: 51873, code: 23, failure: null, ...overrides,
  });
  const launched = () => input.includes(`\nstart:${request.nonce}\n`);
  const close = (code = 0) => { child.exitCode = code; child.emit("close", code, null); };
  return { job, child, request, ready, receipt, launched, close, controls: () => input.split("\n").slice(2) };
}

describe("Windows job settlement protocol", () => {
  it("waits for positive empty-job evidence; root exit and output EOF do not complete custody", async () => {
    const f = await fixture(); await f.ready();
    await expect.poll(f.launched).toBe(true);
    f.child.stdout.end(); f.child.stderr.end();
    expect(await Promise.race([f.job.completed.then(() => "complete"), delay(80, "pending")])).toBe("pending");
    await f.receipt(); f.close();
    expect(await f.job.completed).toEqual({ code: 23, signal: null });
    await f.job.dispose();
    await expect(readFile(`${f.request.directory}/receipt.json`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([{ nonce: "foreign" }, { guardPid: 1 }, { jobEmpty: false }, { rootPid: 0, code: 0 }])("rejects mismatched or unproven receipt %j and retains files", async (record) => {
    const f = await fixture(); await f.ready(); await expect.poll(f.launched).toBe(true);
    await f.receipt(record); f.close();
    await expect(f.job.completed).rejects.toMatchObject({ custodyUnresolved: true });
    await expect(f.job.dispose()).rejects.toMatchObject({ custodyUnresolved: true });
    expect(await readFile(`${f.request.directory}/receipt.json`, "utf8")).not.toBe("");
  });

  it("remembers startup Abort before readiness and never grants target launch", async () => {
    const abort = new AbortController();
    const f = await fixture({ signal: abort.signal });
    abort.abort(); await f.ready(); await delay(80);
    expect(f.launched()).toBe(false);
    await f.receipt({ rootPid: 0, code: null }); f.close();
    await expect(f.job.cancel()).resolves.toBeUndefined();
    expect(await f.job.completed).toEqual({ code: null, signal: null });
  });

  it("does not infer settlement from a forced guard death during startup", async () => {
    const f = await fixture({ cleanupTimeoutMs: 30 });
    await expect(f.job.cancel()).rejects.toMatchObject({ custodyUnresolved: true });
    await expect(f.job.completed).rejects.toMatchObject({ custodyUnresolved: true });
    expect(f.launched()).toBe(false);
  });

  it("keeps cancellation bounded when the wall clock stops advancing", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const f = await fixture({ cleanupTimeoutMs: 30 });
    try {
      expect(await Promise.race([f.job.cancel().catch((error: unknown) => error), delay(250, "still waiting")]))
        .toMatchObject({ custodyUnresolved: true });
    } finally { clock.mockRestore(); }
  });

  it.each<InspectionPhase>(["open", "stat", "read", "close"])("bounds cancellation/disposal independently of a stalled receipt %s and ignores its late proof", async (phase) => {
    const f = await fixture({ cleanupTimeoutMs: 30 });
    await f.ready(); await expect.poll(f.launched).toBe(true);
    let release!: () => void; let entered!: () => void; let file: FileHandle | undefined;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    receiptRead.stalled = { name: "receipt.json", phase, wait: () => { entered(); return hold; }, opened: (value) => { file = value; } };
    let operations: Promise<unknown>[] = [];
    try {
      if (phase !== "open") await f.receipt();
      await reading;
      if (phase === "open") await f.receipt();
      operations = [f.job.cancel(), f.job.dispose(), f.job.completed].map((operation) => operation.then(() => "resolved", (error: unknown) => error));
      const outcomes = await Promise.race([Promise.all(operations), delay(250, ["still waiting"])]);
      expect(f.child.signalCode).toBe("SIGKILL");
      expect(outcomes).toHaveLength(3);
      for (const outcome of outcomes) expect(outcome).toMatchObject({ custodyUnresolved: true });
      expect(await readFile(`${f.request.directory}/receipt.json`, "utf8")).not.toBe("");
      release();
      await expect.poll(() => file?.fd).toBe(-1);
      // A valid but deadline-obsolete receipt must not retroactively authorize
      // helper deletion or convert the rejected operation into clean custody.
      await expect(f.job.dispose()).rejects.toMatchObject({ custodyUnresolved: true });
      expect(await readFile(`${f.request.directory}/receipt.json`, "utf8")).not.toBe("");
    } finally {
      release(); receiptRead.stalled = undefined;
      await Promise.all(operations);
    }
  });

  it("revokes a stalled readiness read so cancellation cannot grant a late target launch", async () => {
    const f = await fixture({ cleanupTimeoutMs: 30 });
    let release!: () => void; let entered!: () => void; let file: FileHandle | undefined;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    receiptRead.stalled = { name: "ready.json", phase: "open", wait: () => { entered(); return hold; }, opened: (value) => { file = value; } };
    let cancelled: Promise<unknown> | undefined;
    try {
      await reading; await f.ready();
      cancelled = f.job.cancel().catch((error: unknown) => error);
      expect(await Promise.race([cancelled, delay(250, "still waiting")])).toMatchObject({ custodyUnresolved: true });
      release(); await expect.poll(() => file?.fd).toBe(-1);
      expect(f.launched()).toBe(false);
      await expect(f.job.dispose()).rejects.toMatchObject({ custodyUnresolved: true });
    } finally { release(); receiptRead.stalled = undefined; await cancelled; }
  });

  it("does not accept a timed-out receipt during the forced-guard close grace period", async () => {
    const f = await fixture({ cleanupTimeoutMs: 30 });
    await f.ready(); await expect.poll(f.launched).toBe(true);
    let release!: () => void; let entered!: () => void; let force!: () => void; let file: FileHandle | undefined;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const forced = new Promise<void>((resolve) => { force = resolve; });
    f.child.kill = () => { force(); return true; };
    receiptRead.stalled = { name: "receipt.json", phase: "open", wait: () => { entered(); return hold; }, opened: (value) => { file = value; } };
    let cancelled: Promise<unknown> | undefined;
    try {
      await reading; await f.receipt();
      cancelled = f.job.cancel().then(() => "resolved", (error: unknown) => error);
      await forced;
      release(); await expect.poll(() => file?.fd).toBe(-1); await delay(0);
      f.close(1);
      expect(await cancelled).toMatchObject({ custodyUnresolved: true });
      await expect(f.job.dispose()).rejects.toMatchObject({ custodyUnresolved: true });
      expect(await readFile(`${f.request.directory}/receipt.json`, "utf8")).not.toBe("");
    } finally { release(); receiptRead.stalled = undefined; f.close(1); await cancelled; }
  });

  it("bounds final rejection even when guard kill never produces an exit or close event", async () => {
    const f = await fixture({ cleanupTimeoutMs: 30 });
    await f.ready(); await expect.poll(f.launched).toBe(true);
    let release!: () => void; let entered!: () => void; let file: FileHandle | undefined;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    f.child.kill = () => false;
    receiptRead.stalled = { name: "receipt.json", phase: "open", wait: () => { entered(); return hold; }, opened: (value) => { file = value; } };
    let operations: Promise<unknown>[] = [];
    try {
      await reading; await f.receipt();
      operations = [f.job.cancel(), f.job.dispose(), f.job.completed].map((operation) => operation.then(() => "resolved", (error: unknown) => error));
      const outcomes = await Promise.race([Promise.all(operations), delay(2500, ["still waiting"])]);
      expect(outcomes).toHaveLength(3);
      for (const outcome of outcomes) expect(outcome).toMatchObject({ custodyUnresolved: true });
      release(); await expect.poll(() => file?.fd).toBe(-1);
      f.close(1);
      await expect(f.job.dispose()).rejects.toMatchObject({ custodyUnresolved: true });
    } finally { release(); receiptRead.stalled = undefined; f.close(1); await Promise.all(operations); }
  });

  it("keeps setup failure distinct from unresolved custody and permits disposal", async () => {
    const f = await fixture(); await f.ready(); await expect.poll(f.launched).toBe(true);
    await f.receipt({ rootPid: 0, code: null, failure: "native-job-failed" }); f.close(71);
    await expect(f.job.completed).rejects.toThrow(/unavailable/);
    await expect(f.job.dispose()).resolves.toBeUndefined();
  });

  it("never treats guard exit zero without an empty-job receipt as success", async () => {
    const f = await fixture(); await f.ready(); await expect.poll(f.launched).toBe(true);
    f.close();
    await expect(f.job.completed).rejects.toMatchObject({ custodyUnresolved: true });
  });

  it("rejects a dead guard without waiting forever for pipes retained by an unproven descendant", async () => {
    const f = await fixture(); await f.ready(); await expect.poll(f.launched).toBe(true);
    f.child.exitCode = 1; f.child.emit("exit", 1, null);
    expect(await Promise.race([f.job.completed.catch((error: unknown) => error), delay(250, "still waiting")]))
      .toMatchObject({ custodyUnresolved: true });
    f.close(1);
  });

  it("rechecks the receipt after exit when an earlier missing-file read was still in flight", async () => {
    const f = await fixture(); await f.ready(); await expect.poll(f.launched).toBe(true);
    let release!: () => void; let entered!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    receiptRead.delayMissing = () => { entered(); return hold; };
    await reading;
    await f.receipt();
    f.child.exitCode = 0; f.child.emit("exit", 0, null); f.close();
    release();
    expect(await f.job.completed).toEqual({ code: 23, signal: null });
  });

  it("cancellation waits for the receipt and guard close, preserving the actual root exit code", async () => {
    const f = await fixture(); await f.ready(); await expect.poll(f.launched).toBe(true);
    const cancelled = f.job.cancel();
    expect(await Promise.race([cancelled.then(() => "complete"), delay(80, "pending")])).toBe("pending");
    await f.receipt();
    expect(await Promise.race([cancelled.then(() => "complete"), delay(80, "pending")])).toBe("pending");
    f.close(); await cancelled;
    expect(await f.job.completed).toEqual({ code: 23, signal: null });
  });
});
