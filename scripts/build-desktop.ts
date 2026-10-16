#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Configuration } from "electron-builder";
import {
  TARGETS,
  type BuildArtifact,
  type BuildManifest,
  buildManifestPath,
  platformBinaryName,
  platformPackageDir,
  releaseDir,
  repoPackageVersion,
} from "./build";
import { validateBuildArtifact } from "./release";
import {
  THIRD_PARTY_NOTICES_FILE,
  assertThirdPartyNoticesFile,
  generateThirdPartyNotices,
} from "./third-party-notices";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ELECTRON_VERSION = "42.3.3";
export const DESKTOP_ICON_DIR = join(ROOT, "src", "desktop", "assets");
export const DESKTOP_ICON_RESOURCE = {
  from: DESKTOP_ICON_DIR,
  to: "icons",
  filter: ["icon.png", "tray.png", "tray@2x.png"],
};

export type DesktopTargetName = "windows-x64" | "darwin-arm64" | "linux-arm64";
export type DesktopPackageFormat = "nsis" | "dmg" | "AppImage" | "deb";

export const DESKTOP_TARGETS: readonly DesktopTargetName[] = ["darwin-arm64", "linux-arm64", "windows-x64"];

export interface DesktopPackageArtifact {
  format: DesktopPackageFormat;
  fileName: string;
  size: number;
  sha256: string;
}

export interface DesktopTarget {
  name: DesktopTargetName;
  platform: "win32" | "darwin" | "linux";
  arch: "x64" | "arm64";
  binaryName: "easyresearch.exe" | "easyresearch";
  packages: ReadonlyArray<{ format: DesktopPackageFormat; extension: string }>;
}

export interface DesktopBuildManifest {
  version: string;
  target: DesktopTargetName;
  electronVersion: string;
  sidecar: BuildArtifact;
  packages: DesktopPackageArtifact[];
  builtAt: string;
}

export function desktopTarget(name: string): DesktopTarget {
  if (name === "windows-x64") {
    return {
      name,
      platform: "win32",
      arch: "x64",
      binaryName: "easyresearch.exe",
      packages: [{ format: "nsis", extension: ".exe" }],
    };
  }
  if (name === "darwin-arm64") {
    return {
      name,
      platform: "darwin",
      arch: "arm64",
      binaryName: "easyresearch",
      packages: [{ format: "dmg", extension: ".dmg" }],
    };
  }
  if (name === "linux-arm64") {
    return {
      name,
      platform: "linux",
      arch: "arm64",
      binaryName: "easyresearch",
      packages: [
        { format: "AppImage", extension: ".AppImage" },
        { format: "deb", extension: ".deb" },
      ],
    };
  }
  throw new Error(`EasyResearch has no desktop package for ${name}.`);
}

export function desktopPackageFileName(
  targetName: DesktopTargetName,
  format: DesktopPackageFormat,
  version: string,
): string {
  const definition = desktopTarget(targetName).packages.find((candidate) => candidate.format === format);
  if (!definition) throw new Error(`Unsupported desktop package format ${format} for ${targetName}.`);
  const platformName = targetName === "darwin-arm64" ? "macos-arm64" : targetName;
  return `EasyResearch-${version}-${platformName}${definition.extension}`;
}

