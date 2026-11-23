import { execFile, spawn } from "node:child_process";
import { copyFile, lstat, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { startWindowsUpdateJob, windowsUpdateCommandLine, type WindowsUpdateJob } from "./windows-update-job";
import { WINDOWS_UPDATE_JOB_SOURCE } from "./windows-update-job/host-source";

// These tests execute the real PowerShell 5 / Win32 adapter. They intentionally
// do not replace Windows process/job behavior with POSIX or process mocks.
describe.skipIf(process.platform !== "win32")("native Windows update Job Object custody", () => {
  let directory: string;
  let fixture: string;
  const jobs: WindowsUpdateJob[] = [];
  const evidence = new Map<WindowsUpdateJob, { stderr: Buffer; outcome?: unknown; cleanup?: unknown }>();
  let failureEvidence: unknown;
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "easyresearch-job-test-")));
    evidence.clear(); failureEvidence = undefined;
    onTestFailed(async () => {
      console.error("Windows job fixture evidence:", JSON.stringify(failureEvidence ?? await diagnostics()));
    });
    fixture = join(directory, "fixture with spaces.cjs");
    await writeFile(fixture, `
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const [mode, dir, ...args] = process.argv.slice(2);
const publish = (name, value) => {
  const target = path.join(dir, name);
  fs.writeFileSync(target + '.pending', JSON.stringify(value)); fs.renameSync(target + '.pending', target);
};
publish(mode + '-birth.json', {pid: process.pid, ppid: process.ppid,
  execPath: process.execPath, node: process.versions.node, bun: process.versions.bun, uv: process.versions.uv, cwd: process.cwd()});
if (mode === 'leaf') {
  process.on('SIGTERM', () => {});
  publish('leaf.json', {pid: process.pid});
  const timer = setInterval(() => fs.writeFileSync(path.join(dir, 'heartbeat'), String(Date.now())), 20);
  if (args[0] === 'finite') {
    const release = setInterval(() => {
      if (!fs.existsSync(path.join(dir, 'release'))) return;
      clearInterval(release); clearInterval(timer); fs.writeFileSync(path.join(dir, 'done'), 'done');
    }, 20);
  }
} else if (mode === 'tree') {
  const errors = fs.openSync(path.join(dir, 'leaf-stderr.log'), 'a');
  const leaf = cp.spawn(process.execPath, [__filename, 'leaf', dir, args[0]], {detached: true, stdio: ['ignore', 'ignore', errors]});
  fs.closeSync(errors);
  leaf.once('error', error => {
    publish('spawn-error.json', {phase: 'leaf-spawn', code: error.code, errno: error.errno, syscall: error.syscall});
    process.exit(87);
  });
  leaf.once('spawn', () => {
    publish('root.json', {pid: process.pid, childPid: leaf.pid});
    const born = setInterval(() => {
      if (fs.existsSync(path.join(dir, 'leaf.json'))) { clearInterval(born); process.exit(23); }
    }, 20);
    setTimeout(() => { publish('spawn-error.json', {phase: 'leaf-birth', code: 'ETIMEDOUT', pid: leaf.pid}); process.exit(87); }, 5000).unref();
  });
  leaf.unref();
} else if (mode === 'argv') {
  process.stdout.write(JSON.stringify({args, cwd: process.cwd(), value: process.env.JOB_UNICODE}));
} else if (mode === 'raw') {
  fs.writeSync(1, Buffer.from([0, 255, 128, 13, 10, 65]));
  fs.writeSync(2, Buffer.from([254, 0, 10, 66]));
  process.exit(41);
} else if (mode === 'marker') {
  fs.writeFileSync(path.join(dir, 'mutation'), 'started');
} else if (mode === 'flood') {
  const chunk = Buffer.alloc(65536, 97);
  for (let i = 0; i < 64; i++) fs.writeSync(1, chunk);
}
`, "utf8");
  });
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const job of jobs.splice(0)) {
      try { await job.dispose(); }
      catch (error) { evidence.get(job)!.cleanup = diagnosticError(error); errors.push(error); }
    }
    failureEvidence = await diagnostics();
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Native job fixture cleanup failed.");
    await rm(directory, { recursive: true, force: true });
  }, 20_000);

  const diagnosticError = (error: unknown) => {
    if (!error || typeof error !== "object") return { name: "UnknownError" };
    const value = error as Error & { diagnostics?: unknown; custodyUnresolved?: boolean };
    return { name: value.name, message: value.message, custodyUnresolved: value.custodyUnresolved, diagnostics: value.diagnostics };
  };
  const diagnostics = async () => {
    const records: Record<string, string | undefined> = {};
    for (const name of ["tree-birth.json", "leaf-birth.json", "root.json", "leaf.json", "spawn-error.json", "leaf-stderr.log"]) {
      const file = await open(join(directory, name), "r").catch(() => undefined);
      if (!file) continue;
      try {
        const info = await file.stat();
        const tail = Buffer.alloc(8192);
        const read = await file.read(tail, 0, tail.length, Math.max(0, info.size - tail.length));
        records[name] = tail.subarray(0, read.bytesRead).toString("utf8");
      } finally { await file.close(); }
    }
    return { runner: { execPath: process.execPath, node: process.versions.node, bun: process.versions.bun, uv: process.versions.uv }, directory, records,
      jobs: [...evidence.entries()].map(([job, data]) => ({ guardPid: job.child.pid, guardExitCode: job.child.exitCode, guardSignal: job.child.signalCode,
        outcome: data.outcome, cleanup: data.cleanup, stderr: data.stderr.toString("utf8") })) };
  };
  const observe = (job: WindowsUpdateJob) => {
    jobs.push(job);
    const data: { stderr: Buffer; outcome?: unknown; cleanup?: unknown } = { stderr: Buffer.alloc(0) };
    evidence.set(job, data);
    job.child.stderr.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      data.stderr = Buffer.concat([data.stderr, bytes.subarray(-8192)]).subarray(-8192);
    });
    void job.completed.then((result) => { data.outcome = result; }, (error: unknown) => { data.outcome = diagnosticError(error); });
    return job;
  };

  const launch = async (mode: string, args: string[] = [], options: Partial<Parameters<typeof startWindowsUpdateJob>[2]> = {}) => {
    const job = await startWindowsUpdateJob(process.execPath, [fixture, mode, directory, ...args], {
      ...options, env: { ...process.env, ...options.env, HOME: directory, USERPROFILE: directory, EASYRESEARCH_CODING_AGENT_DIR: join(directory, "agent") },
    });
    return observe(job);
  };
  const exists = async (name: string) => readFile(join(directory, name), "utf8").catch(() => undefined);
  const waitFile = async (name: string) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const value = await exists(name);
      if (value !== undefined) return value;
      await delay(25);
    }
    throw new Error(`Fixture did not publish ${name}.`);
  };
  const dead = (pid: number) => {
    try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
  };
  const compile = async (name: string, contents: string) => {
    const source = join(directory, `${name}.cs`);
    const compiler = join(directory, `${name}-compile.ps1`);
    const destination = join(directory, `${name}.exe`);
    await writeFile(source, contents);
    await writeFile(compiler, "param([string]$Source, [string]$Destination)\n$ErrorActionPreference = 'Stop'\nAdd-Type -Path $Source -OutputAssembly $Destination -OutputType ConsoleApplication -ReferencedAssemblies @('System.dll', 'System.Core.dll', 'System.Web.Extensions.dll') -WarningAction SilentlyContinue\n");
    const powershell = win32.join(process.env.SystemRoot ?? process.env.SYSTEMROOT!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await promisify(execFile)(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", compiler, source, destination], {
      timeout: 20_000, windowsHide: true, env: { ...process.env, HOME: directory, USERPROFILE: directory, EASYRESEARCH_CODING_AGENT_DIR: join(directory, "agent") },
    });
    return destination;
  };

  it("retains custody after root exit and closed target stdio, then cancels the surviving detached descendant", async () => {
    const job = await launch("tree", ["forever"]);
    job.child.stdout.resume(); job.child.stderr.resume();
    const leaf = JSON.parse(await waitFile("leaf.json"));
    const root = JSON.parse(await waitFile("root.json"));
    await expect.poll(() => dead(root.pid)).toBe(true);
    expect(dead(leaf.pid)).toBe(false);
    expect(await Promise.race([job.completed.then(() => "completed"), delay(150, "pending")])).toBe("pending");
    await job.cancel();
    expect(await job.completed).toEqual({ code: 23, signal: null });
    expect(dead(leaf.pid)).toBe(true);
  }, 40_000);

  it("normal completion waits for a descendant even though the root already exited", async () => {
    const job = await launch("tree", ["finite"]);
    job.child.stdout.resume(); job.child.stderr.resume();
    await waitFile("leaf.json");
    expect(await exists("done")).toBeUndefined();
    expect(await Promise.race([job.completed.then(() => "completed"), delay(100, "pending")])).toBe("pending");
    await writeFile(join(directory, "release"), "release");
    expect(await job.completed).toEqual({ code: 23, signal: null });
    expect(await exists("done")).toBe("done");
  }, 40_000);

  it("cancels during guard startup before the target can mutate files", async () => {
    const signal = new AbortController();
    const job = await launch("marker", [], { signal: signal.signal });
    signal.abort();
    await job.cancel();
    expect(await exists("mutation")).toBeUndefined();
    await expect(job.completed).resolves.toEqual({ code: null, signal: null });
  }, 40_000);

  it("parent-control EOF terminates the job even after the original target exited", async () => {
    const job = await launch("tree", ["forever"]);
    job.child.stdout.resume(); job.child.stderr.resume();
    const leaf = JSON.parse(await waitFile("leaf.json"));
    const root = JSON.parse(await waitFile("root.json"));
    await expect.poll(() => dead(root.pid)).toBe(true);
    job.child.stdin.end();
    expect(await job.completed).toEqual({ code: 23, signal: null });
    expect(dead(leaf.pid)).toBe(true);
  }, 40_000);

  it("AbortSignal terminates a running target even when it installs a graceful-termination handler", async () => {
    const abort = new AbortController();
    const job = await launch("leaf", ["forever"], { signal: abort.signal });
    job.child.stdout.resume(); job.child.stderr.resume();
    const target = JSON.parse(await waitFile("leaf.json"));
    abort.abort();
    const result = await job.completed;
    expect(result.code).not.toBe(0); expect(result.signal).toBeNull();
    expect(dead(target.pid)).toBe(true);
  }, 40_000);

  it("forwards byte-exact output and the target's exit code rather than the guard's", async () => {
    const job = await launch("raw");
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    job.child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    job.child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    expect(await job.completed).toEqual({ code: 41, signal: null });
    expect(Buffer.concat(stdout)).toEqual(Buffer.from([0, 255, 128, 13, 10, 65]));
    expect(Buffer.concat(stderr)).toEqual(Buffer.from([254, 0, 10, 66]));
  }, 40_000);

  it("fully removes its exact compiler/receipt directory after verified settlement, including under an administrator token", async () => {
    const original = { TEMP: process.env.TEMP, TMP: process.env.TMP };
    let job: WindowsUpdateJob;
    try {
      process.env.TEMP = directory; process.env.TMP = directory;
      job = await launch("raw");
    } finally {
      for (const key of ["TEMP", "TMP"] as const) {
        if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
      }
    }
    job.child.stdout.resume();
    const privateNames = (await readdir(directory)).filter((name) => name.startsWith("easyresearch-update-job-"));
    expect(privateNames).toHaveLength(1);
    const privateDirectory = await realpath(join(directory, privateNames[0]!));
    expect(await job.completed).toEqual({ code: 41, signal: null });
    const bootstrap = (await readFile(join(privateDirectory, "bootstrap.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(bootstrap.length).toBeGreaterThan(0);
    expect(bootstrap.every((entry) => entry.guardPid === job.child.pid && Number.isFinite(entry.utcMs))).toBe(true);
    await job.dispose();
    await expect(lstat(privateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  }, 40_000);

  it("preserves Unicode/space/quote argv, cwd and environment through explicit UTF-8 input", async () => {
    const args = ["", "space value", 'quote"value', "trailing space\\", "雪 😀", "\\\\server\\x"];
    const job = await launch("argv", args, { cwd: directory, env: { ...process.env, JOB_UNICODE: "凭证 λ 😀" } });
    let output = ""; job.child.stdout.setEncoding("utf8");
    job.child.stdout.on("data", (chunk: string) => { output += chunk; }); job.child.stderr.resume();
    await job.completed;
    expect(JSON.parse(output)).toEqual({ args, cwd: directory, value: "凭证 λ 😀" });
  }, 40_000);

  it("admits a large two-frame initialization within the existing five-second probe budget", async () => {
    const env: NodeJS.ProcessEnv = { JOB_UNICODE: "雪 🙂 λ" };
    for (let index = 0; index < 16; index++) env[`JOB_PADDING_${index}`] = "x".repeat(8192);
    const job = await launch("argv", ["literal argument"], { env, cwd: directory, signal: AbortSignal.timeout(5000) });
    let output = ""; job.child.stdout.setEncoding("utf8");
    job.child.stdout.on("data", (chunk: string) => { output += chunk; });
    expect(await job.completed).toEqual({ code: 0, signal: null });
    expect(JSON.parse(output)).toEqual({ args: ["literal argument"], cwd: directory, value: "雪 🙂 λ" });
  }, 40_000);

  it("does not wrap NSIS's raw final /D= directory in quotes", async () => {
    const script = join(directory, "raw-command-line.ps1");
    await writeFile(script, "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n[Console]::Write([Environment]::CommandLine)\n");
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT!;
    const destination = "/D=C:\\用户 files\\EasyResearch";
    const job = await startWindowsUpdateJob(win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", `"${script}"`, "/S", destination],
      { env: { ...process.env, HOME: directory, USERPROFILE: directory, EASYRESEARCH_CODING_AGENT_DIR: join(directory, "agent") }, windowsVerbatimArguments: true });
    observe(job);
    let output = ""; job.child.stdout.setEncoding("utf8");
    job.child.stdout.on("data", (chunk: string) => { output += chunk; }); job.child.stderr.resume();
    expect((await job.completed).code).toBe(0);
    expect(output.endsWith(`/S ${destination}`)).toBe(true);
  }, 40_000);

  it("drains large raw output with bounded caller buffers", async () => {
    const job = await launch("flood");
    let bytes = 0; let tail = Buffer.alloc(0);
    job.child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; tail = Buffer.concat([tail, chunk]).subarray(-8192); });
    job.child.stderr.resume();
    await job.completed;
    expect(bytes).toBe(4 * 1024 * 1024); expect(tail.length).toBe(8192);
  }, 40_000);

  it("fails before target creation when native source preflight is unavailable", async () => {
    await expect(startWindowsUpdateJob(join(directory, "missing.exe"), ["secret-argument"], { env: { ...process.env } })).rejects.toThrow();
    expect(await exists("mutation")).toBeUndefined();
  });

  it("settles native setup failure without executing the invalid target or retaining helper custody", async () => {
    const invalid = join(directory, "invalid-image.exe");
    // Pass the source preflight, then exercise real CreateProcessW failure in an
    // already configured job. No script/command fallback may execute this file.
    await writeFile(invalid, "MZinvalid image");
    const job = await startWindowsUpdateJob(invalid, ["private-argument"], { env: { ...process.env } });
    observe(job); job.child.stdout.resume(); job.child.stderr.resume();
    await expect(job.completed).rejects.toThrow();
    await expect(job.dispose()).resolves.toBeUndefined();
    expect(await exists("mutation")).toBeUndefined();
  }, 40_000);

  it("a kernel job-limit setup failure never runs the mutation target", async () => {
    const limiterPath = await compile("limit", JOB_LIMIT_FIXTURE);
    const job = await launch("marker");
    job.child.stdout.resume(); job.child.stderr.resume();
    // Hold the private launch grant at the real transport boundary until the
    // guard is in an outer kernel job with a one-process limit. The guard has
    // already finished Add-Type when it requests this grant. No product test
    // switch or copied implementation is involved.
    const write = job.child.stdin.write;
    let release!: () => void;
    let offered!: () => void;
    const grant = new Promise<void>((resolve) => { offered = resolve; });
    job.child.stdin.write = function (this: typeof job.child.stdin, ...parameters: Parameters<typeof write>) {
      const text = Buffer.isBuffer(parameters[0]) ? parameters[0].toString("utf8") : parameters[0];
      if (typeof text === "string" && text.startsWith("start:")) {
        release = () => { write.apply(this, parameters); }; offered(); return true;
      }
      return write.apply(this, parameters);
    } as typeof write;
    await within(grant, 20_000);
    const limiter = spawn(limiterPath, [String(job.child.pid)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    limiter.stderr.resume();
    const stopped = new Promise<void>((resolve) => limiter.once("close", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error("Job-limit fixture did not become ready.")), 5000);
        const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
        limiter.once("error", (error) => finish(error));
        limiter.once("close", () => finish(new Error("Job-limit fixture failed.")));
        limiter.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.includes("\n") || output.length > 128) finish(output.trim() === "ready" ? undefined : new Error("Invalid job-limit fixture response."));
        });
      });
      release();
      await expect(job.completed).rejects.toThrow(/unavailable/);
      await expect(job.dispose()).resolves.toBeUndefined();
      expect(await exists("mutation")).toBeUndefined();
    } finally {
      job.child.stdin.write = write;
      limiter.stdin.end();
      try { await within(stopped, 5000); }
      catch { limiter.kill("SIGKILL"); await within(stopped, 2000); throw new Error("Job-limit fixture did not stop normally."); }
    }
  }, 60_000);

  it("creation itself binds the still-suspended target: guard death releases both its process and executable lock", async () => {
    // Execute the actual native creation method, stopping before its caller can
    // assign a job or resume a thread. The independent host owns the job handle;
    // killing that host must terminate the suspended target through the kernel.
    const probePath = await compile("suspended-custody", WINDOWS_UPDATE_JOB_SOURCE + SUSPENDED_CUSTODY_FIXTURE);
    const target = join(directory, "suspended target.exe");
    await copyFile(process.execPath, target);
    const probe = spawn(probePath, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    probe.stderr.resume();
    const stopped = new Promise<void>((resolve) => probe.once("close", () => resolve()));
    let failure: Error | undefined;
    probe.on("error", (error) => { failure = error; });
    let output = "";
    probe.stdout.setEncoding("utf8"); probe.stdout.on("data", (chunk: string) => { output += chunk; });
    try {
      probe.stdin.write(`${JSON.stringify({
        command: target, commandLine: windowsUpdateCommandLine(target, [fixture, "marker", directory]), cwd: directory,
        environment: `HOME=${directory}\0SystemRoot=${process.env.SystemRoot ?? process.env.SYSTEMROOT}\0USERPROFILE=${directory}\0\0`,
      })}\n`, "utf8");
      await expect.poll(() => {
        if (failure) throw failure;
        if (probe.exitCode !== null && !output.includes("\n")) throw new Error("Native suspended-custody fixture failed.");
        return output.includes("\n");
      }, { timeout: 10_000 }).toBe(true);
      const observed = JSON.parse(output.trim());
      expect(observed.inJob).toBe(true);
      expect(dead(observed.pid)).toBe(false);
      expect(await exists("mutation")).toBeUndefined();
      probe.kill("SIGKILL");
      await within(stopped, 5000);
      await expect.poll(() => dead(observed.pid), { timeout: 5000 }).toBe(true);
      const writable = await open(target, "r+"); await writable.close();
      expect(await exists("mutation")).toBeUndefined();
    } finally {
      // On a failed membership assertion, normal EOF lets the fixture release
      // its still-owned process HANDLE; never abandon a regression's child.
      if (probe.exitCode === null && probe.signalCode === null) probe.stdin.end();
      try { await within(stopped, 5000); }
      catch { probe.kill("SIGKILL"); await within(stopped, 2000); throw new Error("Suspended-custody fixture did not stop normally."); }
    }
  }, 60_000);

  it("rejects native job-list admission failure without an unassigned-creation fallback", async () => {
    const probePath = await compile("rejected-custody", WINDOWS_UPDATE_JOB_SOURCE + SUSPENDED_CUSTODY_FIXTURE);
    const probe = spawn(probePath, ["invalid-job"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; probe.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); }); probe.stderr.resume();
    const stopped = new Promise<number | null>((resolve, reject) => {
      probe.once("error", reject); probe.once("close", (code) => resolve(code));
    });
    try {
      probe.stdin.end(`${JSON.stringify({
        command: process.execPath, commandLine: windowsUpdateCommandLine(process.execPath, [fixture, "marker", directory]), cwd: directory,
        environment: `HOME=${directory}\0SystemRoot=${process.env.SystemRoot ?? process.env.SYSTEMROOT}\0USERPROFILE=${directory}\0\0`,
      })}\n`, "utf8");
      expect(await within(stopped, 10_000)).toBe(71);
      expect(output).toBe("");
      expect(await exists("mutation")).toBeUndefined();
    } finally {
      if (probe.exitCode === null && probe.signalCode === null) probe.kill("SIGKILL");
      await within(stopped, 5000);
    }
  }, 60_000);

  it("kill-on-close kills descendants after forced guard death but does not claim an empty-job receipt", async () => {
    const job = await launch("tree", ["forever"]);
    job.child.stdout.resume(); job.child.stderr.resume();
    const leaf = JSON.parse(await waitFile("leaf.json"));
    expect(dead(leaf.pid)).toBe(false);
    job.child.kill("SIGKILL"); // The owned guard handle, never an arbitrary target PID.
    await expect(job.completed).rejects.toMatchObject({ custodyUnresolved: true });
    await expect.poll(() => dead(leaf.pid), { timeout: 5000 }).toBe(true);
    await expect(job.dispose()).rejects.toMatchObject({ custodyUnresolved: true });
    jobs.splice(jobs.indexOf(job), 1); // Intentional unresolved receipt remains for diagnosis.
  }, 40_000);
});

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Native job fixture timed out.")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// An independent Windows job fixture: only the already-owned guard PID joins a
// one-process job. Its target creation must then fail in the kernel before any
// target instruction runs. The fixture's stdin owns the job handle's lifetime.
const JOB_LIMIT_FIXTURE = String.raw`
using System;
using System.Runtime.InteropServices;
public static class JobLimitFixture {
  [StructLayout(LayoutKind.Sequential)] struct Limit {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limit info, uint size);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Main(string[] args) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null), process = IntPtr.Zero;
    try {
      Limit limit = new Limit(); limit.Flags = 2; limit.ActiveProcesses = 1;
      process = OpenProcess(0x101, false, Int32.Parse(args[0]));
      if (job == IntPtr.Zero || process == IntPtr.Zero ||
          !SetInformationJobObject(job, 2, ref limit, (uint)Marshal.SizeOf(typeof(Limit))) ||
          !AssignProcessToJobObject(job, process)) return 71;
      Console.WriteLine("ready"); Console.ReadLine(); return 0;
    } finally {
      if (job != IntPtr.Zero) { TerminateJobObject(job, 1); CloseHandle(job); }
      if (process != IntPtr.Zero) CloseHandle(process);
    }
  }
}
`;

