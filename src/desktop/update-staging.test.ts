import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, unlink, rename, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { desktopUpdateRecovery } from "./update-custodian";
import { cleanupDesktopUpdateStaging, retainManualDesktopDownload } from "./update-staging";
const temporaryRoot = async (prefix: string) => realpath(await mkdtemp(join(tmpdir(), prefix)));

it("reclaims a settled Windows image after a transient lock without removing foreign files", async () => {
  const root = await temporaryRoot("desktop-stage-lock-");
  try {
    await writeFile(join(root, "custodian.exe"), "settled image"); await writeFile(join(root, "notes.txt"), "user work");
    let failures = 2;
    await cleanupDesktopUpdateStaging(root, "installer.exe", false, { platform: "win32", wait: async () => {}, unlink: async path => {
      if (String(path).endsWith("custodian.exe") && failures-- > 0) throw Object.assign(new Error("image lock"), { code: "EPERM" });
      await unlink(path);
    } });
    expect(await readdir(root)).toEqual(["notes.txt"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("preserves recovery authority when a Windows payload lock does not settle", async () => {
  const root = await temporaryRoot("desktop-stage-locked-");
  try {
    for (const name of ["handoff.json", "receipt.json", "registry-0.reg"]) await writeFile(join(root, name), name);
    let attempts = 0;
    await expect(cleanupDesktopUpdateStaging(root, "installer.exe", false, { platform: "win32", wait: async () => {}, unlink: async path => {
      if (String(path).endsWith("registry-0.reg")) { attempts++; throw Object.assign(new Error("image lock"), { code: "EPERM" }); }
      await unlink(path);
    } })).rejects.toMatchObject({ code: "EPERM" });
    expect(attempts).toBeGreaterThan(1); expect(attempts).toBeLessThan(100);
    expect(await readFile(join(root, "handoff.json"), "utf8")).toBe("handoff.json");
    expect(await readFile(join(root, "receipt.json"), "utf8")).toBe("receipt.json");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not unlink a replacement that appeared while a settled image was locked", async () => {
  const root = await temporaryRoot("desktop-stage-replaced-");
  try {
    const path = join(root, "custodian.exe"); await writeFile(path, "settled image");
    await writeFile(join(root, "receipt.json"), "authority");
    await expect(cleanupDesktopUpdateStaging(root, "installer.exe", false, { platform: "win32", unlink: async () => {
      throw Object.assign(new Error("image lock"), { code: "EBUSY" });
    }, wait: async () => { await rename(path, join(root, "retained-image")); await writeFile(path, "replacement"); } })).rejects.toThrow(/changed/i);
    expect(await readFile(path, "utf8")).toBe("replacement");
    expect(await readFile(join(root, "receipt.json"), "utf8")).toBe("authority");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not adopt a later authority-file replacement during another file's retry", async () => {
  const root = await temporaryRoot("desktop-stage-later-replaced-");
  try {
    const image = join(root, "custodian.exe"), receipt = join(root, "receipt.json");
    await writeFile(image, "settled image"); await writeFile(receipt, "original authority");
    let locked = true;
    await expect(cleanupDesktopUpdateStaging(root, "installer.exe", false, { platform: "win32", unlink: async path => {
      if (path === image && locked) { locked = false; throw Object.assign(new Error("image lock"), { code: "EPERM" }); }
      await unlink(path);
    }, wait: async () => { await rename(receipt, join(root, "original-receipt")); await writeFile(receipt, "foreign replacement"); } })).rejects.toThrow(/changed/i);
    expect(await readFile(receipt, "utf8")).toBe("foreign replacement");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["complete", "failed", "cancelled", "rollback-incomplete", "failed-without-evidence", "failed-before-install"])("preserves or reclaims %s staging according to durable recovery evidence", async (scenario) => {
  const phase = scenario.startsWith("rollback-") || scenario.startsWith("failed-") ? "failed" : scenario;
  const reclaim = scenario !== "rollback-incomplete" && scenario !== "failed-without-evidence";
  const root = await temporaryRoot("desktop-stage-recovery-");
  try {
    const directory = join(root, "updates", "update-fixture"); await mkdir(directory, { recursive: true });
    const operationId = randomUUID(); const hash = "a".repeat(64);
    const handoff = { schema: 1, token: "x".repeat(43), operationId, hostPid: 42, hostPath: join(root, "installed", "EasyResearch.exe"),
      userDataDir: root, agentDir: join(root, "agent"), directory, currentVersion: "1.0.0", version: "2.0.0",
      installerName: "EasyResearch-2.0.0-windows-x64.exe", installerSize: 1, installerSha256: hash, helperSha256: hash,
      oldHostSha256: hash, oldAppSha256: hash, oldSidecarSha256: hash, oldBootId: "old", route: "#/", expiresAt: Date.now() - 1000 };
    await writeFile(join(directory, "handoff.json"), JSON.stringify(handoff));
    const outcome = scenario === "failed-without-evidence" ? undefined : {
      installerAdmitted: phase !== "cancelled" && scenario !== "failed-before-install", hostExited: phase !== "cancelled",
      rollback: scenario === "rollback-incomplete" ? "pending" : phase === "failed" && scenario !== "failed-before-install" ? "complete" : "not-required",
      recoveryComplete: scenario === "failed",
    };
    await writeFile(join(directory, "receipt.json"), JSON.stringify({ phase, operationId, version: "2.0.0", workerPid: 1234, outcome, installerSettled: true }));
    await writeFile(join(directory, "registry-0.reg"), "sole remaining registry recovery material");
    await writeFile(join(directory, "custodian.exe"), "x"); await writeFile(join(directory, handoff.installerName), "x");
    expect(await desktopUpdateRecovery(root, () => true)).toBe(false);
    expect(await readdir(directory)).toHaveLength(5);
    expect(await desktopUpdateRecovery(root, () => false)).toBe(phase === "failed");
    if (reclaim) expect(await readdir(join(root, "updates"))).toEqual([]);
    else {
      expect(await readFile(join(directory, "registry-0.reg"), "utf8")).toBe("sole remaining registry recovery material");
      expect(JSON.parse(await readFile(join(directory, "handoff.json"), "utf8"))).toEqual(handoff);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("preserves unowned receipt directories and unrelated user files", async () => {
  const root = await temporaryRoot("desktop-stage-unowned-");
  try {
    const directory = join(root, "updates", "update-foreign"); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "receipt.json"), JSON.stringify({ phase: "complete", workerPid: 42 }));
    await writeFile(join(directory, "notes.txt"), "user work");
    expect(await desktopUpdateRecovery(root, () => false)).toBe(false);
    expect(await readFile(join(directory, "notes.txt"), "utf8")).toBe("user work");
    expect(await readdir(directory)).toHaveLength(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("retains only the current and previous unchanged owned manual downloads", async () => {
  const root = await temporaryRoot("desktop-manual-retention-");
  try {
    for (const version of ["2.0.0", "3.0.0", "4.0.0"]) {
      const bytes = Buffer.from(`installer ${version}`); const name = `EasyResearch-${version}-macos-arm64.dmg`;
      const source = join(root, `source-${version}`); await writeFile(source, bytes);
      await retainManualDesktopDownload(source, root, { name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), url: "https://github.com/unused" });
    }
    expect((await readdir(join(root, "manual"))).filter((name) => name.endsWith(".dmg")).sort()).toEqual([
      "EasyResearch-3.0.0-macos-arm64.dmg", "EasyResearch-4.0.0-macos-arm64.dmg",
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("never prunes foreign, unverifiable or user-modified manual files", async () => {
  const root = await temporaryRoot("desktop-manual-preserve-");
  try {
    await mkdir(join(root, "manual"));
    const foreign = "EasyResearch-0.9.0-macos-arm64.dmg"; await writeFile(join(root, "manual", foreign), "foreign");
    for (const version of ["1.0.0", "2.0.0", "3.0.0", "4.0.0"]) {
      const bytes = Buffer.from(`installer ${version}`); const name = `EasyResearch-${version}-macos-arm64.dmg`;
      const source = join(root, `source-${version}`); await writeFile(source, bytes);
      const destination = await retainManualDesktopDownload(source, root, { name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), url: "https://github.com/unused" });
      if (version === "1.0.0") await writeFile(destination, "user-modified contents");
    }
    expect(await readFile(join(root, "manual", foreign), "utf8")).toBe("foreign");
    expect(await readFile(join(root, "manual", "EasyResearch-1.0.0-macos-arm64.dmg"), "utf8")).toBe("user-modified contents");
    expect((await readdir(join(root, "manual"))).filter((name) => name.endsWith(".dmg")).sort()).toEqual([
      foreign, "EasyResearch-1.0.0-macos-arm64.dmg", "EasyResearch-3.0.0-macos-arm64.dmg", "EasyResearch-4.0.0-macos-arm64.dmg",
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
