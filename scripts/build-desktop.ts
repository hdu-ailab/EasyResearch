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
import { dirname, extname, join } from "node:path";
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

export type DesktopTargetName = "windows-x64" | "darwin-arm64";

export interface DesktopTarget {
  name: DesktopTargetName;
  platform: "win32" | "darwin";
  arch: "x64" | "arm64";
  electronTarget: "nsis" | "dmg";
  binaryName: "easyresearch.exe" | "easyresearch";
  packageExtension: ".exe" | ".dmg";
}

export interface DesktopBuildManifest {
  version: string;
  target: DesktopTargetName;
  electronVersion: string;
  sidecar: BuildArtifact;
  package: {
    fileName: string;
    size: number;
    sha256: string;
  };
  builtAt: string;
}

export function desktopTarget(name: string): DesktopTarget {
  if (name === "windows-x64") {
    return {
      name,
      platform: "win32",
      arch: "x64",
      electronTarget: "nsis",
      binaryName: "easyresearch.exe",
      packageExtension: ".exe",
    };
  }
  if (name === "darwin-arm64") {
    return {
      name,
      platform: "darwin",
      arch: "arm64",
      electronTarget: "dmg",
      binaryName: "easyresearch",
      packageExtension: ".dmg",
    };
  }
  throw new Error(`EasyResearch has no desktop package for ${name}.`);
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
  const common: Configuration = {
    appId: "ai.easyresearch.desktop",
    productName: "EasyResearch",
    electronVersion: ELECTRON_VERSION,
    asar: true,
    files: ["main.cjs", "preload.cjs", "package.json"],
    extraResources: [{ from: "sidecar", to: "sidecar" }],
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
        signExecutable: false,
        target: [{ target: "nsis", arch: ["x64"] }],
        artifactName: `EasyResearch-${version}-windows-x64.\${ext}`,
      },
      nsis: {
        perMachine: false,
        oneClick: true,
        allowElevation: false,
        differentialPackage: false,
      },
    };
  }
  return {
    ...common,
    mac: {
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
    main: "main.cjs",
    author: "hdu-ailab",
    license: "MIT",
  }, null, 2)}\n`);
  const stagedSidecar = join(stageDir, "sidecar", target.binaryName);
  copyFileSync(sourceBinary, stagedSidecar);
  if (target.platform === "darwin") chmodSync(stagedSidecar, 0o755);
  validateDesktopSidecar(targetName, nativeManifest, stagedSidecar, version);
  stageDesktopNotices(
    join(platformPackageDir(targetName), THIRD_PARTY_NOTICES_FILE),
    join(stageDir, "sidecar", THIRD_PARTY_NOTICES_FILE),
    generateThirdPartyNotices(ROOT),
  );

  const { Arch, Platform, build } = await import("electron-builder");
  const targets = target.platform === "win32"
    ? Platform.WINDOWS.createTarget([target.electronTarget], Arch.x64)
    : Platform.MAC.createTarget([target.electronTarget], Arch.arm64);
  const invocation = desktopBuilderInvocation(targetName, version, stageDir, outputDir);
  const artifacts = await build({
    projectDir: invocation.projectDir,
    targets,
    config: invocation.config,
    publish: "never",
  });
  const packages = artifacts.filter((path) => extname(path).toLowerCase() === target.packageExtension);
  if (packages.length !== 1) {
    throw new Error(
      `Desktop build for ${targetName} produced ${packages.length} primary packages; expected exactly one.`,
    );
  }
  const packagePath = packages[0]!;
  const packageBytes = readFileSync(packagePath);
  const manifest: DesktopBuildManifest = {
    version,
    target: targetName,
    electronVersion: ELECTRON_VERSION,
    sidecar: acceptedSidecar,
    package: {
      fileName: packagePath.slice(Math.max(packagePath.lastIndexOf("/"), packagePath.lastIndexOf("\\")) + 1),
      size: statSync(packagePath).size,
      sha256: createHash("sha256").update(packageBytes).digest("hex"),
    },
    builtAt: new Date().toISOString(),
  };
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
  if (args.length !== 1) throw new Error("Usage: bun scripts/build-desktop.ts <windows-x64|darwin-arm64>");
  await buildDesktop(desktopTarget(args[0]!).name);
}
