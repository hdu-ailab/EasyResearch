import { describe, expect, it, vi } from "vitest";
import { NpmUpdateController, type NpmUpdateDependencies } from "./npm-update";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function fixture(overrides: Partial<NpmUpdateDependencies> = {}) {
  const events: string[] = [];
  const candidate = { executable: "/private/candidate", version: "2.0.0", runtimeId: "2:hash", sha256: "hash" };
  const deps: NpmUpdateDependencies = {
    owner: "cli", currentVersion: "1.0.0", manualCommand: (version) => `npm install easyresearch@${version}`,
    capability: () => ({ available: true }), latest: async () => "2.0.0",
    reserve: async () => ({ release: () => { events.push("release"); return true; } }),
    install: async (version) => { events.push(`install:${version}`); },
    verify: async () => candidate,
    discard: async () => {},
    busy: () => ({ code: "RUNTIME_BUSY", activeSessions: 0, authFlowActive: false }),
    beginShutdown: () => { events.push("fence"); },
    activate: () => { events.push("activate"); },
    ...overrides,
  };
  return { controller: new NpmUpdateController(deps), events, deps, candidate };
}
async function settle(controller: NpmUpdateController) {
  await vi.waitFor(() => expect(["checking", "installing", "verifying"]).not.toContain(controller.snapshot().phase));
}
async function available(f: ReturnType<typeof fixture>) {
  await f.controller.action({ action: "check" }); await settle(f.controller);
  return f.controller.snapshot().operationId!;
}

