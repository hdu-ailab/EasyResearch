import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesktopBuildManifest, DesktopTargetName } from "../../scripts/build-desktop";
import { prepareDesktopRelease } from "../../scripts/prepare-desktop-release";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-prepare-desktop-release-"));
  mkdirSync(join(root, "desktop"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeTarget(target: DesktopTargetName, bytes: string): DesktopBuildManifest {
  const fileName = target === "windows-x64"
    ? "EasyResearch-1.2.3-windows-x64.exe"
    : "EasyResearch-1.2.3-macos-arm64.dmg";
  writeFileSync(join(root, "desktop", fileName), bytes);
  const manifest: DesktopBuildManifest = {
    version: "1.2.3",
    target,
    electronVersion: "42.3.3",
    sidecar: {
      version: "1.2.3",
      target,
      binaryName: target === "windows-x64" ? "easyresearch.exe" : "easyresearch",
      size: 100,
      sha256: `${target}-sidecar-hash`,
      builtAt: "2026-08-23T00:00:00.000Z",
    },
    package: {
      fileName,
      size: Buffer.byteLength(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    builtAt: "2026-08-23T00:00:00.000Z",
  };
  writeFileSync(
    join(root, `desktop-manifest-${target}.json`),
    JSON.stringify(manifest),
  );
  return manifest;
}

describe("desktop release preparation", () => {
  it("requires both exact-version targets and writes sorted checksums", () => {
    const windows = writeTarget("windows-x64", "windows-installer");
    const mac = writeTarget("darwin-arm64", "mac-dmg");

    const result = prepareDesktopRelease(root, "1.2.3");

    expect(result.map((manifest) => manifest.target)).toEqual(["darwin-arm64", "windows-x64"]);
    expect(readFileSync(join(root, "desktop", "SHA256SUMS"), "utf8")).toBe([
      `${mac.package.sha256}  ${mac.package.fileName}`,
      `${windows.package.sha256}  ${windows.package.fileName}`,
      "",
    ].join("\n"));
  });

  it("rejects a missing target, version mismatch, or changed package bytes", () => {
    writeTarget("windows-x64", "windows-installer");
    expect(() => prepareDesktopRelease(root, "1.2.3")).toThrow(/darwin-arm64/);

    writeTarget("darwin-arm64", "mac-dmg");
    expect(() => prepareDesktopRelease(root, "1.2.4")).toThrow(/version/i);

    writeFileSync(join(root, "desktop", "EasyResearch-1.2.3-windows-x64.exe"), "changed");
    expect(() => prepareDesktopRelease(root, "1.2.3")).toThrow(/size|SHA-256/i);
  });

  it("rejects a valid package record under a noncanonical asset name", () => {
    const windows = writeTarget("windows-x64", "windows-installer");
    writeTarget("darwin-arm64", "mac-dmg");
    const wrongName = "EasyResearch-1.2.3-windows.exe";
    writeFileSync(join(root, "desktop", wrongName), "windows-installer");
    writeFileSync(join(root, "desktop-manifest-windows-x64.json"), JSON.stringify({
      ...windows,
      package: { ...windows.package, fileName: wrongName },
    }));

    expect(() => prepareDesktopRelease(root, "1.2.3")).toThrow(/package name/i);
  });
});
