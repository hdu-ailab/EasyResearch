import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedShellManager, type ManagedShellService, type ShellNotification } from "../../background/shell";
import { startSmokeSshFixture } from "../../../scripts/smoke-ssh-fixture";
import { createSshBashTool } from "./index";
import { createSshBashRuntime } from "./runtime";
import { createSshExecutor } from "./executor";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(ignoreSignals = false) {
  const root = mkdtempSync(join(tmpdir(), "managed-ssh-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  mkdirSync(project);
  const peer = await startSmokeSshFixture({ ignoreSignals });
  cleanups.push(() => peer.close());
  const credentialFile = join(root, "password");
  writeFileSync(credentialFile, peer.secret, { mode: 0o600 });
  const runtime = createSshBashRuntime({ execute: createSshExecutor() });
  await runtime.configure(project, { ...peer.connection, authType: "password", credentialFile,
    remoteExperimentRoot: "paper", localMountPath: join(project, "experiment_ssh") }, new AbortController().signal);
  const manager: ManagedShellService = createManagedShellManager({ agentDir: join(root, "agent"), rootSessionID: "root", cwd: project,
    worker: { executable: join(root, "must-not-launch-local-worker"), args: [] } });
  cleanups.push(() => manager.dispose());
  const notices: ShellNotification[] = [];
  const rootNotices: ShellNotification[] = [];
  manager.attachOwner({ sessionID: "root", cwd: project, notify: async notice => { rootNotices.push(notice); } });
  manager.attachOwner({ sessionID: "child", cwd: project, notify: async notice => { notices.push(notice); } });
  const tool = createSshBashTool({ runtime, allowConfigure: false, manager, owner: () => ({ sessionID: "child", cwd: project }) });
  const context = { cwd: project, sessionManager: { getBranch: () => [] } } as never;
  return { root, project, peer, manager, notices, rootNotices, tool, context };
}

describe("managed ssh-bash with an isolated SSH2 peer", () => {
  it("preserves nonzero foreground output and binds recovery to the invoking assistant rather than the current leaf", async () => {
    const f = await fixture();
    const call = { type: "toolCall", id: "remote-exit", name: "ssh-bash", arguments: {} };
    const context = { cwd: f.project, sessionManager: { getBranch: () => [
      { type: "message", id: "correct-assistant", message: { role: "assistant", stopReason: "toolUse", content: [call] } },
      { type: "message", id: "failed-reused-id", message: { role: "assistant", stopReason: "error", content: [call] } },
      { type: "message", id: "wrong-tool", message: { role: "assistant", stopReason: "toolUse", content: [{ ...call, name: "shell" }] } },
      { type: "message", id: "current-leaf", message: { role: "toolResult", toolCallId: "another-call" } },
    ] } } as never;
    const pending = f.tool.execute("remote-exit", { action: "run", command: "exit-code" }, undefined, undefined, context);
    await expect.poll(() => f.peer.commands.some(command => command.command === "exit-code")).toBe(true);
    const recordRoot = join(f.root, "agent", "background");
    const records = readdirSync(recordRoot, { recursive: true }).filter(path => String(path).endsWith(".json"))
      .map(path => JSON.parse(readFileSync(join(recordRoot, String(path)), "utf8")));
    expect(records).toEqual([expect.objectContaining({ toolCallID: "remote-exit", assistantEntryId: "correct-assistant", toolName: "ssh-bash" })]);
    f.peer.commands.find(command => command.command === "exit-code")!.finish("command output\n", "command warning\n", 7);
    const result = await pending;
    expect(result.details).toMatchObject({ status: "completed", exitCode: 7 });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Exit code: 7") }]);
    expect(f.notices).toEqual([]);
  });
  it("acknowledges explicit background before remote completion and streams more than 256 KiB to the owning child's capture", async () => {
    const f = await fixture();
    const result = await f.tool.execute("remote-large", { action: "run", command: "large", background: true }, AbortSignal.timeout(2_000), undefined, f.context);
    expect(result.details).toMatchObject({ status: "running", shellID: expect.any(String) });
    expect(f.notices).toEqual([]);
    const recordRoot = join(f.root, "agent", "background");
    const records = readdirSync(recordRoot, { recursive: true }).filter(path => String(path).endsWith(".json"))
      .map(path => readFileSync(join(recordRoot, String(path)), "utf8"));
    expect(records.length).toBeGreaterThan(0);
    expect(records.join("\n")).not.toMatch(/credentialFile|privateKey|password/);
    await expect.poll(() => f.peer.commands.some(command => command.command === "large")).toBe(true);
    const command = f.peer.commands.find(command => command.command === "large")!;
    expect(command.closed).toBe(false);
    const payload = Buffer.alloc(400 * 1024, "a");
    command.finish(payload, "remote-stderr-tail\n");
    await expect.poll(() => f.notices.length).toBe(1);
    const notice = f.notices[0]!;
    expect(notice).toMatchObject({ sessionID: "child", state: "completed", result: { exitCode: 0, truncated: true } });
    const captured = readFileSync(notice.result.outputPath!);
    expect(captured.length).toBe(payload.length + Buffer.byteLength("remote-stderr-tail\n"));
    expect(captured.subarray(0, payload.length)).toEqual(payload);
    expect(captured.toString().endsWith("remote-stderr-tail\n")).toBe(true);
    expect(f.rootNotices).toEqual([]);
    expect(f.peer.commands.filter(command => command.command === "large")).toHaveLength(1);
    expect(JSON.stringify([result, notice, records])).not.toContain(f.peer.secret);
    await expect.poll(() => f.manager.hasWork("child")).toBe(false);
  });

  it("promotes one foreground remote operation and keeps cancellation under the child owner", async () => {
    const f = await fixture();
    const caller = new AbortController();
    const result = await f.tool.execute("remote-promote", { action: "run", command: "promote", timeout: 5 }, caller.signal, undefined, f.context);
    const details = result.details as { shellID: string };
    expect(details.shellID).toBeTruthy();
    await expect.poll(() => f.peer.commands.some(command => command.command === "promote")).toBe(true);
    caller.abort();
    expect(f.manager.hasWork("child")).toBe(true);
    expect(f.notices).toEqual([]);
    await f.manager.cancel(details.shellID);
    await expect.poll(() => f.notices.length).toBe(1);
    expect(f.notices[0]).toMatchObject({ sessionID: "child", state: "cancelled" });
    expect(f.rootNotices).toEqual([]);
    expect(f.peer.commands.filter(command => command.command === "promote")).toHaveLength(1);
    expect(f.peer.commands.find(command => command.command === "promote")!.signals).toEqual(["TERM"]);
  });

  it("enforces a positive background runtime deadline and cancels remote connections on manager shutdown", async () => {
    const f = await fixture();
    await f.tool.execute("remote-timeout", { action: "run", command: "deadline", background: true, timeout: 300 }, undefined, undefined, f.context);
    await expect.poll(() => f.notices.length).toBe(1);
    expect(f.notices[0]!.result).toMatchObject({ timeout: true, timeoutMs: 300 });
    expect(f.notices[0]!.result.exitCode).not.toBe(0);
    expect(f.notices[0]!.result.killed).toBeUndefined();
    expect(f.notices[0]!.content).toMatch(/timed out/i);
    expect(f.notices[0]!.content).not.toMatch(/operation aborted/i);
    const next = await f.tool.execute("remote-shutdown", { action: "run", command: "shutdown", background: true, timeout: 0 }, undefined, undefined, f.context);
    expect(next.details).toMatchObject({ status: "running" });
    await expect.poll(() => f.peer.commands.some(command => command.command === "shutdown")).toBe(true);
    await f.manager.dispose({ handoff: true });
    expect(f.peer.commands.find(command => command.command === "shutdown")!.signals).toEqual(["TERM"]);
  });

  it("closes an uncooperative remote channel after TERM without transferring it to a local worker", async () => {
    const f = await fixture(true);
    const result = await f.tool.execute("remote-stubborn", { action: "run", command: "stubborn", background: true }, undefined, undefined, f.context);
    await expect.poll(() => f.peer.commands.some(command => command.command === "stubborn")).toBe(true);
    await f.manager.cancel((result.details as { shellID: string }).shellID);
    await expect.poll(() => f.notices.length).toBe(1);
    expect(f.notices[0]!.state).toBe("cancelled");
    await expect.poll(() => f.peer.commands.find(command => command.command === "stubborn")!.closed).toBe(true);
    expect(f.peer.commands.find(command => command.command === "stubborn")!.signals).toEqual(["TERM"]);
  });

  it("marks foreground cancellation as an error while preserving captured partial output", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const pending = f.tool.execute("remote-abort", { action: "run", command: "partial" }, controller.signal, undefined, f.context);
    await expect.poll(() => f.peer.commands.some(command => command.command === "partial")).toBe(true);
    f.peer.commands.find(command => command.command === "partial")!.stream.write("partial-output\n");
    await expect.poll(() => readFileSync(f.manager.tasks().find(task => task.command === "partial")!.outputPath!, "utf8")).toContain("partial-output");
    controller.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ status: "cancelled", output: expect.stringContaining("partial-output") });
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("partial-output") }]);
  });

  it("marks managed authentication failures as errors without exposing the credential", async () => {
    const f = await fixture();
    const wrongSecret = "different-private-password";
    writeFileSync(join(f.root, "password"), wrongSecret, { mode: 0o600 });
    const result = await f.tool.execute("remote-auth", { action: "run", command: "no-auth" }, undefined, undefined, f.context);
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ status: "error", exitCode: null });
    expect(JSON.stringify(result)).not.toContain(wrongSecret);
  });
});
