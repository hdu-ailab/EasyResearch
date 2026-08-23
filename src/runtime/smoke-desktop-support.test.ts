import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BuildArtifact } from "../../scripts/build";
import {
  combineDesktopSmokeFailures,
  dmgAttachCommand,
  dmgDetachCommand,
  nsisInstallCommand,
  packagedApplicationPaths,
  readDesktopSmokeEvents,
  reduceDesktopSmokeEvents,
  verifyDesktopSidecarIdentity,
  verifyPackagedSidecar,
} from "../../scripts/smoke-desktop-support";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-desktop-smoke-support-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function artifact(bytes: string): BuildArtifact {
  return {
    version: "1.2.3",
    target: "windows-x64",
    binaryName: "easyresearch.exe",
    size: Buffer.byteLength(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    builtAt: "2026-08-23T00:00:00.000Z",
  };
}

describe("packaged sidecar identity", () => {
  it("accepts only byte-identical native sidecar content", () => {
    const path = join(root, "easyresearch.exe");
    writeFileSync(path, "same-bytes");
    expect(() => verifyPackagedSidecar(path, artifact("same-bytes"), "1.2.3"))
      .not.toThrow();
    writeFileSync(path, "different-bytes");
    expect(() => verifyPackagedSidecar(path, artifact("same-bytes"), "1.2.3"))
      .toThrow(/packaged sidecar (size|SHA-256)/i);
  });

  it("requires the desktop and native manifests to identify the same sidecar", () => {
    const native = artifact("same-bytes");
    expect(() => verifyDesktopSidecarIdentity({ ...native }, native)).not.toThrow();
    expect(() => verifyDesktopSidecarIdentity({ ...native, binaryName: "other.exe" }, native))
      .toThrow(/desktop manifest sidecar/i);
  });
});

describe("desktop smoke cleanup failures", () => {
  it("preserves the primary failure and every cleanup failure", () => {
    const primary = new Error("primary smoke failure");
    const result = combineDesktopSmokeFailures(primary, [
      new Error("process cleanup failed"),
      new Error("package cleanup failed"),
    ]);

    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([
      primary,
      expect.objectContaining({ message: "process cleanup failed" }),
      expect.objectContaining({ message: "package cleanup failed" }),
    ]);
    expect(combineDesktopSmokeFailures(undefined, [])).toBeUndefined();
  });
});

describe("native package commands and paths", () => {
  it("builds a silent per-user NSIS installation command", () => {
    expect(nsisInstallCommand("C:\\artifacts\\EasyResearch.exe", "C:\\Users\\test\\EasyResearch"))
      .toEqual({
        command: "C:\\artifacts\\EasyResearch.exe",
        args: ["/S", "/D=C:\\Users\\test\\EasyResearch"],
      });
  });

  it("builds readonly DMG attach and forced detach commands", () => {
    expect(dmgAttachCommand("/tmp/EasyResearch.dmg", "/tmp/mount")).toEqual({
      command: "/usr/bin/hdiutil",
      args: ["attach", "/tmp/EasyResearch.dmg", "-nobrowse", "-readonly", "-mountpoint", "/tmp/mount"],
    });
    expect(dmgDetachCommand("/tmp/mount")).toEqual({
      command: "/usr/bin/hdiutil",
      args: ["detach", "/tmp/mount", "-force"],
    });
  });

  it("resolves installed Windows and mounted macOS app resources", () => {
    expect(packagedApplicationPaths("windows-x64", "C:\\install")).toEqual({
      executable: "C:\\install\\EasyResearch.exe",
      sidecar: "C:\\install\\resources\\sidecar\\easyresearch.exe",
      uninstaller: "C:\\install\\Uninstall EasyResearch.exe",
    });
    expect(packagedApplicationPaths("darwin-arm64", "/Volumes/EasyResearch")).toEqual({
      executable: "/Volumes/EasyResearch/EasyResearch.app/Contents/MacOS/EasyResearch",
      sidecar: "/Volumes/EasyResearch/EasyResearch.app/Contents/Resources/sidecar/easyresearch",
    });
  });
});

describe("desktop smoke milestones", () => {
  it("recognizes the complete ordered lifecycle", () => {
    expect(reduceDesktopSmokeEvents([
      { type: "desktop-smoke.sidecar-ready", origin: "http://127.0.0.1:43123" },
      { type: "desktop-smoke.window-loaded" },
      { type: "desktop-smoke.state-visible" },
      { type: "desktop-smoke.agent-running" },
      { type: "desktop-smoke.window-hidden", hidden: true, sidecarPid: 42 },
      { type: "desktop-smoke.exit-started" },
      { type: "desktop-smoke.sidecar-stopped" },
    ])).toMatchObject({
      origin: "http://127.0.0.1:43123",
      loaded: true,
      stateVisible: true,
      agentRunning: true,
      hidden: true,
      sidecarPid: 42,
      exitStarted: true,
      stopped: true,
    });
  });

  it("rejects out-of-order or malformed milestones", () => {
    expect(() => reduceDesktopSmokeEvents([
      { type: "desktop-smoke.window-loaded" },
    ])).toThrow(/before sidecar readiness/i);
    expect(() => reduceDesktopSmokeEvents([
      { type: "desktop-smoke.sidecar-ready", origin: "http://0.0.0.0:3000" },
    ])).toThrow(/loopback origin/i);
    expect(() => reduceDesktopSmokeEvents([
      { type: "desktop-smoke.sidecar-ready", origin: "http://127.0.0.1:43123" },
      { type: "desktop-smoke.window-loaded" },
      { type: "desktop-smoke.state-visible" },
      { type: "desktop-smoke.agent-running" },
      { type: "desktop-smoke.window-hidden", hidden: true, sidecarPid: 0 },
    ])).toThrow(/sidecar process/i);
  });

  it("reads complete JSONL events and rejects a partial trailing record", () => {
    const path = join(root, "events.jsonl");
    writeFileSync(path, '{"type":"desktop-smoke.sidecar-ready","origin":"http://127.0.0.1:43123"}\n');
    expect(readDesktopSmokeEvents(path)).toHaveLength(1);
    writeFileSync(path, '{"type":"desktop-smoke.sidecar-ready"');
    expect(() => readDesktopSmokeEvents(path)).toThrow(/invalid desktop smoke event/i);
  });
});