export function validateDesktopBuildManifest(
  value: unknown,
  targetName: DesktopTargetName,
  version: string,
): DesktopBuildManifest {
  const target = desktopTarget(targetName);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid desktop manifest for ${targetName}.`);
  }
  const manifest = value as DesktopBuildManifest;
  if (manifest.target !== targetName) throw new Error(`Desktop manifest target mismatch for ${targetName}.`);
  if (manifest.version !== version || manifest.sidecar?.version !== version) {
    throw new Error(`Desktop manifest version mismatch for ${targetName}: expected ${version}.`);
  }
  if (manifest.electronVersion !== ELECTRON_VERSION) {
    throw new Error(`Desktop Electron version mismatch for ${targetName}.`);
  }
  if (manifest.sidecar.target !== targetName || manifest.sidecar.binaryName !== target.binaryName) {
    throw new Error(`Desktop sidecar target mismatch for ${targetName}.`);
  }
  if (!Number.isSafeInteger(manifest.sidecar.size) || manifest.sidecar.size <= 0
    || typeof manifest.sidecar.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sidecar.sha256)) {
    throw new Error(`Invalid desktop sidecar record for ${targetName}.`);
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== target.packages.length) {
    throw new Error(`Desktop package formats are incomplete for ${targetName}.`);
  }
  for (const { format } of target.packages) {
    const matches = manifest.packages.filter((record) => record?.format === format);
    if (matches.length !== 1) {
      throw new Error(`Missing or duplicate desktop package format ${format} for ${targetName}.`);
    }
    const record = matches[0]!;
    const expected = desktopPackageFileName(targetName, format, version);
    if (record.fileName !== expected) {
      throw new Error(`Desktop package name mismatch for ${targetName}: expected ${expected}.`);
    }
    if (!Number.isSafeInteger(record.size) || record.size <= 0
      || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) {
      throw new Error(`Invalid desktop package record for ${expected}.`);
    }
  }
  return manifest;
}

export function stageLinuxAppRun(appOutDir: string): void {
  // The pinned AppImage builder writes its launcher first, then copies appOutDir
  // over the AppDir. This owned launcher replaces its unsandboxed fallback.
  const launcher = `#!/bin/sh
set -eu
if [ -z "\${APPDIR:-}" ]; then
  APPDIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
fi
export APPDIR
exec "$APPDIR/easyresearch-desktop" "$@"
`;
  const path = join(appOutDir, "AppRun");
  writeFileSync(path, launcher, { mode: 0o755 });
  chmodSync(path, 0o755);
}

export function assertNativeDesktopHost(
  targetName: DesktopTargetName,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): void {
  const target = desktopTarget(targetName);
  if (platform !== target.platform || arch !== target.arch) {
    throw new Error(
      `${targetName} must be packaged on ${target.platform}-${target.arch}, not ${platform}-${arch}.`,
    );
  }
}

export function validateDesktopSidecar(
  targetName: DesktopTargetName,
  manifest: BuildManifest,
  binary: string,
  version: string,
): BuildArtifact {
  if (manifest.version !== version) {
    throw new Error(`Native manifest version mismatch for desktop ${targetName}.`);
  }
  const nativeTarget = TARGETS.find((candidate) => candidate.name === targetName);
  if (!nativeTarget) throw new Error(`Missing native target definition for ${targetName}.`);
  const matches = manifest.artifacts.filter((artifact) => artifact.target === targetName);
  if (matches.length !== 1) {
    throw new Error(`Native manifest must contain exactly one ${targetName} target artifact.`);
  }
  const artifact = matches[0]!;
  validateBuildArtifact(artifact, nativeTarget, version, binary);
  return artifact;
}

export function stageDesktopNotices(
  source: string,
  destination: string,
  expectedContents: string,
): void {
  assertThirdPartyNoticesFile(source, expectedContents);
  copyFileSync(source, destination);
  assertThirdPartyNoticesFile(destination, expectedContents);
}

export function electronBuilderConfig(
  targetName: DesktopTargetName,
  version: string,
  stageDir: string,
  outputDir: string,
): Configuration {
  desktopTarget(targetName);
  const common: Configuration = {
    appId: "ai.easyresearch.desktop",
    productName: "EasyResearch",
    electronVersion: ELECTRON_VERSION,
    asar: true,
    files: ["main.cjs", "preload.cjs", "package.json"],
    extraResources: [{ from: "sidecar", to: "sidecar" }, DESKTOP_ICON_RESOURCE],
    directories: { app: stageDir, output: outputDir },
    npmRebuild: false,
    buildDependenciesFromSource: false,
    forceCodeSigning: false,
    publish: null,
  };
  if (targetName === "windows-x64") {
    return {
      ...common,
      win: {
        icon: join(DESKTOP_ICON_DIR, "icon.ico"),
        signExecutable: false,
        target: [{ target: "nsis", arch: ["x64"] }],
        artifactName: `EasyResearch-${version}-windows-x64.\${ext}`,
      },
      nsis: {
        installerIcon: join(DESKTOP_ICON_DIR, "icon.ico"),
        uninstallerIcon: join(DESKTOP_ICON_DIR, "icon.ico"),
        perMachine: false,
        oneClick: true,
        allowElevation: false,
        differentialPackage: false,
      },
    };
  }
  if (targetName === "linux-arm64") {
    return {
      ...common,
      linux: {
        icon: join(DESKTOP_ICON_DIR, "icon.png"),
        executableName: "easyresearch-desktop",
        category: "Science",
        maintainer: "hdu-ailab",
        target: [{ target: "AppImage", arch: ["arm64"] }, { target: "deb", arch: ["arm64"] }],
        artifactName: `EasyResearch-${version}-linux-arm64.\${ext}`,
      },
      appImage: { executableArgs: [] },
      afterPack: async ({ appOutDir }) => stageLinuxAppRun(appOutDir),
    };
  }
  return {
    ...common,
    mac: {
      icon: join(DESKTOP_ICON_DIR, "icon.icns"),
      identity: null,
      notarize: false,
      hardenedRuntime: false,
      gatekeeperAssess: false,
      target: [{ target: "dmg", arch: ["arm64"] }],
      artifactName: `EasyResearch-${version}-macos-arm64.\${ext}`,
    },
  };
}

export function desktopBuilderInvocation(
  targetName: DesktopTargetName,
  version: string,
  stageDir: string,
  outputDir: string,
): { projectDir: string; config: Configuration } {
  return {
    projectDir: stageDir,
    config: electronBuilderConfig(targetName, version, stageDir, outputDir),
  };
}

export async function buildDesktop(targetName: DesktopTargetName): Promise<DesktopBuildManifest> {
  assertNativeDesktopHost(targetName);
  const target = desktopTarget(targetName);
  const version = repoPackageVersion();
  const nativeManifest = JSON.parse(
    readFileSync(buildManifestPath(targetName), "utf8"),
  ) as BuildManifest;
  const sourceBinary = join(platformPackageDir(targetName), "bin", target.binaryName);
  const acceptedSidecar = validateDesktopSidecar(targetName, nativeManifest, sourceBinary, version);

  const stageDir = join(releaseDir(), "desktop-stage", targetName);
  const outputDir = join(releaseDir(), "desktop");
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(join(stageDir, "sidecar"), { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  await bundleDesktopHost(stageDir);
  writeFileSync(join(stageDir, "package.json"), `${JSON.stringify({
    name: "easyresearch-desktop",
    productName: "EasyResearch",
    version,
    description: "EasyResearch desktop application",
    homepage: "https://github.com/hdu-ailab/EasyResearch",
    main: "main.cjs",
    author: "hdu-ailab",
    license: "MIT",
  }, null, 2)}\n`);
  const stagedSidecar = join(stageDir, "sidecar", target.binaryName);
  copyFileSync(sourceBinary, stagedSidecar);
  if (target.platform !== "win32") chmodSync(stagedSidecar, 0o755);
  validateDesktopSidecar(targetName, nativeManifest, stagedSidecar, version);
  stageDesktopNotices(
    join(platformPackageDir(targetName), THIRD_PARTY_NOTICES_FILE),
    join(stageDir, "sidecar", THIRD_PARTY_NOTICES_FILE),
    generateThirdPartyNotices(ROOT),
  );

  const { Arch, Platform, build } = await import("electron-builder");
  const platform = target.platform === "win32" ? Platform.WINDOWS
    : target.platform === "darwin" ? Platform.MAC : Platform.LINUX;
  const targets = platform.createTarget(
    target.packages.map((entry) => entry.format),
    target.arch === "x64" ? Arch.x64 : Arch.arm64,
  );
  const invocation = desktopBuilderInvocation(targetName, version, stageDir, outputDir);
  const artifacts = await build({
    projectDir: invocation.projectDir,
    targets,
    config: invocation.config,
    publish: "never",
  });
  const packages = target.packages.map(({ format }): DesktopPackageArtifact => {
    const fileName = desktopPackageFileName(targetName, format, version);
    const matches = artifacts.filter((path) => basename(path) === fileName);
    if (matches.length !== 1) {
      throw new Error(`Desktop build for ${targetName} must produce exactly one ${fileName}.`);
    }
    const packagePath = matches[0]!;
    return {
      format,
      fileName,
      size: statSync(packagePath).size,
      sha256: createHash("sha256").update(readFileSync(packagePath)).digest("hex"),
    };
  });
  const manifest: DesktopBuildManifest = {
    version,
    target: targetName,
    electronVersion: ELECTRON_VERSION,
    sidecar: acceptedSidecar,
    packages,
    builtAt: new Date().toISOString(),
  };
  validateDesktopBuildManifest(manifest, targetName, version);
  writeFileSync(
    join(releaseDir(), `desktop-manifest-${targetName}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

async function bundleDesktopHost(stageDir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [
      join(ROOT, "src", "desktop", "main.ts"),
      join(ROOT, "src", "desktop", "preload.ts"),
    ],
    outdir: stageDir,
    naming: "[name].cjs",
    target: "node",
    format: "cjs",
    external: ["electron"],
    minify: true,
    sourcemap: "none",
  });
  if (!result.success) {
    throw new AggregateError(
      result.logs.map((log) => new Error(log.message)),
      "Electron main/preload bundling failed",
    );
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error("Usage: bun scripts/build-desktop.ts <windows-x64|darwin-arm64|linux-arm64>");
  await buildDesktop(desktopTarget(args[0]!).name);
}
