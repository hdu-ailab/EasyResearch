import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createManagedShellManager, type ShellResult } from "./index";
import * as workers from "./worker-client";

describe.skipIf(process.platform === "win32")("foreground Stop during worker admission", () => {
  it("returns the bounded call response while retaining an unacknowledged spawned worker", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "shell-stop-admission-"));
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const proceed = new Promise<void>((resolve) => { release = resolve; });
    const launch = workers.launchShellWorker;
    let pid: number | undefined;
    const spy = vi.spyOn(workers, "launchShellWorker").mockImplementation(async (...args) => {
      const worker = await launch(...args);
      pid = worker.pid;
      entered();
      await proceed;
      return worker;
    });
    const manager = createManagedShellManager({ agentDir: cwd, cwd, rootSessionID: "root", worker: {
      executable: execFileSync("which", ["bun"], { encoding: "utf8" }).trim(),
      args: [resolve("src/cli/index.ts"), "--shell-worker"],
    } });
    let call: Promise<ShellResult> | undefined;
    try {
      manager.attachOwner({ sessionID: "root", cwd, notify: async () => {} });
      const abort = new AbortController();
      let response: ShellResult | undefined;
      call = manager.execute("root", { command: "printf captured; sleep 30" }, abort.signal);
      void call.then((result) => { response = result; });
      await ready;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      abort.abort();
      await vi.advanceTimersByTimeAsync(500);
      expect(response).toMatchObject({ status: "cancelled", incomplete: true });
      expect(manager.hasWork()).toBe(true);
      expect(() => process.kill(pid!, 0)).not.toThrow();
      const record = JSON.parse(await readFile(manager.tasks()[0]!.outputPath!.replace(/\.out$/, ".json"), "utf8"));
      expect(record.result).toBeUndefined();
      vi.useRealTimers();
      release();
      await manager.dispose();
      expect(() => process.kill(pid!, 0)).toThrow();
      expect(manager.hasWork()).toBe(false);
    } finally {
      vi.useRealTimers();
      release();
      await call;
      await manager.dispose();
      spy.mockRestore();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
