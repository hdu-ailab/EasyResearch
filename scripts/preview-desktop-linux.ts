#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Configuration } from "electron-builder";
import {
  TARGETS,
  type BuildArtifact,
  type BuildManifest,
  buildManifestPath,
  repoPackageVersion,
} from "./build";
import { ELECTRON_VERSION } from "./build-desktop";
import { validateBuildArtifact } from "./release";

export interface LinuxPreviewPaths {
  stageDir: string;
  outputDir: string;
  appDir: string;
  executable: string;
  sourceSidecar: string;
  packagedSidecar: string;
  stateDir: string;
  homeDir: string;
  configDir: string;
  cacheDir: string;
  agentDir: string;
  projectDir: string;
  logPath: string;
  pidPath: string;
  lockPath: string;
}

export interface LinuxPreviewBuildLock {
  release(): boolean;
}

export function assertLinuxPreviewHost(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): void {
  if (platform !== "linux" || arch !== "x64") {
    throw new Error(`Desktop UI preview requires Linux x64, not ${platform}-${arch}.`);
  }
}

export function parseLinuxPreviewArgs(args: readonly string[]): { launch: boolean } {
  if (args.length === 0) return { launch: true };
  if (args.length === 1 && args[0] === "--no-launch") return { launch: false };
  throw new Error("Usage: bun run preview:desktop:linux [--no-launch]");
}

export function linuxPreviewPaths(repoRoot: string): LinuxPreviewPaths {
  const release = join(repoRoot, "release");
  const stageDir = join(release, "desktop-preview-stage-linux");
  const outputDir = join(release, "desktop-preview-linux");
  const appDir = join(outputDir, "linux-unpacked");
  const workspaceKey = createHash("sha256")
    .update(resolve(repoRoot))
    .digest("hex")
    .slice(0, 16);
  const userKey = process.getuid?.() ?? "unknown";
  const stateDir = join(tmpdir(), `easyresearch-desktop-preview-${userKey}`, workspaceKey);
  return {
    stageDir,
    outputDir,
    appDir,
    executable: join(appDir, "easyresearch-preview"),
    sourceSidecar: join(release, "easyresearch-linux-x64", "bin", "easyresearch"),
    packagedSidecar: join(appDir, "resources", "sidecar", "easyresearch"),
    stateDir,
    homeDir: join(stateDir, "home"),
    configDir: join(stateDir, "config"),
    cacheDir: join(stateDir, "cache"),
    agentDir: join(stateDir, "agent"),
    projectDir: join(stateDir, "project"),
    logPath: join(stateDir, "host.log"),
    pidPath: join(stateDir, "preview.pid"),
    lockPath: join(stateDir, "build.lock"),
  };
}

export function linuxPreviewBuilderConfig(
  stageDir: string,
  outputDir: string,
  version: string,
): Configuration {
  return {
    appId: "ai.easyresearch.desktop.preview",
    productName: "EasyResearch Preview",
    electronVersion: ELECTRON_VERSION,
    asar: true,
    files: ["main.cjs", "preload.cjs", "package.json"],
    extraResources: [{ from: "sidecar", to: "sidecar" }],
    directories: { app: stageDir, output: outputDir },
    npmRebuild: false,
    buildDependenciesFromSource: false,
    forceCodeSigning: false,
    publish: null,
    linux: {
      target: [{ target: "dir", arch: ["x64"] }],
      executableName: "easyresearch-preview",
      category: "Science",
      artifactName: `EasyResearch-Preview-${version}-linux-x64.\${ext}`,
    },
  };
}

export function createLinuxPreviewLaunchEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  paths: LinuxPreviewPaths,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HOME: paths.homeDir,
    XDG_CONFIG_HOME: paths.configDir,
    XDG_CACHE_HOME: paths.cacheDir,
    EASYRESEARCH_CODING_AGENT_DIR: paths.agentDir,
  };
  for (const name of Object.keys(env)) {
    if (
      name.startsWith("EASYRESEARCH_DESKTOP_")
      || name.startsWith("EASYRESEARCH_DAEMON_")
      || name.startsWith("EASYRESEARCH_SMOKE_")
      || name === "EASYRESEARCH_SKIP_SETUP"
      || name === "EASYRESEARCH_BUNDLED_ROOT"
      || name === "EASYRESEARCH_VENV"
    ) {
      delete env[name];
    }
  }
  return env;
}

