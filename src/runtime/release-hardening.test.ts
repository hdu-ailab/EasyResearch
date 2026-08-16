import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TARGETS } from "../../scripts/build";
import * as release from "../../scripts/release";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("release argument validation", () => {
  it("rejects unknown flags, missing --only values, and unsupported targets", () => {
    expect(() => release.parseFlags(["--bogus"])).toThrow("unknown release flag");
    expect(() => release.parseFlags(["--only"])).toThrow("requires a target");
    expect(() => release.parseFlags(["--only", "linux-arm64"])).toThrow("unknown target");
  });
});

describe("package manifests", () => {
  it("always gives the meta package every supported exact-version dependency", () => {
    const mainPackageManifest = (release as typeof release & {
      mainPackageManifest(version: string): Record<string, any>;
    }).mainPackageManifest;
    const manifest = mainPackageManifest("1.2.3");
    expect(manifest.files).toEqual(["launcher.mjs", "README.md", "LICENSE"]);
    expect(manifest.optionalDependencies).toEqual(Object.fromEntries(
      TARGETS.map((target) => [`easyresearch-${target.name}`, "1.2.3"]),
    ));
  });

  it("marks Linux as glibc and restricts platform package contents", () => {
    const platformPackageManifest = (release as typeof release & {
      platformPackageManifest(target: (typeof TARGETS)[number], version: string): Record<string, any>;
    }).platformPackageManifest;
    const manifest = platformPackageManifest(TARGETS.find((target) => target.name === "linux-x64")!, "1.2.3");
    expect(manifest.libc).toEqual(["glibc"]);
    expect(manifest.files).toEqual(["bin/easyresearch", "README.md", "LICENSE"]);
  });

  it("accepts npm pack JSON from both array and package-keyed npm versions", () => {
    const packedPaths = (release as typeof release & {
      packedPaths(output: string): Set<string>;
    }).packedPaths;
    const report = { files: [{ path: "package.json" }, { path: "README.md" }] };
    expect([...packedPaths(JSON.stringify([report]))]).toEqual(["package.json", "README.md"]);
    expect([...packedPaths(JSON.stringify({ easyresearch: report }))]).toEqual(["package.json", "README.md"]);
  });
});

describe("build artifact integrity", () => {
  it("rejects a binary whose bytes no longer match its manifest", () => {
    const validateBuildArtifact = (release as typeof release & {
      validateBuildArtifact(record: Record<string, unknown>, target: (typeof TARGETS)[number], version: string, binary: string): void;
    }).validateBuildArtifact;
    const root = mkdtempSync(join(tmpdir(), "easyresearch-release-"));
    tempDirs.push(root);
    const binary = join(root, "easyresearch");
    writeFileSync(binary, "new bytes");

    expect(() => validateBuildArtifact({
      version: "1.2.3",
      target: "linux-x64",
      binaryName: "easyresearch",
      size: 9,
      sha256: "stale-hash",
      builtAt: new Date().toISOString(),
    }, TARGETS[0]!, "1.2.3", binary)).toThrow("SHA-256");
  });

  it("rejects native smoke output for another version", () => {
    const validateNativeVersionOutput = (release as typeof release & {
      validateNativeVersionOutput(status: number | null, stdout: string, version: string, target: string): void;
    }).validateNativeVersionOutput;
    expect(() => validateNativeVersionOutput(0, "easyresearch 1.2.2\n", "1.2.3", "linux-x64"))
      .toThrow("version smoke failed");
  });
});
