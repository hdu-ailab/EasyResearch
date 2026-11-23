import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createManagedShellManager, type ManagedShellService, type ShellResult } from "./index";

describe("managed remote call identity", () => {
  it("preserves remote workdir and exact call identity through lost-connection recovery without local execution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "shell-remote-context-"));
    const options = {
      agentDir: cwd, cwd, rootSessionID: "root",
      get environment(): NodeJS.ProcessEnv { throw new Error("Remote execution must not read local process policy."); },
      get worker(): false { throw new Error("Remote execution must not resolve a local worker."); },
    };
    const manager = createManagedShellManager(options);
    let recovered: ManagedShellService | undefined;
    let call: Promise<ShellResult> | undefined;
    manager.attachOwner({ sessionID: "root", cwd,
      shell: () => { throw new Error("Remote execution must not read local shell settings."); },
      notify: async () => {},
    });
    try {
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const secret = "transport-private-credential";
      const workdir = "~/remote project/not-a-local-directory";
      call = manager.executeRemote("root", { command: "remote training", workdir }, async (input) => {
        expect(secret).toBe("transport-private-credential");
        expect(input.command).toBe("remote training");
        expect(input.workdir).toBe(workdir);
        input.onOutput("remote bytes before disconnection\n");
        entered();
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { exitCode: null, signal: "TERM" };
      }, undefined, { toolCallID: "remote-call", assistantEntryId: "remote-assistant", toolName: "ssh-bash" });
      // An accidental local-config lookup returns a terminal error instead of ever
      // entering the transport. Race that response so the red test cannot hang.
      expect(await Promise.race([started.then(() => "remote started"), call.then(() => "returned before transport")])).toBe("remote started");
      const task = manager.tasks()[0]!;
      const recordPath = task.outputPath!.replace(/\.out$/, ".json");
      const admission = await readFile(recordPath, "utf8");
      expect(JSON.parse(admission)).toMatchObject({ foreground: true, toolCallID: "remote-call", assistantEntryId: "remote-assistant", toolName: "ssh-bash", workdir });
      expect(admission).not.toContain(secret);
      expect(JSON.parse(admission)).not.toHaveProperty("worker");
      expect(JSON.parse(admission)).not.toHaveProperty("pid");
      await manager.cancel(task.id);
      await call;
      await manager.dispose();

      // Replay the actual pre-settlement admission as a dead-host disk snapshot;
      // the old injected transport is fully joined before simulating its loss.
      await writeFile(recordPath, admission);
      recovered = createManagedShellManager(options);
      await recovered.recover({ verifyPriorOwner: async () => true });
      expect(recovered.recoveredCalls()).toEqual([expect.objectContaining({
        sessionID: "root", toolCallID: "remote-call", assistantEntryId: "remote-assistant", toolName: "ssh-bash",
        result: expect.objectContaining({ status: "error", exitCode: null, outputPath: task.outputPath }),
      })]);
      expect(recovered.recoveredCalls()[0]?.result.killed).toContain("Remote shell connection custody was lost");
      const terminal = JSON.parse(await readFile(recordPath, "utf8"));
      expect(terminal).not.toHaveProperty("worker");
      expect(terminal).not.toHaveProperty("pid");
      expect(terminal).not.toHaveProperty("handoff");
      expect(await readFile(task.outputPath!, "utf8")).toBe("remote bytes before disconnection\n");
    } finally {
      await manager.dispose();
      await call;
      await recovered?.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("defaults new local call metadata to shell while preserving its native assistant binding", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "shell-local-context-"));
    const options = { agentDir: cwd, cwd, rootSessionID: "root", worker: false as const };
    const manager = createManagedShellManager(options);
    const recovered = createManagedShellManager(options);
    try {
      manager.attachOwner({ sessionID: "root", cwd, notify: async () => {} });
      await manager.execute("root", { command: "echo local" }, undefined, { toolCallID: "local-call", assistantEntryId: "local-assistant" });
      await manager.dispose();
      await recovered.recover({ verifyPriorOwner: async () => true });
      expect(recovered.recoveredCalls()).toEqual([expect.objectContaining({ toolCallID: "local-call", assistantEntryId: "local-assistant", toolName: "shell" })]);
    } finally {
      await manager.dispose();
      await recovered.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
