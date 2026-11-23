import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createManagedShellManager, type ManagedShellService, type ShellNotification } from "./index";
import * as workers from "./worker-client";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe.skipIf(process.platform === "win32")("terminal Exit racing prepared shell detach", () => {
  it.each(["before-ack", "after-ack", "after-adopt"] as const)("revokes authenticated custody %s without stale publication", async (phase) => {
    const cwd = await mkdtemp(join(tmpdir(), "shell-revoke-race-"));
    const reached = gate();
    const proceed = gate();
    const launch = workers.launchShellWorker;
    // Keep the real worker, socket authentication, process and disk writes. Hold
    // only detach's acknowledgement boundary, which the caller cannot observe yet.
    const spy = vi.spyOn(workers, "launchShellWorker").mockImplementation(async (...args) => {
      const worker = await launch(...args);
      const detach = worker.detach.bind(worker);
      worker.detach = async () => {
        if (phase !== "before-ack") await detach();
        reached.release();
        await proceed.promise;
        if (phase === "before-ack") await detach();
      };
      return worker;
    });
    const options = { agentDir: cwd, cwd, rootSessionID: "root", worker: {
      executable: execFileSync("which", ["bun"], { encoding: "utf8" }).trim(),
      args: [resolve("src/cli/index.ts"), "--shell-worker"],
    } };
    const manager = createManagedShellManager(options);
    let successor: ManagedShellService | undefined;
    let disposal: Promise<void> | undefined;
    try {
      manager.attachOwner({ sessionID: "root", cwd, notify: async () => {} });
      const command = await manager.execute("root", { command: "echo once >> count; sleep 30", background: true });
      await manager.prepareHandoff();
      disposal = manager.dispose({ handoff: true });
      // Attach rejection ownership immediately, including the intentionally red run.
      void disposal.catch(() => {});
      await reached.promise;
      const recordPath = command.outputPath!.replace(/\.out$/, ".json");
      const notices: ShellNotification[] = [];
      if (phase === "after-adopt") {
        successor = createManagedShellManager(options);
        successor.attachOwner({ sessionID: "root", cwd, notify: async (notice) => { notices.push(notice); } });
        await successor.recover({ verifyPriorOwner: async () => true });
      }
      const prior = JSON.parse(await readFile(recordPath, "utf8"));
      await manager.revokeHandoff();
      expect(() => process.kill(command.pid!, 0)).toThrow();
      expect(() => process.kill(prior.worker.workerPID, 0)).toThrow();
      if (successor) await expect.poll(() => notices.length).toBe(1);
      proceed.release();
      await disposal;
      const terminal = JSON.parse(await readFile(recordPath, "utf8"));
      expect(terminal.owner).toEqual(prior.owner);
      expect(terminal.worker.token).toBe(prior.worker.token);
      expect(terminal.handoff).toBeUndefined();
      expect(terminal.result.status).toBe("cancelled");
      if (successor) {
        await expect.poll(() => successor!.hasWork()).toBe(false);
        expect(terminal.pending).toBe(false);
      }
      const bytes = await readFile(recordPath, "utf8");
      const published = await stat(recordPath);
      await manager.revokeHandoff();
      expect(await readFile(recordPath, "utf8")).toBe(bytes);
      expect((await stat(recordPath)).ino).toBe(published.ino);
      expect(await readFile(join(cwd, "count"), "utf8")).toBe("once\n");
    } finally {
      proceed.release();
      await disposal?.catch(() => {});
      await manager.revokeHandoff();
      await successor?.dispose();
      await manager.dispose();
      spy.mockRestore();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