const SUSPENDED_CUSTODY_FIXTURE = String.raw`
namespace EasyResearch.JobNativeTests {
  using System;
  using System.IO;
  using System.Reflection;
  using System.Runtime.InteropServices;
  using System.Text;
  using System.Web.Script.Serialization;
  public static class SuspendedCustodyFixture {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
      public long ProcessTime, JobTime; public uint Flags;
      public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
      public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct Io {
      public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct Limit {
      public BasicLimit Basic; public Io Io;
      public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limit info, uint size);
    [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inside);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static int Main(string[] args) {
      IntPtr job = CreateJobObjectW(IntPtr.Zero, null), process = IntPtr.Zero, thread = IntPtr.Zero;
      try {
        Limit limit = new Limit(); limit.Basic.Flags = 0x2000;
        if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limit, (uint)Marshal.SizeOf(typeof(Limit)))) return 71;
        StreamReader reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true));
        JobRequest request = new JavaScriptSerializer().Deserialize<JobRequest>(reader.ReadLine());
        MethodInfo create = typeof(WindowsUpdateJobHost).GetMethod("CreateSuspended", BindingFlags.NonPublic | BindingFlags.Static);
        object result = create.Invoke(null, new object[] { request, args.Length == 0 ? job : new IntPtr(-1) });
        process = (IntPtr)result.GetType().GetField("Process").GetValue(result);
        thread = (IntPtr)result.GetType().GetField("Thread").GetValue(result);
        uint pid = (uint)result.GetType().GetField("ProcessId").GetValue(result);
        bool inside;
        if (!IsProcessInJob(process, job, out inside)) return 71;
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { pid = pid, inJob = inside }));
        reader.ReadLine(); return 0;
      } catch { return 71; }
      finally {
        if (process != IntPtr.Zero) { TerminateProcess(process, 1); WaitForSingleObject(process, 5000); CloseHandle(process); }
        if (thread != IntPtr.Zero) CloseHandle(thread);
        if (job != IntPtr.Zero) CloseHandle(job);
      }
    }
  }
}
`;