describe("owned npm update", () => {
  it("never releases the installation lease when process-tree cleanup is unproven", async () => {
    const failure = Object.assign(new Error("process tree still active"), { custodyUnresolved: true });
    const f = fixture({ install: async () => { throw failure; } });
    const id = await available(f); await f.controller.action({ action: "install", operationId: id }); await settle(f.controller);
    expect(f.events).not.toContain("release");
    await expect(f.controller.close()).rejects.toBe(failure);
    expect(f.events).not.toContain("release");
  });
  it("retains the transition until cancelled staged bytes are actually removed", async () => {
    const removed = deferred<void>();
    const f = fixture({ discard: async () => { f.events.push("discard"); await removed.promise; } });
    const id = await available(f); await f.controller.action({ action: "install", operationId: id }); await settle(f.controller);
    const cancelled = f.controller.action({ action: "cancel", operationId: id });
    await vi.waitFor(() => expect(f.events).toContain("discard"));
    expect(f.events).not.toContain("release");
    removed.resolve(); await cancelled;
    expect(f.events.slice(-2)).toEqual(["discard", "release"]);
    await f.controller.close();
  });
  it("retains cleanup failure custody and retries disposal on close", async () => {
    let attempts = 0;
    const f = fixture({ discard: async () => { if (++attempts === 1) throw new Error("file locked"); } });
    await available(f); await f.controller.action({ action: "install", operationId: f.controller.snapshot().operationId! }); await settle(f.controller);
    await expect(f.controller.close()).rejects.toThrow("file locked");
    expect(f.events).not.toContain("release");
    await f.controller.close();
    expect(attempts).toBe(2); expect(f.events).toContain("release");
  });
  it("disposes a candidate returned after cancellation before releasing installation custody", async () => {
    const verification = deferred<ReturnType<typeof fixture>["candidate"]>();
    const f = fixture({ verify: () => verification.promise, discard: async () => { f.events.push("discard"); } });
    const id = await available(f); await f.controller.action({ action: "install", operationId: id });
    await vi.waitFor(() => expect(f.controller.snapshot().phase).toBe("verifying"));
    const cancelled = f.controller.action({ action: "cancel", operationId: id });
    verification.resolve(f.candidate); await cancelled;
    expect(f.events.slice(-2)).toEqual(["discard", "release"]);
    await f.controller.close();
  });
  it("associates every actionable snapshot with the checked operation, including pending installation acknowledgement", async () => {
    const pending = deferred<void>();
    const f = fixture({ install: () => pending.promise });
    const snapshots = [f.controller.snapshot()];
    f.controller.subscribe((snapshot) => snapshots.push(snapshot));
    const id = await available(f);
    const acknowledgement = f.controller.action({ action: "install", operationId: id });
    const cancellation = f.controller.action({ action: "cancel", operationId: id });
    pending.resolve();
    await acknowledgement; await cancellation;
    const actionable = snapshots.filter((snapshot) => snapshot.canDownload || snapshot.canInstall || snapshot.canActivate || snapshot.canCancel);
    expect(actionable.length).toBeGreaterThan(0);
    expect(actionable.every((snapshot) => snapshot.operationId === id)).toBe(true);
    expect(f.events).not.toContain("activate");
    await f.controller.close();
  });
  it("fences concurrent activation immediately when a ready update is cancelled", async () => {
    const f = fixture(); const id = await available(f);
    await f.controller.action({ action: "install", operationId: id }); await settle(f.controller);
    const cancel = f.controller.action({ action: "cancel", operationId: id });
    await expect(f.controller.action({ action: "activate", operationId: id, force: true })).rejects.toThrow();
    await cancel;
    expect(f.events).not.toContain("activate"); await f.controller.close();
  });

  it("records activation handoff failure instead of leaving permanent activating progress", async () => {
    const f = fixture({ activate() { throw new Error("handoff refused"); }, discard: async () => { f.events.push("discard"); } }); const id = await available(f);
    await f.controller.action({ action: "install", operationId: id }); await settle(f.controller);
    await f.controller.action({ action: "activate", operationId: id });
    expect(f.controller.snapshot()).toMatchObject({ phase: "failed", manualCommand: "npm install easyresearch@2.0.0" });
    expect(f.events.slice(-2)).toEqual(["discard", "release"]);
    await f.controller.close();
  });
  it("retains a verifier's failed-cleanup candidate for a later owned cleanup retry", async () => {
    let failCleanup = true;
    const f = fixture({
      verify: async () => { throw Object.assign(new Error("verification cleanup failed"), { cleanupCandidate: f.candidate }); },
      discard: async () => { if (failCleanup) throw new Error("locked candidate"); f.events.push("discard"); },
    });
    const id = await available(f); await f.controller.action({ action: "install", operationId: id }); await settle(f.controller);
    expect(f.controller.snapshot()).toMatchObject({ phase: "failed", canCancel: true });
    expect(f.events).not.toContain("release");
    failCleanup = false; await f.controller.action({ action: "cancel", operationId: id });
    expect(f.events.slice(-2)).toEqual(["discard", "release"]);
    await f.controller.close();
  });
  it("pins a checked version, rejects stale/concurrent actions, and separates installation from verification and activation", async () => {
    const installing = deferred<void>(); const verifying = deferred<ReturnType<typeof fixture>["candidate"]>();
    const f = fixture({ install: async (version) => { f.events.push(version); await installing.promise; }, verify: () => verifying.promise });
    const id = await available(f);
    await expect(f.controller.action({ action: "install", operationId: "stale" })).rejects.toThrow();
    await f.controller.action({ action: "install", operationId: id });
    await vi.waitFor(() => expect(f.events).toContain("2.0.0"));
    await expect(f.controller.action({ action: "check" })).rejects.toThrow();
    expect(f.controller.snapshot()).toMatchObject({ phase: "installing", currentVersion: "1.0.0", canActivate: false });
    installing.resolve(); await vi.waitFor(() => expect(f.controller.snapshot().phase).toBe("verifying"));
    verifying.resolve(f.candidate); await settle(f.controller);
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", currentVersion: "1.0.0", canActivate: true });
    await f.controller.action({ action: "activate", operationId: id });
    expect(f.events.slice(-2)).toEqual(["fence", "activate"]);
    expect(f.controller.snapshot().phase).toBe("activating");
    await f.controller.close();
  });

  it("holds installation custody until cancelled work drains and never verifies a late success", async () => {
    const drain = deferred<void>(); let signal: AbortSignal | undefined;
    const f = fixture({ install: async (_version, incoming) => { signal = incoming; await drain.promise; } });
    const id = await available(f); await f.controller.action({ action: "install", operationId: id });
    await vi.waitFor(() => expect(signal).toBeDefined());
    const cancel = f.controller.action({ action: "cancel", operationId: id });
    expect(signal!.aborted).toBe(true);
    expect(f.events).not.toContain("release");
    drain.resolve(); await cancel;
    expect(f.events).toEqual(["release"]);
    expect(f.controller.snapshot()).toMatchObject({ phase: "cancelled", canActivate: false });
    await f.controller.close();
  });

  it("releases a reservation arriving after Exit and starts no installer", async () => {
    const lease = deferred<{ release(): boolean }>(); const f = fixture({ reserve: () => lease.promise });
    const id = await available(f); await f.controller.action({ action: "install", operationId: id });
    const closed = f.controller.close();
    lease.resolve({ release: () => { f.events.push("release"); return true; } });
    await closed;
    expect(f.events).toEqual(["release"]);
  });

  it("keeps failures actionable, never fences old work after npm or verification failure", async () => {
    for (const stage of ["install", "verify"] as const) {
      const f = fixture({ [stage]: async () => { throw new Error("secret-token https://name:pass@proxy EACCES"); } });
      const id = await available(f); await f.controller.action({ action: "install", operationId: id }); await settle(f.controller);
      expect(f.controller.snapshot()).toMatchObject({ phase: "failed", currentVersion: "1.0.0", canActivate: false, manualCommand: "npm install easyresearch@2.0.0" });
      expect(JSON.stringify(f.controller.snapshot())).not.toMatch(/secret-token|name:pass/);
      expect(f.events).not.toContain("fence"); await f.controller.close();
    }
  });

  it("rechecks active work at activation and fences synchronously only after explicit busy confirmation", async () => {
    const f = fixture({ busy: () => ({ code: "RUNTIME_BUSY", activeSessions: 1, authFlowActive: false }) });
    const id = await available(f); await f.controller.action({ action: "install", operationId: id }); await settle(f.controller);
    expect(await f.controller.action({ action: "activate", operationId: id })).toMatchObject({ code: "RUNTIME_BUSY", activeSessions: 1 });
    expect(f.events).not.toContain("fence");
    const activation = f.controller.action({ action: "activate", operationId: id, force: true });
    expect(f.events.slice(-2)).toEqual(["fence", "activate"]);
    await activation; await f.controller.close();
  });

  it("blocks desktop mutation even with a valid installation and rejects unsupported scope honestly", async () => {
    for (const overrides of [{ owner: "desktop" as const }, { capability: () => ({ available: false, reason: "Installation scope is unknown." }), manualCommand: () => undefined }]) {
      const f = fixture(overrides); const id = await available(f);
      expect(f.controller.snapshot().canInstall).toBe(false);
      await expect(f.controller.action({ action: "install", operationId: id })).rejects.toThrow();
      expect(f.events).toEqual([]); await f.controller.close();
    }
  });
});
