import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireLinuxPreviewBuildLock,
  assertLinuxPreviewHost,
  assertNoRunningPreview,
  createLinuxPreviewLaunchEnvironment,
  ensureLinuxPreviewStateDirectories,
  linuxPreviewBuilderConfig,
  linuxPreviewPaths,
  parseLinuxPreviewArgs,
} from "../../scripts/preview-desktop-linux";

const isLinuxX64 = process.platform === "linux" && process.arch === "x64";

describe("Linux desktop preview planning", () => {
  it("accepts only Linux x64 and the optional no-launch flag", () => {
    expect(() => assertLinuxPreviewHost("linux", "x64")).not.toThrow();
    expect(() => assertLinuxPreviewHost("darwin", "x64")).toThrow(/Linux x64/i);
    expect(() => assertLinuxPreviewHost("linux", "arm64")).toThrow(/Linux x64/i);

    expect(parseLinuxPreviewArgs([])).toEqual({ launch: true });
    expect(parseLinuxPreviewArgs(["--no-launch"])).toEqual({ launch: false });
    expect(() => parseLinuxPreviewArgs(["--publish"])).toThrow(/--no-launch/);
  });

  it("keeps runtime state outside the repository TypeScript workspace", () => {
    const paths = linuxPreviewPaths("/repo");
    expect(paths.stageDir).toBe(join("/repo", "release", "desktop-preview-stage-linux"));
    expect(paths.outputDir).toBe(join("/repo", "release", "desktop-preview-linux"));
    expect(paths.appDir).toBe(join(paths.outputDir, "linux-unpacked"));
    expect(paths.stateDir.startsWith(join(tmpdir(), "easyresearch-desktop-preview-")))
      .toBe(true);
    expect(paths.stateDir).not.toContain(join("/repo", "release"));
    expect(paths.homeDir).toBe(join(paths.stateDir, "home"));
    expect(paths.configDir).toBe(join(paths.stateDir, "config"));
    expect(paths.cacheDir).toBe(join(paths.stateDir, "cache"));
    expect(paths.agentDir).toBe(join(paths.stateDir, "agent"));
    expect(paths.projectDir).toBe(join(paths.stateDir, "project"));
    expect(paths.logPath).toBe(join(paths.stateDir, "host.log"));
    expect(paths.pidPath).toBe(join(paths.stateDir, "preview.pid"));
    expect(paths.lockPath).toBe(join(paths.stateDir, "build.lock"));
  });

  it.runIf(isLinuxX64)("creates private state directories and rejects a symlinked state root", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "easyresearch-preview-repo-"));
    const paths = linuxPreviewPaths(repoRoot);
    try {
      ensureLinuxPreviewStateDirectories(paths);
      for (const path of [
        paths.stateDir,
        paths.homeDir,
        paths.configDir,
        paths.cacheDir,
        paths.agentDir,
        paths.projectDir,
      ]) {
        const status = lstatSync(path);
        expect(status.isDirectory()).toBe(true);
        expect(status.isSymbolicLink()).toBe(false);
        expect(status.mode & 0o777).toBe(0o700);
      }

      rmSync(paths.stateDir, { recursive: true, force: true });
      const redirect = mkdtempSync(join(tmpdir(), "easyresearch-preview-redirect-"));
      symlinkSync(redirect, paths.stateDir, "dir");
      expect(() => ensureLinuxPreviewStateDirectories(paths)).toThrow(/symbolic link/i);
      rmSync(paths.stateDir, { force: true });
      rmSync(redirect, { recursive: true, force: true });
    } finally {
      rmSync(paths.stateDir, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it.runIf(isLinuxX64)("serializes preview build and launch work with a workspace lock", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "easyresearch-preview-repo-"));
    const paths = linuxPreviewPaths(repoRoot);
    try {
      ensureLinuxPreviewStateDirectories(paths);
      const lock = acquireLinuxPreviewBuildLock(paths);
      expect(() => acquireLinuxPreviewBuildLock(paths)).toThrow(/already running/i);
      expect(lock.release()).toBe(true);
      expect(existsSync(paths.lockPath)).toBe(false);
      expect(acquireLinuxPreviewBuildLock(paths).release()).toBe(true);
    } finally {
      rmSync(paths.stateDir, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it.runIf(isLinuxX64)("does not treat an unrelated live PID as an active preview", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "easyresearch-preview-repo-"));
    const paths = linuxPreviewPaths(repoRoot);
    try {
      ensureLinuxPreviewStateDirectories(paths);
      mkdirSync(dirname(paths.executable), { recursive: true });
      writeFileSync(paths.pidPath, `${process.pid}\n`);
      expect(() => assertNoRunningPreview(paths)).not.toThrow();
      expect(existsSync(paths.pidPath)).toBe(false);

      const redirect = mkdtempSync(join(tmpdir(), "easyresearch-preview-pid-redirect-"));
      symlinkSync(redirect, paths.pidPath, "dir");
      expect(() => assertNoRunningPreview(paths)).not.toThrow();
      expect(existsSync(paths.pidPath)).toBe(false);
      expect(existsSync(redirect)).toBe(true);
      rmSync(redirect, { recursive: true, force: true });
    } finally {
      rmSync(paths.stateDir, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("builds an unpacked non-publishing Linux package", () => {
    expect(linuxPreviewBuilderConfig("/stage", "/output", "1.2.3")).toMatchObject({
      appId: "ai.easyresearch.desktop.preview",
      productName: "EasyResearch Preview",
      electronVersion: "42.3.3",
      files: ["main.cjs", "preload.cjs", "package.json"],
      extraResources: [{ from: "sidecar", to: "sidecar" }],
      directories: { app: "/stage", output: "/output" },
      publish: null,
      linux: {
        executableName: "easyresearch-preview",
        target: [{ target: "dir", arch: ["x64"] }],
      },
    });
  });

  it("redirects preview state without dropping the graphical session", () => {
    const paths = linuxPreviewPaths("/repo");
    const env = createLinuxPreviewLaunchEnvironment({
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-1",
      HOME: "/real-home",
      EASYRESEARCH_BUNDLED_ROOT: "/external/bundle",
      EASYRESEARCH_DESKTOP_SMOKE_DIR: "/external/smoke",
      EASYRESEARCH_DESKTOP_SMOKE_PROJECT: "/external/project",
      EASYRESEARCH_DESKTOP_SMOKE_SESSION_PATH: "/external/session.jsonl",
      EASYRESEARCH_DESKTOP_SMOKE_AGENT: "search",
      EASYRESEARCH_SMOKE_SETUP_RESULT_PATH: "/external/setup.json",
      EASYRESEARCH_SMOKE_SETUP_RUN_ID: "external-run",
      EASYRESEARCH_VENV: "/external/venv",
    }, paths);
    expect(env).toMatchObject({
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-1",
      HOME: paths.homeDir,
      XDG_CONFIG_HOME: paths.configDir,
      XDG_CACHE_HOME: paths.cacheDir,
      EASYRESEARCH_CODING_AGENT_DIR: paths.agentDir,
    });
    expect(env).not.toHaveProperty("EASYRESEARCH_BUNDLED_ROOT");
    expect(env).not.toHaveProperty("EASYRESEARCH_DESKTOP_SMOKE_DIR");
    expect(env).not.toHaveProperty("EASYRESEARCH_DESKTOP_SMOKE_PROJECT");
    expect(env).not.toHaveProperty("EASYRESEARCH_DESKTOP_SMOKE_SESSION_PATH");
    expect(env).not.toHaveProperty("EASYRESEARCH_DESKTOP_SMOKE_AGENT");
    expect(env).not.toHaveProperty("EASYRESEARCH_SMOKE_SETUP_RESULT_PATH");
    expect(env).not.toHaveProperty("EASYRESEARCH_SMOKE_SETUP_RUN_ID");
    expect(env).not.toHaveProperty("EASYRESEARCH_VENV");
  });
});
