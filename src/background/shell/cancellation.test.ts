import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createManagedShellManager, type ShellNotification, type ShellResult } from "./index";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("foreground cancellation ownership", () => {
  it.each(["timer", "explicit"] as const)("cancellation wins %s promotion while the transport is still stopping", async (promotion) => {
    const cwd = await mkdtemp(join(tmpdir(), "shell-cancel-"));
    const manager = createManagedShellManager({ agentDir: cwd, cwd, rootSessionID: "root", worker: false });
    const started = gate();
    const cleanup = gate();
    const notices: ShellNotification[] = [];
    manager.attachOwner({ sessionID: "root", cwd, notify: async (notice) => { notices.push(notice); } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let call: Promise<ShellResult> | undefined;
    try {
      const abort = new AbortController();
      let response: ShellResult | undefined;
      call = manager.executeRemote("root", { command: "gated transport", timeout: 100 }, async ({ signal, onOutput }) => {
        onOutput("captured before Stop\n");
        started.release();
        await cleanup.promise;
        expect(signal.aborted).toBe(true);
        onOutput("cleanup tail\n");
        return { exitCode: null, signal: "TERM" };
      }, abort.signal);
      void call.then((result) => { response = result; });
      await started.promise;
      abort.abort();
      if (promotion === "explicit") await manager.promote("root");
      await vi.advanceTimersByTimeAsync(499);
      expect(response).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(response).toMatchObject({ status: "cancelled", truncated: true, incomplete: true });
      expect(response?.output).toContain("captured before Stop");
      expect(response?.output).toContain("incomplete");
      expect(response?.outputPath).toBe(manager.tasks()[0]?.outputPath);
      expect(manager.tasks()[0]).toMatchObject({ status: "running", blocking: false });
      expect(manager.hasWork()).toBe(true);
      const recordPath = manager.tasks()[0]!.outputPath!.replace(/\.out$/, ".json");
      expect(JSON.parse(await readFile(recordPath, "utf8")).result).toBeUndefined();

      let disposed = false;
      const disposal = manager.dispose().then(() => { disposed = true; });
      await vi.advanceTimersByTimeAsync(500);
      expect(disposed).toBe(false);
      cleanup.release();
      await disposal;
      expect(manager.hasWork()).toBe(false);
      expect(JSON.parse(await readFile(recordPath, "utf8")).result.status).toBe("cancelled");
      expect(await readFile(response!.outputPath!, "utf8")).toBe("captured before Stop\ncleanup tail\n");
      expect(notices).toEqual([]);
    } finally {
      cleanup.release();
      vi.useRealTimers();
      await call;
      await manager.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
