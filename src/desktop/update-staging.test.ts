import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { desktopUpdateRecovery } from "./update-custodian";
import { retainManualDesktopDownload } from "./update-staging";

it.each(["complete", "failed", "cancelled", "rollback-incomplete", "failed-without-evidence", "failed-before-install"])("preserves or reclaims %s staging according to durable recovery evidence", async (scenario) => {
  const phase = scenario.startsWith("rollback-") || scenario.startsWith("failed-") ? "failed" : scenario;
  const reclaim = scenario !== "rollback-incomplete" && scenario !== "failed-without-evidence";
  const root = await mkdtemp(join(tmpdir(), "desktop-stage-recovery-"));
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
  const root = await mkdtemp(join(tmpdir(), "desktop-stage-unowned-"));
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
  const root = await mkdtemp(join(tmpdir(), "desktop-manual-retention-"));
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
  const root = await mkdtemp(join(tmpdir(), "desktop-manual-preserve-"));
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
