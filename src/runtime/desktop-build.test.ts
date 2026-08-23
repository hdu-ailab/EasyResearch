import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BuildManifest } from "../../scripts/build";
import {
  assertNativeDesktopHost,
  desktopBuilderInvocation,
  desktopTarget,
  electronBuilderConfig,
  validateDesktopSidecar,
} from "../../scripts/build-desktop";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-desktop-build-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixture(bytes = "accepted-sidecar") {
  const binary = join(root, "easyresearch.exe");
  writeFileSync(binary, bytes);
  const manifest: BuildManifest = {
    version: "1.2.3",
    artifacts: [{
      version: "1.2.3",
      target: "windows-x64",
      binaryName: "easyresearch.exe",
      size: Buffer.byteLength(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      builtAt: "2026-08-23T00:00:00.000Z",
    }],
  };
  return { binary, manifest };
}

describe("desktop target selection", () => {
  it("maps only the two supported native targets", () => {
    expect(desktopTarget("windows-x64")).toEqual({
      name: "windows-x64",
      platform: "win32",
      arch: "x64",
      electronTarget: "nsis",
      binaryName: "easyresearch.exe",
      packageExtension: ".exe",
    });
    expect(desktopTarget("darwin-arm64")).toEqual({
      name: "darwin-arm64",
      platform: "darwin",
      arch: "arm64",
      electronTarget: "dmg",
      binaryName: "easyresearch",
      packageExtension: ".dmg",
    });
    expect(() => desktopTarget("linux-x64")).toThrow(/no desktop package/i);
  });

  it("requires packaging on the matching native host", () => {
    expect(() => assertNativeDesktopHost("windows-x64", "linux", "x64"))
      .toThrow(/must be packaged on win32-x64/i);
    expect(() => assertNativeDesktopHost("windows-x64", "win32", "x64"))
      .not.toThrow();
  });
});

describe("accepted sidecar integrity", () => {
  it("returns the exact matching native artifact", () => {
    const { binary, manifest } = fixture();
    expect(validateDesktopSidecar("windows-x64", manifest, binary, "1.2.3"))
      .toEqual(manifest.artifacts[0]);
  });

  it("rejects changed bytes before Electron packaging", () => {
    const { binary, manifest } = fixture();
    writeFileSync(binary, "changed");
    expect(() => validateDesktopSidecar("windows-x64", manifest, binary, "1.2.3"))
      .toThrow(/size|SHA-256/i);
  });

  it("rejects another target or version", () => {
    const { binary, manifest } = fixture();
    expect(() => validateDesktopSidecar("darwin-arm64", manifest, binary, "1.2.3"))
      .toThrow(/target/i);
    expect(() => validateDesktopSidecar("windows-x64", manifest, binary, "1.2.4"))
      .toThrow(/version/i);
  });
});

describe("electron-builder configuration", () => {
  it("uses the staging directory as the project root for relative sidecar resources", () => {
    const stage = join(root, "stage");
    const invocation = desktopBuilderInvocation(
      "windows-x64",
      "1.2.3",
      stage,
      join(root, "desktop"),
    );

    expect(invocation.projectDir).toBe(stage);
    const resource = Array.isArray(invocation.config.extraResources)
      ? invocation.config.extraResources[0]
      : undefined;
    expect(resource).toMatchObject({ from: "sidecar", to: "sidecar" });
    expect(join(invocation.projectDir, String((resource as { from?: unknown }).from)))
      .toBe(join(stage, "sidecar"));
  });

  it("uses explicit allowlists and unsigned arm64 DMG configuration", () => {
    const config = electronBuilderConfig(
      "darwin-arm64",
      "1.2.3",
      join(root, "stage"),
      join(root, "desktop"),
    );
    expect(config).toMatchObject({
      appId: "ai.easyresearch.desktop",
      productName: "EasyResearch",
      electronVersion: "42.3.3",
      asar: true,
      files: ["main.cjs", "preload.cjs", "package.json"],
      extraResources: [{ from: "sidecar", to: "sidecar" }],
      mac: {
        identity: null,
        notarize: false,
        target: [{ target: "dmg", arch: ["arm64"] }],
        artifactName: "EasyResearch-1.2.3-macos-arm64.${ext}",
      },
    });
  });

  it("uses a per-user unsigned x64 NSIS installer", () => {
    const config = electronBuilderConfig(
      "windows-x64",
      "1.2.3",
      join(root, "stage"),
      join(root, "desktop"),
    );
    expect(config).toMatchObject({
      win: {
        signExecutable: false,
        target: [{ target: "nsis", arch: ["x64"] }],
        artifactName: "EasyResearch-1.2.3-windows-x64.${ext}",
      },
      nsis: {
        perMachine: false,
        oneClick: true,
        allowElevation: false,
        differentialPackage: false,
      },
    });
  });
});
