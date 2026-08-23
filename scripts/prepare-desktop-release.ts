import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DesktopBuildManifest, DesktopTargetName } from "./build-desktop";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredTargets: readonly DesktopTargetName[] = ["darwin-arm64", "windows-x64"];

export function prepareDesktopRelease(
  releaseRoot: string,
  version: string,
): DesktopBuildManifest[] {
  const manifests = requiredTargets.map((target) => {
    const manifestPath = join(releaseRoot, `desktop-manifest-${target}.json`);
    if (!existsSync(manifestPath)) {
      throw new Error(`Missing required desktop manifest for ${target}: ${manifestPath}`);
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DesktopBuildManifest;
    validateManifest(manifest, target, version, manifestPath);
    validatePackage(releaseRoot, manifest);
    return manifest;
  });

  const checksumPath = join(releaseRoot, "desktop", "SHA256SUMS");
  writeFileSync(
    checksumPath,
    `${manifests.map((manifest) => `${manifest.package.sha256}  ${manifest.package.fileName}`).join("\n")}\n`,
  );
  return manifests;
}

function validateManifest(
  manifest: DesktopBuildManifest,
  target: DesktopTargetName,
  version: string,
  manifestPath: string,
): void {
  const expectedPackageName = target === "windows-x64"
    ? `EasyResearch-${version}-windows-x64.exe`
    : `EasyResearch-${version}-macos-arm64.dmg`;
  if (manifest.target !== target) {
    throw new Error(`Desktop manifest target mismatch in ${manifestPath}: expected ${target}.`);
  }
  if (manifest.version !== version || manifest.sidecar?.version !== version) {
    throw new Error(`Desktop manifest version mismatch in ${manifestPath}: expected ${version}.`);
  }
  if (manifest.sidecar.target !== target) {
    throw new Error(`Desktop sidecar target mismatch in ${manifestPath}: expected ${target}.`);
  }
  if (
    !manifest.package
    || typeof manifest.package.fileName !== "string"
    || basename(manifest.package.fileName) !== manifest.package.fileName
    || typeof manifest.package.size !== "number"
    || !Number.isSafeInteger(manifest.package.size)
    || manifest.package.size <= 0
    || !/^[a-f0-9]{64}$/.test(manifest.package.sha256)
  ) {
    throw new Error(`Invalid desktop package record in ${manifestPath}.`);
  }
  if (manifest.package.fileName !== expectedPackageName) {
    throw new Error(
      `Desktop package name mismatch in ${manifestPath}: expected ${expectedPackageName}.`,
    );
  }
}

function validatePackage(releaseRoot: string, manifest: DesktopBuildManifest): void {
  const packagePath = join(releaseRoot, "desktop", manifest.package.fileName);
  if (!existsSync(packagePath)) {
    throw new Error(`Desktop package is missing: ${packagePath}`);
  }
  const actualSize = statSync(packagePath).size;
  if (actualSize !== manifest.package.size) {
    throw new Error(
      `Desktop package size mismatch for ${manifest.package.fileName}: expected ${manifest.package.size}, got ${actualSize}.`,
    );
  }
  const actualHash = createHash("sha256").update(readFileSync(packagePath)).digest("hex");
  if (actualHash !== manifest.package.sha256) {
    throw new Error(`Desktop package SHA-256 mismatch for ${manifest.package.fileName}.`);
  }
}

if (import.meta.main) {
  const releaseRoot = resolve(process.argv[2] ?? join(projectRoot, "release"));
  const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
    version: string;
  };
  const manifests = prepareDesktopRelease(releaseRoot, packageJson.version);
  console.log(
    `[desktop-release] verified ${manifests.length} packages and wrote ${join(releaseRoot, "desktop", "SHA256SUMS")}`,
  );
}
