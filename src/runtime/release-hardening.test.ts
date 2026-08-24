import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TARGETS, type BuildManifest } from "../../scripts/build";
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

  it("ships notices only from platform packages that contain the binary", () => {
    const platform = release.platformPackageManifest(TARGETS[0]!, "1.2.3");
    const meta = release.mainPackageManifest("1.2.3");
    expect(platform.files).toEqual([
      "bin/easyresearch",
      "README.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES.txt",
    ]);
    expect(meta.files).toEqual(["launcher.mjs", "README.md", "LICENSE"]);
  });

  it("marks Linux as glibc", () => {
    const platformPackageManifest = (release as typeof release & {
      platformPackageManifest(target: (typeof TARGETS)[number], version: string): Record<string, any>;
    }).platformPackageManifest;
    const manifest = platformPackageManifest(TARGETS.find((target) => target.name === "linux-x64")!, "1.2.3");
    expect(manifest.libc).toEqual(["glibc"]);
  });

  it("accepts npm pack JSON from both array and package-keyed npm versions", () => {
    const packedPaths = (release as typeof release & {
      packedPaths(output: string): Set<string>;
    }).packedPaths;
    const report = { files: [{ path: "package.json" }, { path: "README.md" }] };
    expect([...packedPaths(JSON.stringify([report]))]).toEqual(["package.json", "README.md"]);
    expect([...packedPaths(JSON.stringify({ easyresearch: report }))]).toEqual(["package.json", "README.md"]);
  });

  it("requires notices in a platform npm pack report", () => {
    const paths = new Set(["package.json", "README.md", "LICENSE", "bin/easyresearch"]);
    expect(() => release.assertPackedPaths(paths, true)).toThrow(/THIRD_PARTY_NOTICES/);
    paths.add("THIRD_PARTY_NOTICES.txt");
    expect(() => release.assertPackedPaths(paths, true)).not.toThrow();
    expect(() => release.assertPackedPaths(new Set(["package.json", "README.md", "LICENSE"]), false)).not.toThrow();
  });
});

describe("build artifact integrity", () => {
  it("combines one exact artifact from every requested native manifest fragment", () => {
    const combineBuildManifests = (release as typeof release & {
      combineBuildManifests(
        manifests: readonly BuildManifest[],
        targets: typeof TARGETS,
      ): BuildManifest;
    }).combineBuildManifests;
    const fragments = TARGETS.map((target): BuildManifest => ({
      version: "1.2.3",
      artifacts: [{
        version: "1.2.3",
        target: target.name,
        binaryName: target.os[0] === "win32" ? "easyresearch.exe" : "easyresearch",
        size: 1,
        sha256: `${target.name}-hash`,
        builtAt: "2026-08-17T00:00:00.000Z",
      }],
    }));

    const combined = combineBuildManifests(fragments, TARGETS);

    expect(combined.version).toBe("1.2.3");
    expect(combined.artifacts.map((artifact) => artifact.target)).toEqual(TARGETS.map((target) => target.name));
    expect(() => combineBuildManifests(fragments.slice(1), TARGETS)).toThrow("missing manifest artifact");
  });

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

  it("rejects missing or changed platform notice bytes before release assembly", () => {
    const root = mkdtempSync(join(tmpdir(), "easyresearch-release-notices-"));
    tempDirs.push(root);

    expect(() => release.assertPlatformPackageNotices(root, "expected\n")).toThrow(
      /Missing third-party notices/,
    );
    writeFileSync(join(root, "THIRD_PARTY_NOTICES.txt"), "changed\n", "utf8");
    expect(() => release.assertPlatformPackageNotices(root, "expected\n")).toThrow(
      /Changed third-party notices/,
    );
    writeFileSync(join(root, "THIRD_PARTY_NOTICES.txt"), "expected\n", "utf8");
    expect(() => release.assertPlatformPackageNotices(root, "expected\n")).not.toThrow();
  });

  it("rejects native smoke output for another version", () => {
    const validateNativeVersionOutput = (release as typeof release & {
      validateNativeVersionOutput(status: number | null, stdout: string, version: string, target: string): void;
    }).validateNativeVersionOutput;
    expect(() => validateNativeVersionOutput(
      0,
      "easyresearch 1.2.2\n",
      "1.2.3",
      "linux-x64",
      "runtime notice\n",
    )).toThrow(/version smoke failed.*easyresearch 1\.2\.2.*runtime notice/s);
  });

  it("accepts the exact native version line from stderr", () => {
    const validateNativeVersionOutput = (release as typeof release & {
      validateNativeVersionOutput(
        status: number | null,
        stdout: string,
        version: string,
        target: string,
        stderr?: string,
      ): void;
    }).validateNativeVersionOutput;
    expect(() => validateNativeVersionOutput(
      0,
      "",
      "1.2.3",
      "windows-x64",
      "runtime notice\r\neasyresearch 1.2.3\r\n",
    )).not.toThrow();
  });
});
