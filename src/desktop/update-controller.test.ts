import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDesktopUpdateController } from "./update";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const candidate = { version: "2.0.0", asset: { name: "EasyResearch-2.0.0-windows-x64.exe", size: 12, sha256: "a".repeat(64), url: "https://github.com/hdu-ailab/EasyResearch/releases/download/v2.0.0/EasyResearch-2.0.0-windows-x64.exe" } };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "desktop-update-controller-")); roots.push(root);
  const install = vi.fn(async () => {});
  const controller = createDesktopUpdateController({ currentVersion: "1.0.0", kind: "windows-x64.exe", stagingRoot: root,
    discover: async () => candidate,
    download: async (_asset, directory) => ({ path: join(directory, candidate.asset.name) }),
    activity: async () => ({ code: "RUNTIME_BUSY", activeSessions: 3, authFlowActive: true }),
    install,
  });
  return { controller, install, root };
}

it("projects a recovered installation failure without starting an operation and permits a later explicit check", async () => {
  const { root } = await fixture();
  const discover = vi.fn(async () => candidate);
  const controller = createDesktopUpdateController({
    currentVersion: "1.0.0", kind: "windows-x64.exe", stagingRoot: root,
    recoveredInstallationFailure: true, discover,
  });
  expect(controller.snapshot()).toMatchObject({
    phase: "failed", operationId: null, currentVersion: "1.0.0",
    canInstall: false, canDownload: false, canActivate: false,
    message: "Installation failed. Open latest Release.",
  });
  expect(discover).not.toHaveBeenCalled();
  await controller.action({ action: "check" });
  expect(discover).toHaveBeenCalledOnce();
  expect(controller.snapshot()).toMatchObject({ phase: "available", latestVersion: candidate.version, message: undefined });
  await controller.close();
});

it("fences stale/duplicate actions while keeping one operation id and increasing revisions", async () => {
  const { controller, install } = await fixture();
  const snapshots: number[] = []; controller.subscribe((s) => snapshots.push(s.revision));
  await controller.action({ action: "check" });
  const id = controller.snapshot().operationId!;
  await expect(controller.action({ action: "download", operationId: "stale" })).rejects.toThrow(/stale/i);
  await controller.action({ action: "download", operationId: id });
  expect(controller.snapshot()).toMatchObject({ phase: "downloaded", operationId: id, canInstall: true });
  expect(await controller.action({ action: "install", operationId: id })).toEqual({ code: "RUNTIME_BUSY", activeSessions: 3, authFlowActive: true });
  await controller.action({ action: "install", operationId: id, force: true });
  expect(controller.snapshot().phase).toBe("activating");
  await expect(controller.action({ action: "install", operationId: id, force: true })).rejects.toThrow();
  expect(install).toHaveBeenCalledOnce();
  expect(snapshots.every((value, index) => index === 0 || value > snapshots[index - 1]!)).toBe(true);
});

it("never installs on ordinary Exit and rejects later actions", async () => {
  const { controller, install } = await fixture();
  await controller.action({ action: "check" });
  await controller.action({ action: "download", operationId: controller.snapshot().operationId! });
  await controller.close();
  expect(install).not.toHaveBeenCalled();
  await expect(controller.action({ action: "check" })).rejects.toThrow(/closed/i);
});

it("retains a concise Release fallback and clears progress when owned cleanup fails", async () => {
  const { controller, install } = await fixture();
  install.mockRejectedValueOnce(new Error("private raw path or command"));
  await controller.action({ action: "check" });
  const operationId = controller.snapshot().operationId!;
  await controller.action({ action: "download", operationId });
  await controller.action({ action: "install", operationId, force: true });
  expect(controller.snapshot()).toMatchObject({ phase: "failed", canCancel: false, releaseUrl: "https://github.com/hdu-ailab/EasyResearch/releases/latest" });
  expect(controller.snapshot().message).not.toContain("private raw");
});

it("reclaims a failed pre-admission preparation instead of accumulating installer copies", async () => {
  const { controller, install, root } = await fixture();
  install.mockRejectedValue(new Error("preparation failed before helper admission"));
  for (let attempt = 0; attempt < 3; attempt++) {
    await controller.action({ action: "check" }); const operationId = controller.snapshot().operationId!;
    await controller.action({ action: "download", operationId });
    await controller.action({ action: "install", operationId, force: true });
  }
  await controller.close(); expect(await readdir(root)).toEqual([]);
});

