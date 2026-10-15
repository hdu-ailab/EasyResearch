import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_TARGETS,
  validateDesktopBuildManifest,
  type DesktopBuildManifest,
  type DesktopPackageArtifact,
} from "./build-desktop";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function prepareDesktopRelease(releaseRoot: string, version: string): DesktopBuildManifest[] {
  const manifests = DESKTOP_TARGETS.map((target) => {
    const manifestPath = join(releaseRoot, `desktop-manifest-${target}.json`);
    if (!existsSync(manifestPath)) {
      throw new Error(`Missing required desktop manifest for ${target}: ${manifestPath}`);
    }
    const manifest = validateDesktopBuildManifest(
      JSON.parse(readFileSync(manifestPath, "utf8")), target, version,
    );
    for (const record of manifest.packages) validatePackage(releaseRoot, record);
    return manifest;
  });

  const packages = manifests.flatMap((manifest) => manifest.packages)
    .sort((a, b) => a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0);
  writeFileSync(
    join(releaseRoot, "desktop", "SHA256SUMS"),
    `${packages.map((record) => `${record.sha256}  ${record.fileName}`).join("\n")}\n`,
  );
  return manifests;
}

function validatePackage(releaseRoot: string, record: DesktopPackageArtifact): void {
  const packagePath = join(releaseRoot, "desktop", record.fileName);
  if (!existsSync(packagePath)) throw new Error(`Desktop package is missing: ${packagePath}`);
  if (statSync(packagePath).size !== record.size) {
    throw new Error(`Desktop package size mismatch for ${record.fileName}.`);
  }
  const actualHash = createHash("sha256").update(readFileSync(packagePath)).digest("hex");
  if (actualHash !== record.sha256) {
    throw new Error(`Desktop package SHA-256 mismatch for ${record.fileName}.`);
  }
}

if (import.meta.main) {
  const releaseRoot = resolve(process.argv[2] ?? join(projectRoot, "release"));
  const { version } = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as { version: string };
  const manifests = prepareDesktopRelease(releaseRoot, version);
  console.log(
    `[desktop-release] verified ${manifests.flatMap((manifest) => manifest.packages).length} packages and wrote ${join(releaseRoot, "desktop", "SHA256SUMS")}`,
  );
}
