import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DESKTOP_TARGETS,
  desktopPackageFileName,
  desktopTarget,
  type DesktopBuildManifest,
  type DesktopTargetName,
} from "../../scripts/build-desktop";
import { prepareDesktopRelease } from "../../scripts/prepare-desktop-release";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-prepare-desktop-release-"));
  mkdirSync(join(root, "desktop"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function save(manifest: DesktopBuildManifest): void {
  writeFileSync(join(root, `desktop-manifest-${manifest.target}.json`), JSON.stringify(manifest));
}

function writeTarget(target: DesktopTargetName): DesktopBuildManifest {
  const definition = desktopTarget(target);
  const manifest: DesktopBuildManifest = {
    version: "1.2.3", target, electronVersion: "42.3.3",
    sidecar: {
      version: "1.2.3", target, binaryName: definition.binaryName, size: 100,
      sha256: createHash("sha256").update(`${target}-sidecar`).digest("hex"),
      builtAt: "2026-10-15T00:00:00.000Z",
    },
    packages: definition.packages.map(({ format }) => {
      const bytes = `${target}-${format}-accepted-package`;
      const fileName = desktopPackageFileName(target, format, "1.2.3");
      writeFileSync(join(root, "desktop", fileName), bytes);
      return { format, fileName, size: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
    }),
    builtAt: "2026-10-15T00:00:00.000Z",
  };
  save(manifest);
  return manifest;
}

function writeAll(): DesktopBuildManifest[] {
  return DESKTOP_TARGETS.map(writeTarget);
}

describe("desktop release preparation", () => {
  it("requires every target and includes both Linux formats in canonical filename-sorted checksums", () => {
    const written = writeAll();
    const result = prepareDesktopRelease(root, "1.2.3");
    expect(new Set(result.map((item) => item.target))).toEqual(new Set(DESKTOP_TARGETS));
    expect(result.find((item) => item.target === "linux-arm64")?.packages.map((item) => item.format))
      .toEqual(["AppImage", "deb"]);
    const packages = written.flatMap((item) => item.packages)
      .sort((a, b) => a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0);
    expect(readFileSync(join(root, "desktop", "SHA256SUMS"), "utf8"))
      .toBe(`${packages.map((item) => `${item.sha256}  ${item.fileName}`).join("\n")}\n`);
  });

  it.each(["AppImage", "deb"])("refuses publication when the required Linux %s record is missing", (format) => {
    const manifests = writeAll();
    const linux = manifests.find((item) => item.target === "linux-arm64")!;
    linux.packages = linux.packages.filter((item) => item.format !== format);
    save(linux);
    expect(() => prepareDesktopRelease(root, "1.2.3")).toThrow(/package|format/i);
  });

  it("rejects a missing target, version mismatch and modified package bytes", () => {
    writeTarget("windows-x64");
    expect(() => prepareDesktopRelease(root, "1.2.3")).toThrow(/darwin-arm64/);
    writeAll();
    expect(() => prepareDesktopRelease(root, "1.2.4")).toThrow(/version/i);
    writeFileSync(join(root, "desktop", desktopPackageFileName("linux-arm64", "deb", "1.2.3")), "changed");
    expect(() => prepareDesktopRelease(root, "1.2.3")).toThrow(/size|SHA-256/i);
  });

  it("rejects duplicate formats rather than allowing one Linux package to stand in for both", () => {
    const linux = writeAll().find((item) => item.target === "linux-arm64")!;
    linux.packages[1] = { ...linux.packages[0]! };
    save(linux);
    expect(() => prepareDesktopRelease(root, "1.2.3")).toThrow(/package|format|duplicate/i);
  });

  it("rejects a valid hash under a noncanonical package name", () => {
    const windows = writeAll().find((item) => item.target === "windows-x64")!;
    windows.packages[0]!.fileName = "EasyResearch-1.2.3-windows.exe";
    save(windows);
    expect(() => prepareDesktopRelease(root, "1.2.3")).toThrow(/package name/i);
  });

  it("rejects a sidecar from another architecture", () => {
    const linux = writeAll().find((item) => item.target === "linux-arm64")!;
    linux.sidecar.target = "linux-x64";
    save(linux);
    expect(() => prepareDesktopRelease(root, "1.2.3")).toThrow(/sidecar.*target/i);
  });
});
