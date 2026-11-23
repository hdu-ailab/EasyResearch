import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedShellManager, type ManagedShellService, type ShellNotification } from "./index";

const roots: string[] = [];
const services: ManagedShellService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "managed-shell-"));
  roots.push(cwd);
  const manager = createManagedShellManager({ agentDir: cwd, rootSessionID: "root", cwd, worker: false });
  services.push(manager);
  const notices: ShellNotification[] = [];
  manager.attachOwner({ sessionID: "root", cwd, notify: async (notice) => { notices.push(notice); } });
  return { manager, cwd, notices };
}

describe.skipIf(process.platform === "win32")("managed shell ownership (POSIX process fixtures)", () => {
  it("returns truthful nonzero foreground output, combined stderr, with no background notice", async () => {
    const { manager, notices } = await fixture();
    const result = await manager.execute("root", { command: "printf out; printf err >&2; exit 7" });
    expect(result.exitCode).toBe(7);
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
    expect(result.shellID).toBeUndefined();
    expect(notices).toEqual([]);
    expect(manager.hasWork()).toBe(false);
  });
  it("promotes the original process and delivers one stable completion", async () => {
    const { manager, cwd, notices } = await fixture();
    const result = await manager.execute("root", { command: "echo once >> count; sleep 0.15; echo final; exit 3", timeout: 10 });
    expect(result.shellID).toBeTruthy();
    expect(result.pid).toBeGreaterThan(0);
    expect(manager.tasks()[0]).toMatchObject({ id: result.shellID, blocking: false, sessionID: "root" });
    await expect.poll(() => notices.length).toBe(1);
    expect(notices[0]?.result.exitCode).toBe(3);
    expect(notices[0]?.content).toContain("final");
    expect(notices[0]?.content).toContain("Exit code: 3");
    expect(await readFile(join(cwd, "count"), "utf8")).toBe("once\n");
    await expect.poll(() => manager.hasWork()).toBe(false);
  });
  it("explicit background survives caller abort and cancellation awaits its process", async () => {
    const { manager, notices } = await fixture();
    const abort = new AbortController();
    const result = await manager.execute("root", { command: "sleep 30", background: true }, abort.signal);
    abort.abort();
    expect(manager.hasWork("root")).toBe(true);
    await manager.cancel(result.shellID!);
    await expect.poll(() => notices.length).toBe(1);
    expect(notices[0]?.state).toBe("cancelled");
    expect(() => process.kill(result.pid!, 0)).toThrow();
  });
  it("promotes only the selected owner's blocking command", async () => {
    const { manager, cwd } = await fixture();
    manager.attachOwner({ sessionID: "child", cwd, notify: async () => {} });
    const root = manager.execute("root", { command: "sleep 30" });
    const child = manager.execute("child", { command: "sleep 30" });
    await expect.poll(() => manager.tasks().filter((t) => t.blocking).length).toBe(2);
    await manager.promote("child");
    const result = await child;
    expect(manager.tasks().find((t) => t.id === result.shellID)?.blocking).toBe(false);
    expect(manager.tasks().find((t) => t.sessionID === "root")?.blocking).toBe(true);
    await manager.dispose();
    await root;
  });
  it("keeps failed notification admission pending and replays the same id on reattach", async () => {
    const { manager, cwd } = await fixture();
    const seen: string[] = [];
    manager.attachOwner({ sessionID: "root", cwd, notify: async (notice) => { seen.push(notice.id); throw new Error("unavailable"); } });
    await manager.execute("root", { command: "echo done", background: true });
    await expect.poll(() => seen.length).toBe(1);
    expect(manager.hasWork()).toBe(true);
    manager.attachOwner({ sessionID: "root", cwd, notify: async (notice) => { seen.push(notice.id); } });
    await expect.poll(() => seen.length).toBe(2);
    expect(seen[1]).toBe(seen[0]);
    await expect.poll(() => manager.hasWork()).toBe(false);
  });
  it("bounds the preview while preserving the complete output file", async () => {
    const { manager } = await fixture();
    const result = await manager.execute("root", { command: "head -c 100000 /dev/zero | tr '\\0' x" });
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThan(40000);
    expect((await readFile(result.outputPath!, "utf8")).length).toBe(100000);
  });
  it("a positive background runtime limit stops rather than promotes", async () => {
    const { manager, notices } = await fixture();
    await manager.execute("root", { command: "sleep 30", background: true, timeout: 30 });
    await expect.poll(() => notices.length).toBe(1);
    expect(notices[0]?.result.timeout).toBe(true);
    expect(notices[0]?.result.timeoutMs).toBe(30);
    expect(notices[0]?.content).toContain("timed out after 0.03 seconds");
    expect(notices[0]?.content).toContain("rerun with a larger timeout");
    expect(notices[0]?.result.exitCode).not.toBe(0);
  });
  it("retries with a replacement route that attaches during failed admission", async () => {
    const { manager, cwd } = await fixture();
    let reject!: (reason: Error) => void;
    const admitted = new Promise<void>((_resolve, fail) => { reject = fail; });
    let firstID: string | undefined;
    manager.attachOwner({ sessionID: "root", cwd, notify: (notice) => { firstID = notice.id; return admitted; } });
    await manager.execute("root", { command: "echo done", background: true });
    await expect.poll(() => firstID).toBeTruthy();
    const next: string[] = [];
    manager.attachOwner({ sessionID: "root", cwd, notify: async (notice) => { next.push(notice.id); } });
    reject(new Error("old owner disposed"));
    await expect.poll(() => next).toEqual([firstID]);
    await expect.poll(() => manager.hasWork()).toBe(false);
  });
  it("uses the 120000ms foreground wait for zero without killing the process", async () => {
    const { manager } = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = manager.execute("root", { command: "sleep 30", timeout: 0 });
      await vi.advanceTimersByTimeAsync(119999);
      expect(manager.blocking("root")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result.shellID).toBeTruthy();
      expect(result.output).toContain("120 seconds");
      expect(manager.hasWork()).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("supports managed remote work through an injected operation without local-process handoff", async () => {
    const { manager, notices } = await fixture();
    const result = await manager.executeRemote("root", { command: "remote-command", background: true }, async ({ signal, onOutput }) => {
      onOutput("remote output\n");
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { exitCode: null, signal: "TERM" };
    });
    expect(result.shellID).toBeTruthy();
    expect(result.pid).toBeUndefined();
    await manager.cancel(result.shellID!);
    await expect.poll(() => notices.length).toBe(1);
    expect(notices[0]?.content).toContain("remote output");
    expect(notices[0]?.state).toBe("cancelled");
  });
  it("recovers a committed pending notice without rerunning work or waking an idle owner", async () => {
    const { manager, cwd } = await fixture();
    const ids: string[] = [];
    manager.attachOwner({ sessionID: "root", cwd, notify: async (notice) => { ids.push(notice.id); throw new Error("admission unavailable"); } });
    await manager.execute("root", { command: "echo once >> count; echo report", background: true });
    await expect.poll(() => ids.length).toBe(1);
    await manager.dispose();
    const next = createManagedShellManager({ agentDir: cwd, rootSessionID: "root", cwd, worker: false });
    services.push(next);
    const replay: ShellNotification[] = [];
    next.attachOwner({ sessionID: "root", cwd, notify: async (notice) => { replay.push(notice); } });
    await next.recover({ verifyPriorOwner: async () => true });
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ id: ids[0], recovered: true, wake: false });
    expect(await readFile(join(cwd, "count"), "utf8")).toBe("once\n");
    expect(next.hasWork()).toBe(false);
  });
});