it.each([false, true])("propagates a late busy result with force=%s and retains the verified download", async (force) => {
  const { root } = await fixture();
  const busy = { code: "RUNTIME_BUSY" as const, activeSessions: 1, authFlowActive: false };
  const controller = createDesktopUpdateController({ currentVersion: "1.0.0", kind: "windows-x64.exe", stagingRoot: root,
    discover: async () => candidate, download: async (_asset, directory) => ({ path: join(directory, candidate.asset.name) }),
    activity: async () => ({ code: "RUNTIME_BUSY", activeSessions: 0, authFlowActive: false }),
    install: async (_update, _signal, _commit, controls) => { expect(controls.force).toBe(force); controls.stagingAccepted(); controls.stagingReleased(); return busy; },
  });
  await controller.action({ action: "check" }); const operationId = controller.snapshot().operationId!;
  await controller.action({ action: "download", operationId });
  expect(await controller.action({ action: "install", operationId, force })).toEqual(busy);
  expect(controller.snapshot()).toMatchObject({ phase: "downloaded", canInstall: true, operationId });
  expect(await readdir(root)).toHaveLength(1);
});

it.each(["macos-arm64.dmg", "linux-arm64.deb", "linux-arm64.AppImage"] as const)("reveals a verified %s download and retains it after Exit", async (kind) => {
  const { root } = await fixture(); const bytes = Buffer.from("manual verified artifact");
  const asset = { ...candidate.asset, name: `EasyResearch-2.0.0-${kind}`, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const reveal = vi.fn(async (_path: string) => {});
  const controller = createDesktopUpdateController({ currentVersion: "1.0.0", kind, stagingRoot: root, reveal,
    discover: async () => ({ version: "2.0.0", asset }),
    download: async (_asset, directory) => { const path = join(directory, asset.name); await writeFile(path, bytes); return { path }; },
  });
  await controller.action({ action: "check" }); const operationId = controller.snapshot().operationId!;
  await controller.action({ action: "download", operationId });
  expect(controller.snapshot()).toMatchObject({ canReveal: true, canInstall: false });
  await controller.action({ action: "reveal", operationId }); const path = reveal.mock.calls[0]![0];
  await controller.close(); expect(await readFile(path)).toEqual(bytes);
});

it("cancels before helper commitment and joins cleanup during Exit", async () => {
  const { root } = await fixture();
  let started!: () => void; const starting = new Promise<void>((resolve) => { started = resolve; });
  const install = vi.fn(async (_download, signal: AbortSignal) => {
    started(); await new Promise<void>((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  });
  const controller = createDesktopUpdateController({ currentVersion: "1.0.0", kind: "windows-x64.exe", stagingRoot: root,
    discover: async () => candidate, download: async (_a, directory) => ({ path: join(directory, candidate.asset.name) }), install });
  await controller.action({ action: "check" }); const operationId = controller.snapshot().operationId!;
  await controller.action({ action: "download", operationId });
  const installing = controller.action({ action: "install", operationId, force: true }); await starting;
  await controller.close(); await installing;
  expect(controller.snapshot().phase).toBe("cancelled");
});

it("reserves operation ownership before publishing to synchronous subscribers", async () => {
  const { root } = await fixture();
  const discover = vi.fn(async () => candidate);
  const controller = createDesktopUpdateController({ currentVersion: "1.0.0", kind: "windows-x64.exe", stagingRoot: root, discover });
  let reentered: Promise<unknown> | undefined;
  controller.subscribe((snapshot) => {
    if (snapshot.phase === "checking" && !reentered) {
      // Assign a sentinel before the reentrant call so a broken implementation
      // fails by duplicate discovery, rather than recursively exhausting the stack.
      reentered = Promise.resolve();
      reentered = controller.action({ action: "check" }).catch((error) => error);
    }
  });
  await controller.action({ action: "check" });
  expect(await reentered).toBeInstanceOf(Error);
  expect(discover).toHaveBeenCalledOnce();
});

it("uses the host's native fetch for both release discovery and installer download", async () => {
  const { root } = await fixture(); const fetch = vi.fn(async () => new Response());
  const discover = vi.fn(async () => candidate);
  const download = vi.fn(async (_asset, directory: string) => ({ path: join(directory, candidate.asset.name) }));
  const controller = createDesktopUpdateController({ currentVersion: "1.0.0", kind: "windows-x64.exe", stagingRoot: root, fetch, discover, download, install: async () => {} });
  await controller.action({ action: "check" });
  await controller.action({ action: "download", operationId: controller.snapshot().operationId! });
  expect(discover).toHaveBeenCalledWith("1.0.0", "windows-x64.exe", expect.objectContaining({ fetch, signal: expect.any(AbortSignal) }));
  expect(download).toHaveBeenCalledWith(candidate.asset, expect.any(String), expect.objectContaining({ fetch, signal: expect.any(AbortSignal) }));
  await controller.close();
});
