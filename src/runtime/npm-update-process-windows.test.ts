import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runNpmUpdateProcess } from "./npm-update-process";
import { startWindowsUpdateJob, type WindowsUpdateJob } from "./windows-update-job";
import { npmInstallArguments } from "./npm-update-provenance";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("./windows-update-job", () => ({ startWindowsUpdateJob: vi.fn() }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => { Object.defineProperty(process, "platform", { value: "win32" }); vi.useFakeTimers(); });
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.useRealTimers(); vi.resetAllMocks(); });
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const child = Object.assign(new EventEmitter(), { pid: 4321, exitCode: null as number | null, signalCode: null as string | null, stdin: { write: vi.fn(), end: vi.fn() }, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  const completion = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const dispose = vi.fn(async () => {});
  const job = { child, completed: completion.promise, cancel: vi.fn(async () => {}), dispose } as unknown as WindowsUpdateJob;
  vi.mocked(startWindowsUpdateJob).mockResolvedValue(job);
  return { child, completion, job, dispose };
}
const admitted = async () => { await vi.waitFor(() => expect(startWindowsUpdateJob).toHaveBeenCalledOnce()); };

describe("Windows npm consumer job ownership", () => {
  it("uses fixed Node/npm argv and the sanitized All-traffic environment through the job adapter", async () => {
    const f = fixture(); const prefix = "C:\\Users\\O'Brien\\npm prefix";
    const args = ["C:\\Node\\node_modules\\npm\\bin\\npm-cli.js", ...npmInstallArguments(prefix, "2.0.0")];
    const done = runNpmUpdateProcess("C:\\Node\\node.exe", args, { cwd: "C:\\isolated agent", environment: { HTTPS_PROXY: "http://all.example:8080", NODE_OPTIONS: "--unsafe-preload", Node_Options: "--other-preload", NODE_PATH: "untrusted", node_path: "other-path", EASYRESEARCH_NPM_PROVENANCE: "private-carrier", easyresearch_npm_provenance: "other-carrier", KEEP: "yes" }, timeoutMs: 10000 });
    const outcome = done.catch((error: unknown) => error); await admitted();
    expect(startWindowsUpdateJob).toHaveBeenCalledWith("C:\\Node\\node.exe", args, expect.objectContaining({ cwd: "C:\\isolated agent", env: { HTTPS_PROXY: "http://all.example:8080", KEEP: "yes" }, windowsVerbatimArguments: false }));
    f.completion.resolve({ code: 0, signal: null });
    expect(await outcome).toMatchObject({ code: 0 });
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("waits for job completion after guard close and uses target exit code with bounded raw output", async () => {
    const f = fixture(); let settled = false;
    const done = runNpmUpdateProcess("C:\\candidate.exe", ["--version"], { environment: {}, timeoutMs: 10000 }).then((result) => { settled = true; return result; });
    const outcome = done.catch((error: unknown) => error); await admitted();
    f.child.stdout.write(Buffer.alloc(300000, 97)); f.child.stdout.write(Buffer.from([0, 13, 10, 90]));
    f.child.stderr.write(Buffer.alloc(300000, 98)); f.child.stderr.write("tail");
    f.child.emit("exit", 0); f.child.emit("close", 0);
    await Promise.resolve(); expect(settled).toBe(false);
    f.completion.resolve({ code: 41, signal: null });
    const result = await outcome as Awaited<ReturnType<typeof runNpmUpdateProcess>>;
    expect(result.code).toBe(41); expect(Buffer.byteLength(result.stdout)).toBe(8192);
    expect(result.stdout.endsWith("\0\r\nZ")).toBe(true); expect(result.stderr.length).toBe(8192); expect(result.stderr.endsWith("tail")).toBe(true);
    expect(f.child.stdin.write).not.toHaveBeenCalled(); expect(f.child.kill).not.toHaveBeenCalled();
  });

  it.each(["abort", "deadline"])("forwards %s and retains custody until the adapter reports settlement", async (cause) => {
    const f = fixture(); const abort = new AbortController(); let settled = false;
    const outcome = runNpmUpdateProcess("C:\\node.exe", ["--version"], { environment: {}, timeoutMs: 200, signal: abort.signal }).catch((error: unknown) => { settled = true; return error; });
    await admitted(); const signal = vi.mocked(startWindowsUpdateJob).mock.calls[0]![2].signal!;
    if (cause === "abort") abort.abort(); else await vi.advanceTimersByTimeAsync(200);
    expect(signal.aborted).toBe(true); expect(settled).toBe(false);
    f.completion.resolve({ code: 1, signal: null });
    expect(await outcome).toBeInstanceOf(Error);
    expect(f.dispose).toHaveBeenCalledOnce(); expect(f.child.kill).not.toHaveBeenCalled();
  });

  it("keeps the deadline active while adapter startup is pending", async () => {
    const f = fixture(); const startup = deferred<WindowsUpdateJob>();
    vi.mocked(startWindowsUpdateJob).mockReturnValue(startup.promise);
    let settled = false;
    const outcome = runNpmUpdateProcess("C:\\node.exe", [], { environment: {}, timeoutMs: 200 }).catch((error: unknown) => { settled = true; return error; });
    await admitted(); await vi.advanceTimersByTimeAsync(200);
    expect(vi.mocked(startWindowsUpdateJob).mock.calls[0]![2].signal!.aborted).toBe(true); expect(settled).toBe(false);
    startup.resolve(f.job); f.completion.resolve({ code: null, signal: null });
    expect(await outcome).toBeInstanceOf(Error); expect(f.dispose).toHaveBeenCalledOnce();
  });

  it("never converts unresolved job or disposal failure into successful npm completion", async () => {
    for (const completedFails of [true, false]) {
      vi.mocked(startWindowsUpdateJob).mockClear();
      const f = fixture(); const failure = Object.assign(new Error("tree unproven"), { custodyUnresolved: true });
      f.dispose.mockRejectedValue(failure);
      const outcome = runNpmUpdateProcess("C:\\node.exe", [], { environment: {}, timeoutMs: 10000 }).catch((error: unknown) => error);
      await admitted();
      if (completedFails) f.completion.reject(failure); else f.completion.resolve({ code: 0, signal: null });
      expect(await outcome).toMatchObject({ custodyUnresolved: true });
      expect(f.dispose).toHaveBeenCalledOnce();
    }
  });

  it("does not launch an unowned fallback when native job admission is unavailable", async () => {
    vi.mocked(startWindowsUpdateJob).mockRejectedValue(new Error("native job unavailable"));
    await expect(runNpmUpdateProcess("C:\\node.exe", [], { environment: {}, timeoutMs: 10000 })).rejects.toThrow(/unavailable/);
    expect(spawn).not.toHaveBeenCalled(); expect(spawnSync).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an already-aborted operation without admitting any job", async () => {
    await expect(runNpmUpdateProcess("C:\\node.exe", [], { environment: {}, timeoutMs: 10000, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(startWindowsUpdateJob).not.toHaveBeenCalled();
  });
});
