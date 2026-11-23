import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNpmUpdateProcess } from "./npm-update-process";

describe("owned updater processes", () => {
  it.skipIf(process.platform === "win32")("retains group cleanup after the root closes while an ignored-stdio descendant ignores TERM", async () => {
    const root = mkdtempSync(join(tmpdir(), "npm-process-tree-"));
    const receipt = join(root, "child.pid");
    const childCode = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(receipt)},String(process.pid));setInterval(()=>{},100)`;
    const parentCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setInterval(()=>{},100)`;
    const abort = new AbortController();
    const running = runNpmUpdateProcess(process.execPath, ["-e", parentCode], { environment: {}, timeoutMs: 5000, signal: abort.signal, killAfterMs: 100 });
    const outcome = running.catch((error: unknown) => error);
    let pid: number | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(receipt)).toBe(true));
      pid = Number(readFileSync(receipt, "utf8"));
      abort.abort();
      expect(await outcome).toBeInstanceOf(Error);
      const alive = () => {
        try {
          if (process.platform === "linux") return !["Z", "X"].includes(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0]!);
          process.kill(pid!, 0); return true;
        } catch { return false; }
      };
      expect(alive()).toBe(false);
    } finally {
      abort.abort(); await outcome;
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("drains large output with a bounded capture and preserves argv literally", async () => {
    const result = await runNpmUpdateProcess(process.execPath, ["-e", "process.stdout.write(process.argv[1]);process.stderr.write('x'.repeat(300000))", "literal ; $HOME"], { environment: {}, timeoutMs: 5000 });
    expect(result.code, JSON.stringify(result)).toBe(0);
    expect(result.stdout).toBe("literal ; $HOME");
    expect(result.stderr.length).toBeLessThanOrEqual(8192);
  });
  it("aborts and joins a process that ignores ordinary termination", async () => {
    const abort = new AbortController();
    const running = runNpmUpdateProcess(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},100)"], { environment: {}, timeoutMs: 5000, signal: abort.signal, killAfterMs: 20 });
    setTimeout(() => abort.abort(), 100);
    await expect(running).rejects.toThrow(/cancel/i);
  });
  it("does not spawn on an already-aborted operation", async () => {
    await expect(runNpmUpdateProcess("/unavailable/executable", [], { environment: {}, timeoutMs: 100, signal: AbortSignal.abort() })).rejects.toThrow();
  });
});