export async function buildLinuxDesktopPreview(
  repoRoot: string,
  paths: LinuxPreviewPaths,
  version: string,
): Promise<void> {
  assertNoRunningPreview(paths);
  buildNativeSidecar(repoRoot);
  const artifact = validateNativeSidecar(paths.sourceSidecar, version);

  rmSync(paths.stageDir, { recursive: true, force: true });
  rmSync(paths.outputDir, { recursive: true, force: true });
  mkdirSync(join(paths.stageDir, "sidecar"), { recursive: true });
  mkdirSync(paths.outputDir, { recursive: true });
  ensureLinuxPreviewStateDirectories(paths);

  const bundle = await Bun.build({
    entrypoints: [
      join(repoRoot, "src", "desktop", "main.ts"),
      join(repoRoot, "src", "desktop", "preload.ts"),
    ],
    outdir: paths.stageDir,
    naming: "[name].cjs",
    target: "node",
    format: "cjs",
    external: ["electron"],
    minify: true,
    sourcemap: "none",
    plugins: [{
      name: "linux-desktop-preview-environment",
      setup(builder) {
        builder.onResolve({ filter: /^\.\/environment$/ }, (args) => {
          if (!args.importer.includes("/src/desktop/")) return undefined;
          return { path: "environment", namespace: "linux-desktop-preview" };
        });
        builder.onLoad(
          { filter: /^environment$/, namespace: "linux-desktop-preview" },
          () => ({ contents: linuxPreviewEnvironmentModule(), loader: "ts" }),
        );
      },
    }],
  });
  if (!bundle.success) {
    throw new AggregateError(
      bundle.logs.map((log) => new Error(log.message)),
      "Linux Desktop preview bundle failed",
    );
  }

  writeFileSync(join(paths.stageDir, "package.json"), `${JSON.stringify({
    name: "easyresearch-desktop-preview",
    productName: "EasyResearch Preview",
    version,
    description: "Development-only Linux preview of EasyResearch Desktop",
    main: "main.cjs",
    author: "hdu-ailab",
    license: "MIT",
  }, null, 2)}\n`);
  const stagedSidecar = join(paths.stageDir, "sidecar", "easyresearch");
  copyFileSync(paths.sourceSidecar, stagedSidecar);
  chmodSync(stagedSidecar, 0o755);
  validateBuildArtifact(artifact, linuxTarget(), version, stagedSidecar);

  const { Arch, Platform, build } = await import("electron-builder");
  await build({
    projectDir: paths.stageDir,
    targets: Platform.LINUX.createTarget(["dir"], Arch.x64),
    config: linuxPreviewBuilderConfig(paths.stageDir, paths.outputDir, version),
    publish: "never",
  });

  if (!existsSync(paths.executable)) {
    throw new Error(`Linux Desktop preview executable is missing: ${paths.executable}`);
  }
  validateBuildArtifact(artifact, linuxTarget(), version, paths.packagedSidecar);
  if ((statSync(paths.packagedSidecar).mode & 0o111) === 0) {
    throw new Error("Linux Desktop preview sidecar is not executable.");
  }
}

