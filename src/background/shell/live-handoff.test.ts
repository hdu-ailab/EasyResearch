import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createManagedShellManager, type ShellNotification } from "./index";

describe.skipIf(process.platform === "win32")("authenticated handoff while the predecessor waits for readiness", () => {
  it.each(["valid", "forged", "absent", "expired"] as const)("adopts only valid prepared custody from a live process (%s)", async (custody) => {
    const cwd = await mkdtemp(join(tmpdir(), "shell-live-handoff-"));
    const bun = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
    const fixture = join(cwd, "predecessor.ts");
    await writeFile(fixture, `
      import {createManagedShellManager} from ${JSON.stringify(resolve("src/background/shell/index.ts"))};
      const cwd = ${JSON.stringify(cwd)};
      const manager = createManagedShellManager({agentDir:cwd,cwd,rootSessionID:'root',worker:{executable:process.execPath,args:[${JSON.stringify(resolve("src/cli/index.ts"))},'--shell-worker']}});
      manager.attachOwner({sessionID:'root',cwd,notify:async()=>{throw new Error('outbox retained for successor');}});
      try {
        await manager.execute('root',{command:'echo history',background:false});
        const finished = new Promise<void>(resolve => {
          const unsubscribe = manager.subscribe(() => {
            if (!manager.tasks().some(task => task.description === 'echo durable-report' && task.status === 'completed')) return;
            unsubscribe(); resolve();
          });
        });
        await manager.execute('root',{command:'echo durable-report',background:true});
        await finished;
        const result = await manager.execute('root',{command:'echo once >> count; sleep 30',background:true});
        await manager.prepareHandoff();
        await manager.dispose({handoff:true});
        console.log(JSON.stringify(result));
        for await (const _ of process.stdin) break;
      } finally { await manager.revokeHandoff(); await manager.dispose(); }
    `);
    const child = spawn(bun, [fixture], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString(); });
    const exited = new Promise<void>((done) => child.once("close", () => done()));
    const lines = createInterface({ input: child.stdout });
    const ready = new Promise<{ shellID: string; pid: number; outputPath: string }>((done, reject) => {
      lines.once("line", (line) => { try { done(JSON.parse(line)); } catch (error) { reject(error); } });
      child.once("exit", () => reject(new Error(`Predecessor exited before readiness: ${stderr}`)));
      child.once("error", reject);
    });
    const successor = createManagedShellManager({ agentDir: cwd, cwd, rootSessionID: "root", worker: false });
    const replay: ShellNotification[] = [];
    successor.attachOwner({ sessionID: "root", cwd, notify: async (notice) => { replay.push(notice); } });
    const strict = createManagedShellManager({ agentDir: cwd, cwd, rootSessionID: "root", worker: false });
    let recordPath: string | undefined;
    let original: string | undefined;
    try {
      const running = await ready;
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      const verifyPriorOwner = async (owner: { pid: number }) => {
        expect(owner.pid).toBe(child.pid);
        try { process.kill(owner.pid, 0); return false; } catch { return true; }
      };
      await expect(strict.recover({ verifyPriorOwner })).rejects.toThrow("verified");
      recordPath = running.outputPath.replace(/\.out$/, ".json");
      original = await readFile(recordPath, "utf8");
      if (custody !== "valid") {
        const record = JSON.parse(original);
        if (custody === "forged") record.handoff.ticket = "0".repeat(64);
        if (custody === "absent") delete record.handoff;
        if (custody === "expired") record.handoff.expiresAt = Date.now() - 1;
        await writeFile(recordPath, JSON.stringify(record));
      }
      const recovery = successor.recover({ verifyPriorOwner, allowPreparedHandoff: true });
      if (custody !== "valid") {
        await expect(recovery).rejects.toThrow(custody === "forged" ? "prepared custody could not be authenticated" : "Prior shell owner has not been verified");
        expect(successor.tasks().some((task) => task.id === running.shellID)).toBe(false);
        expect(() => process.kill(running.pid, 0)).not.toThrow();
        expect(JSON.parse(await readFile(recordPath, "utf8")).result).toBeUndefined();
      } else {
        await recovery;
        expect(replay).toEqual([expect.objectContaining({ recovered: true, wake: false, result: expect.objectContaining({ output: "durable-report\n" }) })]);
        expect(successor.tasks().find((task) => task.id === running.shellID)?.pid).toBe(running.pid);
        expect(() => process.kill(child.pid!, 0)).not.toThrow();
        await successor.cancel(running.shellID);
        expect(() => process.kill(running.pid, 0)).toThrow();
      }
      expect(await readFile(join(cwd, "count"), "utf8")).toBe("once\n");
    } finally {
      if (custody !== "valid" && recordPath && original) await writeFile(recordPath, original);
      child.stdin.end("successor-ready\n");
      await exited;
      lines.close();
      await successor.dispose();
      await strict.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
