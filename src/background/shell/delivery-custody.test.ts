import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createManagedShellManager, type ManagedShellService, type ShellNotification } from "./index";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe.skipIf(process.platform === "win32")("shell process custody versus notification admission", () => {
  it.each([
    ["handoff", "admitted"], ["handoff", "recipient-closed"],
    ["cancel", "admitted"], ["cancel", "recipient-closed"],
  ] as const)("finishes %s custody while notification remains owned (%s)", async (action, admission) => {
    const cwd = await mkdtemp(join(tmpdir(), "shell-delivery-custody-"));
    const entered = gate();
    const recipient = gate();
    const notices: ShellNotification[] = [];
    const manager = createManagedShellManager({ agentDir: cwd, cwd, rootSessionID: "root", worker: {
      executable: execFileSync("which", ["bun"], { encoding: "utf8" }).trim(),
      args: [resolve("src/cli/index.ts"), "--shell-worker"],
    } });
    let recovery: ManagedShellService | undefined;
    let custody: Promise<void> | undefined;
    let disposal: Promise<void> | undefined;
    manager.attachOwner({ sessionID: "root", cwd, notify: async (notice) => {
      notices.push(notice);
      entered.release();
      await recipient.promise;
      if (admission === "recipient-closed") throw new Error("Recipient closed before admission.");
    } });
    try {
      const call = await manager.execute("root", { command: "printf captured", background: true });
      await entered.promise;
      const recordPath = call.outputPath!.replace(/\.out$/, ".json");
      const finished = JSON.parse(await readFile(recordPath, "utf8"));
      expect(finished).toMatchObject({ pending: true, result: { status: "completed", output: "captured" } });
      let custodyFinished = false;
      custody = (action === "handoff" ? manager.prepareHandoff() : manager.cancel(call.shellID!))
        .then(() => { custodyFinished = true; });
      await expect.poll(() => custodyFinished, { timeout: 1000 }).toBe(true);
      expect(() => process.kill(finished.worker.workerPID, 0)).toThrow();
      expect(manager.hasWork()).toBe(true);
      expect(JSON.parse(await readFile(recordPath, "utf8")).pending).toBe(true);
      expect(await readFile(call.outputPath!, "utf8")).toBe("captured");

      disposal = manager.dispose(action === "handoff" ? { handoff: true } : undefined);
      // An event-loop barrier, not a sleep for command completion: all process
      // cleanup above has finished, but disposal must still own this callback.
      expect(await Promise.race([
        disposal.then(() => "disposed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("delivery still owned"), 0)),
      ])).toBe("delivery still owned");
      recipient.release();
      await disposal;
      expect(notices).toHaveLength(1);
      const persisted = JSON.parse(await readFile(recordPath, "utf8"));
      expect(persisted.pending).toBe(admission === "recipient-closed");
      expect(persisted.result).toEqual(finished.result);

      recovery = createManagedShellManager({ agentDir: cwd, cwd, rootSessionID: "root", worker: false });
      const replay: ShellNotification[] = [];
      recovery.attachOwner({ sessionID: "root", cwd, notify: async (notice) => { replay.push(notice); } });
      await recovery.recover({ verifyPriorOwner: async () => true });
      expect(replay.map((notice) => notice.id)).toEqual(admission === "recipient-closed" ? [notices[0]!.id] : []);
      expect(recovery.hasWork()).toBe(false);
      expect(await readFile(call.outputPath!, "utf8")).toBe("captured");
    } finally {
      recipient.release();
      await custody;
      await disposal;
      await manager.dispose();
      await recovery?.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
