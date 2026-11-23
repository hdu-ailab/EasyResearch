import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createManagedShellManager, type ShellNotification } from "./index";

describe("consumed shell retention", () => {
  it("bounds consumed history without evicting running work, pending admission, or durable outputs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "shell-retention-"));
    const options = { agentDir: cwd, cwd, rootSessionID: "root", worker: false as const };
    const manager = createManagedShellManager(options);
    let recovered: ReturnType<typeof createManagedShellManager> | undefined;
    const pending: ShellNotification[] = [];
    manager.attachOwner({ sessionID: "root", cwd, notify: async (notice) => { if (notice.result.output === "pending") { pending.push(notice); throw new Error("not admitted yet"); } } });
    try {
      await manager.execute("root", { command: "echo bound" }, undefined, { toolCallID: "original", assistantEntryId: "native-assistant" });
      const active = await manager.executeRemote("root", { command: "active", background: true }, async ({ signal }) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { exitCode: null };
      });
      const waiting = await manager.executeRemote("root", { command: "pending", background: true }, async ({ onOutput }) => { onOutput("pending"); return { exitCode: 0 }; });
      await expect.poll(() => pending.length).toBe(1);
      let earliest: string | undefined;
      const batch = async (background: boolean) => {
        for (let index = 0; index < 30; index++) {
          await manager.executeRemote("root", { command: `consumed-${background}-${index}`, background }, async ({ onOutput }) => {
            onOutput("retained on disk");
            return { exitCode: 0 };
          });
          earliest ??= manager.tasks().find((task) => task.description.startsWith("consumed-"))?.outputPath;
        }
        await manager.flushNotifications();
      };
      await batch(false);
      const firstSize = manager.tasks().length;
      expect(firstSize).toBeLessThan(30);
      await batch(true);
      await expect.poll(() => manager.tasks().length).toBe(firstSize);
      expect(manager.tasks()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: active.shellID, status: "running" }),
        expect.objectContaining({ id: waiting.shellID, status: "completed" }),
      ]));
      expect(manager.hasWork()).toBe(true);
      expect(await readFile(earliest!, "utf8")).toBe("retained on disk");
      const recordPath = earliest!.replace(/\.out$/, ".json");
      expect(JSON.parse(await readFile(recordPath, "utf8")).result.output).toBe("retained on disk");
      const [bucket] = await readdir(join(cwd, "background", "shell"));
      expect((await readdir(join(cwd, "background", "shell", bucket!))).filter((file) => file.endsWith(".json"))).toHaveLength(63);
      await manager.dispose();
      recovered = createManagedShellManager(options);
      const replay: ShellNotification[] = [];
      recovered.attachOwner({ sessionID: "root", cwd, notify: async (notice) => { replay.push(notice); } });
      await recovered.recover({ verifyPriorOwner: async () => true });
      expect(replay.filter((notice) => notice.id === pending[0]!.id)).toHaveLength(1);
      expect(recovered.hasWork()).toBe(false);
      expect(recovered.tasks().length).toBeLessThanOrEqual(firstSize);
      expect(recovered.recoveredCalls()).toEqual([expect.objectContaining({ toolCallID: "original", assistantEntryId: "native-assistant", result: expect.objectContaining({ output: expect.stringContaining("bound") }) })]);
      expect(await readFile(earliest!, "utf8")).toBe("retained on disk");
    } finally {
      await manager.dispose();
      await recovered?.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