export async function launchLinuxDesktopPreview(
  paths: LinuxPreviewPaths,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  assertNoRunningPreview(paths);
  ensureLinuxPreviewStateDirectories(paths);
  const logFd = openPrivateAppendFile(paths.logPath);
  try {
    const child = spawn(paths.executable, [], {
      cwd: paths.projectDir,
      env: createLinuxPreviewLaunchEnvironment(baseEnv, paths),
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (!child.pid) throw new Error("Linux Desktop preview did not report a process id.");
    try {
      writePrivateExclusiveFile(paths.pidPath, `${child.pid}\n`);
    } catch (error) {
      stopDetachedProcess(child.pid);
      throw error;
    }
    child.unref();
    return child.pid;
  } finally {
    closeSync(logFd);
  }
}

function buildNativeSidecar(repoRoot: string): void {
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts", "build.ts"), "--only", "linux-x64"],
    { cwd: repoRoot, env: process.env, stdio: "inherit" },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Linux native sidecar build failed (${result.status ?? "no status"}): ${result.error?.message ?? ""}`,
    );
  }
}

function validateNativeSidecar(binary: string, version: string): BuildArtifact {
  const manifest = JSON.parse(readFileSync(buildManifestPath("linux-x64"), "utf8")) as BuildManifest;
  if (manifest.version !== version) {
    throw new Error(`Linux native manifest version mismatch: expected ${version}.`);
  }
  const artifacts = manifest.artifacts.filter((candidate) => candidate.target === "linux-x64");
  if (artifacts.length !== 1) {
    throw new Error("Linux native manifest must contain exactly one linux-x64 artifact.");
  }
  const artifact = artifacts[0]!;
  validateBuildArtifact(artifact, linuxTarget(), version, binary);
  return artifact;
}

function linuxTarget() {
  const target = TARGETS.find((candidate) => candidate.name === "linux-x64");
  if (!target) throw new Error("Missing linux-x64 native target definition.");
  return target;
}

export function ensureLinuxPreviewStateDirectories(paths: LinuxPreviewPaths): void {
  ensurePrivateDirectory(dirname(paths.stateDir));
  for (const path of [
    paths.stateDir,
    paths.homeDir,
    paths.configDir,
    paths.cacheDir,
    paths.agentDir,
    paths.projectDir,
  ]) {
    ensurePrivateDirectory(path);
  }
}

export function acquireLinuxPreviewBuildLock(
  paths: LinuxPreviewPaths,
): LinuxPreviewBuildLock {
  ensureLinuxPreviewStateDirectories(paths);
  const startedAt = linuxProcessStartTime(process.pid);
  if (!startedAt) {
    throw new Error("Cannot identify the Linux Desktop preview build process.");
  }

  while (true) {
    const token = randomUUID();
    const record = { pid: process.pid, startedAt, token };
    try {
      writePrivateExclusiveFile(paths.lockPath, `${JSON.stringify(record)}\n`);
      let released = false;
      return {
        release() {
          if (released) return false;
          const current = readPreviewBuildLock(paths.lockPath);
          if (!current || current.token !== token) return false;
          try {
            unlinkSync(paths.lockPath);
            released = true;
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = readPreviewBuildLock(paths.lockPath);
      if (
        current
        && isProcessAlive(current.pid)
        && linuxProcessStartTime(current.pid) === current.startedAt
      ) {
        throw new Error(
          `Another Linux Desktop preview command is already running as PID ${current.pid}.`,
        );
      }
      try {
        unlinkSync(paths.lockPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
  }
}

export function assertNoRunningPreview(paths: LinuxPreviewPaths): void {
  let markerStatus;
  try {
    markerStatus = lstatSync(paths.pidPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (markerStatus.isSymbolicLink() || !markerStatus.isFile()) {
    unlinkSync(paths.pidPath);
    return;
  }
  const pid = Number(readFileSync(paths.pidPath, "utf8").trim());
  if (
    Number.isSafeInteger(pid)
    && pid > 0
    && isProcessAlive(pid)
    && linuxProcessExecutable(pid) === resolve(paths.executable)
  ) {
    throw new Error(
      `Linux Desktop preview is still running as PID ${pid}. Exit it from the tray before rebuilding.`,
    );
  }
  unlinkSync(paths.pidPath);
}

function ensurePrivateDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const status = lstatSync(path);
  if (status.isSymbolicLink()) {
    throw new Error(`Linux Desktop preview state path must not be a symbolic link: ${path}`);
  }
  if (!status.isDirectory()) {
    throw new Error(`Linux Desktop preview state path is not a directory: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && status.uid !== uid) {
    throw new Error(`Linux Desktop preview state path is not owned by the current user: ${path}`);
  }
  chmodSync(path, 0o700);
}

function openPrivateAppendFile(path: string): number {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  fchmodSync(fd, 0o600);
  return fd;
}

function writePrivateExclusiveFile(path: string, contents: string): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, contents, "utf8");
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

function readPreviewBuildLock(path: string): {
  pid: number;
  startedAt: string;
  token: string;
} | undefined {
  let parsed: unknown;
  try {
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isFile()) return undefined;
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as { pid?: unknown; startedAt?: unknown; token?: unknown };
  if (
    !Number.isSafeInteger(record.pid)
    || (record.pid as number) <= 0
    || typeof record.startedAt !== "string"
    || !record.startedAt
    || typeof record.token !== "string"
    || !record.token
  ) {
    return undefined;
  }
  return record as { pid: number; startedAt: string; token: string };
}

function linuxProcessStartTime(pid: number): string | undefined {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = value.lastIndexOf(") ");
    if (commandEnd < 0) return undefined;
    return value.slice(commandEnd + 2).trim().split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

function linuxProcessExecutable(pid: number): string | undefined {
  try {
    return resolve(readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ""));
  } catch {
    return undefined;
  }
}

function stopDetachedProcess(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The child already exited.
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function linuxPreviewEnvironmentModule(): string {
  return `
import { join, win32 } from "node:path";

export function resolvePackagedSidecar(resourcesPath, platform) {
  if (platform === "win32") return win32.join(resourcesPath, "sidecar", "easyresearch.exe");
  return join(resourcesPath, "sidecar", "easyresearch");
}

export function resolveDesktopEnvironment(baseEnv) {
  return { ...baseEnv };
}

export function windowsTaskkillCommand(systemRoot, pid) {
  return {
    command: win32.join(systemRoot, "System32", "taskkill.exe"),
    args: ["/PID", String(pid), "/T", "/F"],
  };
}
`;
}

async function main(): Promise<void> {
  assertLinuxPreviewHost();
  const { launch } = parseLinuxPreviewArgs(process.argv.slice(2));
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const paths = linuxPreviewPaths(repoRoot);
  const version = repoPackageVersion();
  const lock = acquireLinuxPreviewBuildLock(paths);
  try {
    await buildLinuxDesktopPreview(repoRoot, paths, version);
    console.log(`[desktop-preview] built ${paths.executable}`);
    if (!launch) return;
    const pid = await launchLinuxDesktopPreview(paths);
    console.log(`[desktop-preview] launched PID ${pid}`);
    console.log(`[desktop-preview] isolated state: ${paths.stateDir}`);
    console.log(`[desktop-preview] host log: ${paths.logPath}`);
  } finally {
    lock.release();
  }
}

if (import.meta.main) await main();
