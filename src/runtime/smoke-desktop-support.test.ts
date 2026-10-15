import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BuildArtifact } from "../../scripts/build";
import type { DesktopBuildManifest } from "../../scripts/build-desktop";
import {
  appImageExtractCommand,
  combineDesktopSmokeFailures,
  appendBoundedDiagnosticText,
  assertPackagedDesktopRunning,
  createDesktopSmokeDiagnosticReport,
  createDesktopSmokeEnvironment,
  debExtractCommand,
  dmgAttachCommand,
  dmgDetachCommand,
  nsisInstallCommand,
  packagedApplicationPaths,
  pollDesktopSmokeEvents,
  readyPersistedSessionPath,
  readDesktopSmokeEvents,
  removePreservedDesktopSmokeRecord,
  removeDesktopSmokeRoot,
  reduceDesktopSmokeEvents,
  restoreDesktopSmokeExecutable,
  runDesktopPackageSmokes,
  verifyDesktopSmokePackages,
  verifyDesktopSidecarIdentity,
  verifyDesktopOwnershipSuccessor,
  verifyPackagedNotice,
  verifyPackagedSidecar,
} from "../../scripts/smoke-desktop-support";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-desktop-smoke-support-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function artifact(bytes: string): BuildArtifact {
  return {
    version: "1.2.3",
    target: "windows-x64",
    binaryName: "easyresearch.exe",
    size: Buffer.byteLength(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    builtAt: "2026-08-23T00:00:00.000Z",
  };
}

describe("packaged sidecar identity", () => {
  it("accepts only byte-identical native sidecar content", () => {
    const path = join(root, "easyresearch.exe");
    writeFileSync(path, "same-bytes");
    expect(() => verifyPackagedSidecar(path, artifact("same-bytes"), "1.2.3"))
      .not.toThrow();
    writeFileSync(path, "different-bytes");
    expect(() => verifyPackagedSidecar(path, artifact("same-bytes"), "1.2.3"))
      .toThrow(/packaged sidecar (size|SHA-256)/i);
  });

  it("requires the desktop and native manifests to identify the same sidecar", () => {
    const native = artifact("same-bytes");
    expect(() => verifyDesktopSidecarIdentity({ ...native }, native)).not.toThrow();
    expect(() => verifyDesktopSidecarIdentity({ ...native, binaryName: "other.exe" }, native))
      .toThrow(/desktop manifest sidecar/i);
  });
});

describe("packaged third-party notices", () => {
  it("accepts byte-identical accepted notice content", () => {
    const accepted = join(root, "accepted.txt");
    const packaged = join(root, "packaged.txt");
    writeFileSync(accepted, "accepted notices\n");
    writeFileSync(packaged, "accepted notices\n");

    expect(() => verifyPackagedNotice(packaged, accepted)).not.toThrow();
  });

  it("rejects a missing packaged notice", () => {
    const accepted = join(root, "accepted.txt");
    writeFileSync(accepted, "accepted notices\n");

    expect(() => verifyPackagedNotice(join(root, "missing.txt"), accepted))
      .toThrow(/ENOENT|no such file/i);
  });

  it("rejects tampered packaged notice bytes", () => {
    const accepted = join(root, "accepted.txt");
    const packaged = join(root, "packaged.txt");
    writeFileSync(accepted, "accepted notices\n");
    writeFileSync(packaged, "tampered notices\n");

    expect(() => verifyPackagedNotice(packaged, accepted)).toThrow(/do not match/i);
  });
});

describe("desktop smoke cleanup failures", () => {
  it("preserves the primary failure and every cleanup failure", () => {
    const primary = new Error("primary smoke failure");
    const result = combineDesktopSmokeFailures(primary, [
      new Error("process cleanup failed"),
      new Error("package cleanup failed"),
    ]);

    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([
      primary,
      expect.objectContaining({ message: "process cleanup failed" }),
      expect.objectContaining({ message: "package cleanup failed" }),
    ]);
    expect(combineDesktopSmokeFailures(undefined, [])).toBeUndefined();
  });

  it("retries transient Windows directory locks before removing diagnostics", async () => {
    let attempts = 0;
    const waits: number[] = [];
    await removeDesktopSmokeRoot("C:\\Temp\\desktop-smoke", {
      remove: () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("locked"), { code: "EBUSY" });
      },
      wait: async (delayMs) => { waits.push(delayMs); },
    });

    expect(attempts).toBe(3);
    expect(waits).toEqual([250, 250]);
  });

  it("stops retrying a persistent directory lock after the bounded deadline", async () => {
    const locked = Object.assign(new Error("still locked"), { code: "EBUSY" });
    let attempts = 0;
    let waits = 0;
    const removal = removeDesktopSmokeRoot("C:\\Temp\\desktop-smoke", {
      remove: () => {
        attempts += 1;
        throw locked;
      },
      wait: async () => { waits += 1; },
    });

    await expect(removal).rejects.toBe(locked);
    expect(attempts).toBe(20);
    expect(waits).toBe(19);
  });

  it("does not retry an unrelated cleanup error", async () => {
    const unrelated = Object.assign(new Error("invalid path"), { code: "EINVAL" });
    let attempts = 0;
    const removal = removeDesktopSmokeRoot("C:\\Temp\\desktop-smoke", {
      remove: () => {
        attempts += 1;
        throw unrelated;
      },
      wait: async () => { throw new Error("unexpected wait"); },
    });

    await expect(removal).rejects.toBe(unrelated);
    expect(attempts).toBe(1);
  });

  it("removes only the exact lease-free ownership fixture after preservation is proven", () => {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    const recordPath = join(agentDir, "server.pid");
    writeFileSync(recordPath, JSON.stringify({
      schema: 1,
      owner: "desktop",
      pid: 4242,
      host: "127.0.0.1",
      port: 43123,
      token: "preserved-fixture-token",
      runtimeId: "desktop:0.0.81:accepted",
    }));

    expect(() => removePreservedDesktopSmokeRecord(agentDir, "wrong-token"))
      .toThrow(/ownership fixture/i);
    expect(existsSync(recordPath)).toBe(true);

    removePreservedDesktopSmokeRecord(agentDir, "preserved-fixture-token");
    expect(existsSync(recordPath)).toBe(false);
  });

  it("does not remove a preserved ownership fixture while any runtime lease remains", () => {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "server.pid"), JSON.stringify({
      schema: 1,
      owner: "desktop",
      pid: 4242,
      host: "127.0.0.1",
      port: 43123,
      token: "preserved-fixture-token",
      runtimeId: "desktop:0.0.81:accepted",
    }));
    mkdirSync(join(agentDir, "server.transition.lease"));

    expect(() => removePreservedDesktopSmokeRecord(agentDir, "preserved-fixture-token"))
      .toThrow(/runtime lease/i);
    expect(existsSync(join(agentDir, "server.pid"))).toBe(true);
  });
});

describe("desktop smoke failure diagnostics", () => {
  it("fails immediately when the packaged host exits before an expected milestone", () => {
    expect(() => assertPackagedDesktopRunning("active Agent", {
      pid: 5151,
      exited: true,
      exitCode: 7,
    }, [
      { type: "desktop-smoke.sidecar-ready" },
      { type: "desktop-smoke.window-loaded" },
    ])).toThrow(/active Agent.*pid 5151.*code 7.*2 events.*window-loaded/is);

    expect(() => assertPackagedDesktopRunning("active Agent", {
      pid: 5151,
      exited: false,
    }, [])).not.toThrow();
  });

  it("keeps only the bounded tail of incrementally captured output", () => {
    expect(appendBoundedDiagnosticText("12345", "67890", 7)).toBe("4567890");
    expect(appendBoundedDiagnosticText("", "short", 7)).toBe("short");
  });

  it("distinguishes retryable absent and partial events from invalid complete JSON", () => {
    const path = join(root, "events.jsonl");
    expect(pollDesktopSmokeEvents(path)).toEqual({ status: "missing", events: [] });

    writeFileSync(path, '{"type":"desktop-smoke.sidecar-ready"');
    expect(pollDesktopSmokeEvents(path)).toEqual({ status: "partial", events: [] });

    writeFileSync(path, "not-json\n");
    expect(() => pollDesktopSmokeEvents(path)).toThrow(/event JSON/i);
  });

  it("reports ownership and lease evidence without exposing tokens or unbounded logs", () => {
    const agentDir = join(root, "agent");
    const desktopLogPath = join(root, "desktop.log");
    const serverLogPath = join(root, "server.log");
    const eventsPath = join(root, "events.jsonl");
    const serverToken = "server-secret-token";
    const transitionToken = "transition-secret-token";
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "server.pid"), JSON.stringify({
      schema: 1,
      owner: "desktop",
      pid: 6262,
      host: "127.0.0.1",
      port: 43123,
      token: serverToken,
      runtimeId: "desktop:0.0.81:accepted",
    }));
    for (const [name, kind, token, pid] of [
      ["server.lease", "server", serverToken, 6262],
      ["server.transition.lease", "transition", transitionToken, 7373],
    ] as const) {
      const directory = join(agentDir, name);
      mkdirSync(directory);
      writeFileSync(join(directory, "owner-redacted.json"), JSON.stringify({
        schema: 1,
        kind,
        owner: "desktop",
        pid,
        token,
      }));
    }
    writeFileSync(desktopLogPath, `prefix ${"x".repeat(100)} token=${transitionToken}\n`);
    writeFileSync(serverLogPath, `server {"token":"${serverToken}"}\n`);
    writeFileSync(eventsPath, '{"type":"desktop-smoke.sidecar-ready"}\n');

    const report = createDesktopSmokeDiagnosticReport({
      target: "windows-x64",
      phase: "active Agent",
      process: { pid: 5151, exited: false },
      eventsPath,
      desktopLogPath,
      serverLogPath,
      agentDir,
      stdout: `stdout token=${serverToken}`,
      stderr: "stderr-safe",
      modelRequestActive: false,
      modelRequestAborted: false,
      maxTextCharacters: 80,
      isAlive: (pid) => pid === 5151 || pid === 6262 || pid === 7373,
    });

    expect(report).toContain('"tokenPresent": true');
    expect(report).toContain('"serverRecordTokenMatches": true');
    expect(report).toContain('"kind": "transition"');
    expect(report).toContain("[REDACTED]");
    expect(report).not.toContain(serverToken);
    expect(report).not.toContain(transitionToken);
    expect(report.length).toBeLessThan(4_000);
  });
});

describe("native package commands and paths", () => {
  it("extracts AppImage in a dedicated working directory without sandbox launch switches", () => {
    expect(appImageExtractCommand("/packages/EasyResearch.AppImage", "/fixture/appimage")).toEqual({
      command: "/packages/EasyResearch.AppImage",
      args: ["--appimage-extract"],
      cwd: "/fixture/appimage",
    });
  });

  it("extracts a deb without installing into the host filesystem", () => {
    expect(debExtractCommand("/packages/EasyResearch.deb", "/fixture/deb")).toEqual({
      command: "dpkg-deb",
      args: ["-x", "/packages/EasyResearch.deb", "/fixture/deb"],
    });
  });

  it("runs the extracted AppRun and resolves resources inside that same AppImage", () => {
    expect(packagedApplicationPaths("linux-arm64", "/fixture/squashfs-root", "AppImage")).toEqual({
      executable: "/fixture/squashfs-root/AppRun",
      sidecar: "/fixture/squashfs-root/resources/sidecar/easyresearch",
      notices: "/fixture/squashfs-root/resources/sidecar/THIRD_PARTY_NOTICES.txt",
    });
  });

  it("runs the extracted deb Electron binary and resolves its own sidecar", () => {
    expect(packagedApplicationPaths("linux-arm64", "/fixture/deb", "deb")).toEqual({
      executable: "/fixture/deb/opt/EasyResearch/easyresearch-desktop",
      sidecar: "/fixture/deb/opt/EasyResearch/resources/sidecar/easyresearch",
      notices: "/fixture/deb/opt/EasyResearch/resources/sidecar/THIRD_PARTY_NOTICES.txt",
    });
  });

  it("requires an explicit matching Linux format instead of falling back to a macOS layout", () => {
    expect(() => packagedApplicationPaths("linux-arm64", root)).toThrow(/format/i);
    expect(() => packagedApplicationPaths("linux-arm64", root, "dmg")).toThrow(/format/i);
    expect(() => packagedApplicationPaths("windows-x64", root, "deb")).toThrow(/format/i);
  });

  it.skipIf(process.platform === "win32")("restores only the selected downloaded executable's mode", () => {
    const downloaded = join(root, "downloaded.AppImage");
    const sandbox = join(root, "chrome-sandbox");
    const notices = join(root, "THIRD_PARTY_NOTICES.txt");
    for (const path of [downloaded, sandbox, notices]) {
      writeFileSync(path, "fixture");
      chmodSync(path, 0o640);
    }
    restoreDesktopSmokeExecutable(downloaded);

    expect(statSync(downloaded).mode & 0o7777).toBe(0o740);
    expect(statSync(sandbox).mode & 0o7777).toBe(0o640);
    expect(statSync(notices).mode & 0o7777).toBe(0o640);
  });

  it("builds a silent per-user NSIS installation command", () => {
    expect(nsisInstallCommand("C:\\artifacts\\EasyResearch.exe", "C:\\Users\\test\\EasyResearch"))
      .toEqual({
        command: "C:\\artifacts\\EasyResearch.exe",
        args: ["/S", "/D=C:\\Users\\test\\EasyResearch"],
      });
  });

  it("builds readonly DMG attach and forced detach commands", () => {
    expect(dmgAttachCommand("/tmp/EasyResearch.dmg", "/tmp/mount")).toEqual({
      command: "/usr/bin/hdiutil",
      args: ["attach", "/tmp/EasyResearch.dmg", "-nobrowse", "-readonly", "-mountpoint", "/tmp/mount"],
    });
    expect(dmgDetachCommand("/tmp/mount")).toEqual({
      command: "/usr/bin/hdiutil",
      args: ["detach", "/tmp/mount", "-force"],
    });
  });

  it("resolves installed Windows and mounted macOS app resources", () => {
    expect(packagedApplicationPaths("windows-x64", "C:\\install")).toEqual({
      executable: "C:\\install\\EasyResearch.exe",
      sidecar: "C:\\install\\resources\\sidecar\\easyresearch.exe",
      notices: "C:\\install\\resources\\sidecar\\THIRD_PARTY_NOTICES.txt",
      uninstaller: "C:\\install\\Uninstall EasyResearch.exe",
    });
    expect(packagedApplicationPaths("darwin-arm64", "/Volumes/EasyResearch")).toEqual({
      executable: "/Volumes/EasyResearch/EasyResearch.app/Contents/MacOS/EasyResearch",
      sidecar: "/Volumes/EasyResearch/EasyResearch.app/Contents/Resources/sidecar/easyresearch",
      notices: "/Volumes/EasyResearch/EasyResearch.app/Contents/Resources/sidecar/THIRD_PARTY_NOTICES.txt",
    });
  });
});

describe("desktop package collection acceptance", () => {
  function linuxManifest(): DesktopBuildManifest {
    const packages = (["AppImage", "deb"] as const).map((format) => {
      const fileName = `EasyResearch-1.2.3-linux-arm64.${format}`;
      const bytes = `package-${format}`;
      writeFileSync(join(root, fileName), bytes);
      return {
        format,
        fileName,
        size: Buffer.byteLength(bytes),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
    return {
      version: "1.2.3",
      target: "linux-arm64",
      electronVersion: "42.3.3",
      sidecar: { ...artifact("native"), target: "linux-arm64", binaryName: "easyresearch" },
      packages,
      builtAt: "2026-10-15T00:00:00.000Z",
    };
  }

  it("validates both required Linux packages before returning their artifact paths", () => {
    const manifest = linuxManifest();
    expect(verifyDesktopSmokePackages(manifest, "linux-arm64", "1.2.3", root)).toEqual(
      manifest.packages.map((pkg) => ({ ...pkg, path: join(root, pkg.fileName) })),
    );
  });

  it.each(["missing", "duplicate", "wrong-format"])("rejects a %s required package", (scenario) => {
    const manifest = linuxManifest();
    if (scenario === "missing") manifest.packages.pop();
    if (scenario === "duplicate") manifest.packages[1] = { ...manifest.packages[0]! };
    if (scenario === "wrong-format") manifest.packages[1]!.format = "dmg";
    expect(() => verifyDesktopSmokePackages(manifest, "linux-arm64", "1.2.3", root))
      .toThrow(/required.*format|package.*format/i);
  });

  it.each(["../other.deb", "EasyResearch-0.0.1-linux-arm64.deb", "EasyResearch-1.2.3-linux-x64.deb"])(
    "rejects a noncanonical package name %s",
    (fileName) => {
      const manifest = linuxManifest();
      manifest.packages[1]!.fileName = fileName;
      expect(() => verifyDesktopSmokePackages(manifest, "linux-arm64", "1.2.3", root))
        .toThrow(/package name/i);
    },
  );

  it.each(["AppImage", "deb"] as const)("rejects tampered %s even when its sibling is accepted", (format) => {
    const manifest = linuxManifest();
    const pkg = manifest.packages.find((candidate) => candidate.format === format)!;
    writeFileSync(join(root, pkg.fileName), "x".repeat(pkg.size));
    expect(() => verifyDesktopSmokePackages(manifest, "linux-arm64", "1.2.3", root))
      .toThrow(/SHA-256/i);
  });

  it("rejects incorrect recorded sizes, missing files and stale manifest identity", () => {
    const manifest = linuxManifest();
    manifest.packages[1]!.size += 1;
    expect(() => verifyDesktopSmokePackages(manifest, "linux-arm64", "1.2.3", root)).toThrow(/size/i);
    manifest.packages[1]!.size -= 1;
    rmSync(join(root, manifest.packages[1]!.fileName));
    expect(() => verifyDesktopSmokePackages(manifest, "linux-arm64", "1.2.3", root)).toThrow(/missing/i);
    expect(() => verifyDesktopSmokePackages(manifest, "linux-arm64", "9.9.9", root)).toThrow(/manifest/i);
    expect(() => verifyDesktopSmokePackages(manifest, "darwin-arm64", "1.2.3", root)).toThrow(/manifest/i);
  });

  it("runs every package with fresh state and removes only successful fixtures", async () => {
    const packages = verifyDesktopSmokePackages(linuxManifest(), "linux-arm64", "1.2.3", root);
    const fixtures: string[] = [];
    const formats: string[] = [];
    await runDesktopPackageSmokes(packages, async (pkg, fixtureRoot) => {
      fixtures.push(fixtureRoot);
      formats.push(pkg.format);
      const env = createDesktopSmokeEnvironment(fixtureRoot, {});
      expect(existsSync(env.EASYRESEARCH_CODING_AGENT_DIR!)).toBe(false);
      mkdirSync(env.EASYRESEARCH_CODING_AGENT_DIR!, { recursive: true });
      writeFileSync(join(env.EASYRESEARCH_CODING_AGENT_DIR!, "state"), pkg.format);
    }, root);

    expect(formats).toEqual(["AppImage", "deb"]);
    expect(new Set(fixtures).size).toBe(2);
    expect(fixtures.every((path) => !existsSync(path))).toBe(true);
  });

  it("does not let one failed format hide the other format's smoke or its own diagnostics", async () => {
    const packages = verifyDesktopSmokePackages(linuxManifest(), "linux-arm64", "1.2.3", root);
    const fixtures: string[] = [];
    const formats: string[] = [];
    await expect(runDesktopPackageSmokes(packages, async (pkg, fixtureRoot) => {
      fixtures.push(fixtureRoot);
      formats.push(pkg.format);
      if (pkg.format === "AppImage") throw new Error("AppRun did not start");
    }, root)).rejects.toThrow(/AppImage/);

    expect(formats).toEqual(["AppImage", "deb"]);
    expect(existsSync(fixtures[0]!)).toBe(true);
    expect(existsSync(fixtures[1]!)).toBe(false);
  });
});

describe("desktop smoke environment", () => {
  it("isolates package state and removes inherited setup overrides while preserving the graphical session", () => {
    const inherited = {
      HOME: "/real/home",
      XDG_CONFIG_HOME: "/real/config",
      XDG_CACHE_HOME: "/real/cache",
      EASYRESEARCH_SKIP_SETUP: "1",
      EASYRESEARCH_BUNDLED_ROOT: "/other/bundled",
      EASYRESEARCH_VENV: "/other/venv",
      EASYRESEARCH_CODING_AGENT_DIR: "/other/agent",
      EASYRESEARCH_DESKTOP_SMOKE_DIR: "/other/control",
      EASYRESEARCH_DESKTOP_SMOKE_USER_DATA: "/other/electron",
      EASYRESEARCH_DESKTOP_SMOKE_SESSION_PATH: "/other/session.jsonl",
      EASYRESEARCH_SMOKE_SETUP_RESULT_PATH: "/other/evidence",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_SANDBOX: "1",
      CHROME_DEVEL_SANDBOX: "/other/sandbox",
      NODE_OPTIONS: "--require /other/hook.cjs",
      PYTHONHOME: "/other/python",
      PYTHONPATH: "/other/modules",
      VIRTUAL_ENV: "/other/venv",
      APPDIR: "/other/appimage",
      APPIMAGE: "/other/image",
      DISPLAY: ":88",
      XAUTHORITY: "/display/auth",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      XDG_RUNTIME_DIR: "/run/user/1000",
      PATH: "/tools:/usr/bin",
    };
    const env = createDesktopSmokeEnvironment(root, inherited);
    for (const key of [
      "EASYRESEARCH_SKIP_SETUP", "EASYRESEARCH_BUNDLED_ROOT", "EASYRESEARCH_VENV",
      "EASYRESEARCH_DESKTOP_SMOKE_DIR", "EASYRESEARCH_DESKTOP_SMOKE_SESSION_PATH",
      "EASYRESEARCH_SMOKE_SETUP_RESULT_PATH", "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_SANDBOX",
      "CHROME_DEVEL_SANDBOX", "NODE_OPTIONS", "PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "APPDIR", "APPIMAGE",
    ]) expect(env).not.toHaveProperty(key);
    expect(env).toMatchObject({
      HOME: join(root, "home"),
      USERPROFILE: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_CACHE_HOME: join(root, "xdg-cache"),
      XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_STATE_HOME: join(root, "xdg-state"),
      EASYRESEARCH_CODING_AGENT_DIR: join(root, "agent"),
      EASYRESEARCH_DESKTOP_SMOKE_USER_DATA: join(root, "electron-user-data"),
      DISPLAY: inherited.DISPLAY,
      XAUTHORITY: inherited.XAUTHORITY,
      DBUS_SESSION_BUS_ADDRESS: inherited.DBUS_SESSION_BUS_ADDRESS,
      XDG_RUNTIME_DIR: inherited.XDG_RUNTIME_DIR,
      PATH: inherited.PATH,
    });
    expect(inherited.HOME).toBe("/real/home");
    expect(inherited.EASYRESEARCH_SKIP_SETUP).toBe("1");
  });
});

describe("Linux packaged renderer sandbox evidence", () => {
  const ready = {
    type: "desktop-smoke.sidecar-ready",
    origin: "http://127.0.0.1:43123",
    bootId: "boot-old",
    sidecarPid: 41,
  };
  const security = {
    type: "desktop-smoke.renderer-security",
    osSandboxed: true,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  };
  const active = [
    { type: "desktop-smoke.window-loaded" },
    { type: "desktop-smoke.state-visible" },
    { type: "desktop-smoke.agent-running" },
  ];

  it("requires actual OS sandbox evidence before accepting a running Linux renderer", () => {
    expect(reduceDesktopSmokeEvents([ready, security, ...active], { target: "linux-arm64" }))
      .toMatchObject({ rendererSecurityVerified: true, agentRunning: true });
    expect(() => reduceDesktopSmokeEvents([ready, ...active], { target: "linux-arm64" }))
      .toThrow(/renderer security evidence/i);
  });

  it.each([
    { osSandboxed: false },
    { osSandboxed: undefined },
    { sandbox: false },
    { contextIsolation: false },
    { nodeIntegration: true },
  ])("rejects insecure or incomplete renderer evidence %j", (overrides) => {
    expect(() => reduceDesktopSmokeEvents([ready, { ...security, ...overrides }, ...active], {
      target: "linux-arm64",
    })).toThrow(/renderer security evidence/i);
  });

  it("requires fresh sandbox evidence for the successor renderer", () => {
    const hash = "#/work/active-session?cwd=%2Fpaper";
    const restarted = [
      ready,
      security,
      ...active,
      { type: "desktop-smoke.restart-api-accepted", bootId: "boot-old", hash },
      { type: "desktop-smoke.restart-requested", bootId: "boot-old" },
      { type: "desktop-smoke.old-sidecar-exited", bootId: "boot-old", clean: true },
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43124",
        bootId: "boot-new",
        sidecarPid: 42,
        rendererCredentialFresh: true,
      },
    ];
    const visible = {
      type: "desktop-smoke.successor-visible",
      bootId: "boot-new",
      hash,
      authenticated: true,
      persistedSessionVisible: true,
    };
    expect(() => reduceDesktopSmokeEvents([...restarted, visible], { target: "linux-arm64" }))
      .toThrow(/renderer security evidence/i);
    expect(reduceDesktopSmokeEvents([...restarted, security, visible], { target: "linux-arm64" }))
      .toMatchObject({ rendererSecurityVerified: true, successorVisible: true });
  });
});

describe("desktop smoke milestones", () => {
  const persistedHistorySentinels = {
    user: "desktop smoke persisted history",
    assistant: "desktop smoke persisted response",
  };
  const persistedSession = {
    sessionFile: "/sessions/persisted.jsonl",
    status: "ready",
    isStreaming: false,
  };
  const message = (role: string, content: unknown) => ({
    kind: "message",
    entryId: `${role}-entry`,
    message: { role, content },
  });

  it("rejects a successor that reuses the old lifecycle credential", () => {
    const initial = {
      schema: 1,
      owner: "desktop",
      host: "127.0.0.1",
      pid: 41,
      port: 43123,
      token: "lifecycle-old",
      runtimeId: "desktop:1.2.3:accepted",
    };
    expect(() => verifyDesktopOwnershipSuccessor(
      initial,
      { ...initial, pid: 42 },
      "http://127.0.0.1:43123",
      "http://127.0.0.1:43123",
    )).toThrow(/fresh lifecycle credential/i);
  });

  it("rejects a successor ownership record from a different packaged runtime", () => {
    expect(() => verifyDesktopOwnershipSuccessor(
      {
        schema: 1,
        owner: "desktop",
        pid: 41,
        port: 43123,
        token: "lifecycle-old",
        runtimeId: "desktop:1.2.3:accepted",
      },
      {
        schema: 1,
        owner: "desktop",
        pid: 42,
        port: 43123,
        token: "lifecycle-new",
        runtimeId: "desktop:1.2.3:other",
      },
      "http://127.0.0.1:43123",
      "http://127.0.0.1:43123",
    )).toThrow(/same accepted packaged runtime/i);
  });

  it("binds both desktop ownership records to their reported loopback origins", () => {
    const initial = {
      schema: 1,
      owner: "desktop",
      host: "127.0.0.1",
      pid: 41,
      port: 43123,
      token: "lifecycle-old",
      runtimeId: "desktop:1.2.3:accepted",
    };
    expect(() => verifyDesktopOwnershipSuccessor(
      initial,
      { ...initial, pid: 42, token: "lifecycle-new" },
      "http://127.0.0.1:43123",
      "http://127.0.0.1:43124",
    )).toThrow(/ownership.*origin/i);
  });

  it("rejects a non-loopback host in a successor ownership record", () => {
    const initial = {
      schema: 1,
      owner: "desktop",
      host: "127.0.0.1",
      pid: 41,
      port: 43123,
      token: "lifecycle-old",
      runtimeId: "desktop:1.2.3:accepted",
    };
    expect(() => verifyDesktopOwnershipSuccessor(
      initial,
      { ...initial, host: "0.0.0.0", pid: 42, port: 43124, token: "lifecycle-new" },
      "http://127.0.0.1:43123",
      "http://127.0.0.1:43124",
    )).toThrow(/ownership.*origin/i);
  });

  it("accepts OS reuse of the ephemeral port when lifecycle identity is fresh", () => {
    const initial = {
      schema: 1,
      owner: "desktop",
      host: "127.0.0.1",
      pid: 41,
      port: 43123,
      token: "lifecycle-old",
      runtimeId: "desktop:1.2.3:accepted",
    };
    expect(() => verifyDesktopOwnershipSuccessor(
      initial,
      { ...initial, pid: 42, token: "lifecycle-new" },
      "http://127.0.0.1:43123",
      "http://127.0.0.1:43123",
    )).not.toThrow();
  });

  it("accepts an ordered sentinel pair in realistic Pi message content shapes", () => {
    expect(readyPersistedSessionPath({
      session: persistedSession,
      timeline: [
        message("user", persistedHistorySentinels.user),
        message("custom", "unrelated visible timeline note"),
        message("assistant", [{ type: "text", text: persistedHistorySentinels.assistant }]),
      ],
    }, persistedHistorySentinels)).toBe("/sessions/persisted.jsonl");

    expect(readyPersistedSessionPath({
      session: persistedSession,
      timeline: [
        message("user", [{ type: "text", text: persistedHistorySentinels.user }]),
        message("assistant", [{ type: "text", text: persistedHistorySentinels.assistant }]),
      ],
    }, persistedHistorySentinels)).toBe("/sessions/persisted.jsonl");
  });

  it("rejects legacy or summary-only evidence for persisted history", () => {
    expect(readyPersistedSessionPath({
      session: persistedSession,
      messages: [
        { role: "user", content: persistedHistorySentinels.user },
        { role: "assistant", content: persistedHistorySentinels.assistant },
      ],
    }, persistedHistorySentinels)).toBeUndefined();
    expect(readyPersistedSessionPath({
      session: persistedSession,
      timeline: [
        message("user", persistedHistorySentinels.user),
        message("assistant", [{ type: "text", text: persistedHistorySentinels.assistant }]),
      ],
      messages: [],
    }, persistedHistorySentinels)).toBeUndefined();
    expect(readyPersistedSessionPath({
      session: persistedSession,
      timeline: [
        { kind: "compaction", entryId: "compact", summary: persistedHistorySentinels.user },
        { kind: "branch-summary", entryId: "summary", summary: persistedHistorySentinels.assistant },
      ],
    }, persistedHistorySentinels)).toBeUndefined();
    expect(readyPersistedSessionPath({
      session: persistedSession,
      timeline: [
        message("user", persistedHistorySentinels.user),
        { kind: "branch-summary", entryId: "summary", summary: persistedHistorySentinels.assistant },
      ],
    }, persistedHistorySentinels)).toBeUndefined();
  });

  it("rejects malformed, mismatched, or out-of-order persisted messages", () => {
    const snapshots = [
      {
        session: persistedSession,
        timeline: [
          message("user", persistedHistorySentinels.user),
          message("assistant", [{ type: "text", text: persistedHistorySentinels.assistant }]),
          { kind: "message", entryId: "malformed-after", message: null },
        ],
      },
      {
        session: persistedSession,
        timeline: [
          { kind: "message", entryId: "malformed", message: null },
          message("user", persistedHistorySentinels.user),
          message("assistant", [{ type: "text", text: persistedHistorySentinels.assistant }]),
        ],
      },
      {
        session: persistedSession,
        timeline: [
          message("assistant", [{ type: "text", text: persistedHistorySentinels.assistant }]),
          message("user", persistedHistorySentinels.user),
        ],
      },
      {
        session: persistedSession,
        timeline: [
          message("assistant", [{ type: "text", text: persistedHistorySentinels.user }]),
          message("user", persistedHistorySentinels.assistant),
        ],
      },
      {
        session: persistedSession,
        timeline: [
          message("user", "wrong user text"),
          message("assistant", [{ type: "text", text: persistedHistorySentinels.assistant }]),
        ],
      },
      {
        session: persistedSession,
        timeline: [
          message("user", persistedHistorySentinels.user),
          message("assistant", [{ type: "text", text: "wrong assistant text" }]),
        ],
      },
    ];

    for (const snapshot of snapshots) {
      expect(readyPersistedSessionPath(snapshot, persistedHistorySentinels)).toBeUndefined();
    }
    expect(readyPersistedSessionPath({
      session: { ...persistedSession, status: "running" },
      timeline: [
        message("user", persistedHistorySentinels.user),
        message("assistant", [{ type: "text", text: persistedHistorySentinels.assistant }]),
      ],
    }, persistedHistorySentinels)).toBeUndefined();
  });

  it("does not accept generic timeline length as completed persisted history", () => {
    expect(readyPersistedSessionPath({
      session: persistedSession,
      timeline: [{ kind: "message" }, { kind: "message" }],
    }, persistedHistorySentinels)).toBeUndefined();
  });

  it("recognizes the complete ordered lifecycle", () => {
    const workHash = "#/work/active-session?cwd=%2Fpaper";
    expect(reduceDesktopSmokeEvents([
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-old",
        sidecarPid: 41,
      },
      { type: "desktop-smoke.window-loaded" },
      { type: "desktop-smoke.state-visible" },
      { type: "desktop-smoke.agent-running" },
      { type: "desktop-smoke.restart-api-accepted", bootId: "boot-old", hash: workHash },
      { type: "desktop-smoke.restart-requested", bootId: "boot-old" },
      { type: "desktop-smoke.old-sidecar-exited", bootId: "boot-old", clean: true },
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-new",
        sidecarPid: 42,
        rendererCredentialFresh: true,
      },
      {
        type: "desktop-smoke.successor-visible",
        bootId: "boot-new",
        hash: workHash,
        authenticated: true,
        persistedSessionVisible: true,
      },
      { type: "desktop-smoke.window-hidden", hidden: true, sidecarPid: 42 },
      { type: "desktop-smoke.exit-started" },
      { type: "desktop-smoke.sidecar-stopped" },
    ])).toMatchObject({
      origin: "http://127.0.0.1:43123",
      initialBootId: "boot-old",
      loaded: true,
      stateVisible: true,
      agentRunning: true,
      restartAccepted: true,
      restartRequested: true,
      oldSidecarExited: true,
      successorOrigin: "http://127.0.0.1:43123",
      successorBootId: "boot-new",
      rendererCredentialFresh: true,
      successorVisible: true,
      restoredHash: workHash,
      hidden: true,
      sidecarPid: 42,
      exitStarted: true,
      stopped: true,
    });
  });

  it("accepts one deterministic successor-start failure, recovery retry, and no-loop successor", () => {
    const workHash = "#/work/active-session?cwd=%2Fpaper";
    const prefix = [
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-old",
        sidecarPid: 41,
      },
      { type: "desktop-smoke.window-loaded" },
      { type: "desktop-smoke.state-visible" },
      { type: "desktop-smoke.agent-running" },
      { type: "desktop-smoke.restart-api-accepted", bootId: "boot-old", hash: workHash },
      { type: "desktop-smoke.restart-requested", bootId: "boot-old" },
      { type: "desktop-smoke.old-sidecar-exited", bootId: "boot-old", clean: true },
      { type: "desktop-smoke.successor-start-failed", hash: workHash },
      { type: "desktop-smoke.restart-recovery-visible", hash: workHash },
      { type: "desktop-smoke.successor-retry-requested", hash: workHash },
    ];
    const successor = {
      type: "desktop-smoke.sidecar-ready",
      origin: "http://127.0.0.1:43124",
      bootId: "boot-new",
      sidecarPid: 42,
      rendererCredentialFresh: true,
    };
    const evidence = {
      desktopLog: "[2026-09-03T00:00:00.000Z] Desktop smoke injected one successor startup failure.\n",
    };

    expect(() => reduceDesktopSmokeEvents([...prefix, successor])).toThrow(/desktop log|failure evidence/i);
    expect(reduceDesktopSmokeEvents([...prefix, successor], evidence)).toMatchObject({
      successorStartFailed: true,
      restartRecoveryVisible: true,
      restartRecoveryLogged: true,
      successorRetryRequested: true,
      successorBootId: "boot-new",
    });
    expect(() => reduceDesktopSmokeEvents([
      ...prefix,
      { type: "desktop-smoke.successor-retry-requested", hash: workHash },
      successor,
    ], evidence)).toThrow(/duplicate.*retry|restart loop/i);
  });

  it.each([
    ["missing", ""],
    [
      "duplicated",
      "Desktop smoke injected one successor startup failure.\nDesktop smoke injected one successor startup failure.\n",
    ],
  ])("rejects %s packaged-host successor failure log evidence", (_scenario, desktopLog) => {
    const workHash = "#/work/active-session?cwd=%2Fpaper";
    const events = [
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-old",
        sidecarPid: 41,
      },
      { type: "desktop-smoke.window-loaded" },
      { type: "desktop-smoke.state-visible" },
      { type: "desktop-smoke.agent-running" },
      { type: "desktop-smoke.restart-api-accepted", bootId: "boot-old", hash: workHash },
      { type: "desktop-smoke.restart-requested", bootId: "boot-old" },
      { type: "desktop-smoke.old-sidecar-exited", bootId: "boot-old", clean: true },
      { type: "desktop-smoke.successor-start-failed", hash: workHash },
      { type: "desktop-smoke.restart-recovery-visible", hash: workHash },
    ];

    expect(() => reduceDesktopSmokeEvents(events, { desktopLog })).toThrow(/desktop log|failure evidence/i);
  });

  it("rejects out-of-order or malformed milestones", () => {
    expect(() => reduceDesktopSmokeEvents([
      { type: "desktop-smoke.window-loaded" },
    ])).toThrow(/before sidecar readiness/i);
    expect(() => reduceDesktopSmokeEvents([
      { type: "desktop-smoke.sidecar-ready", origin: "http://0.0.0.0:3000" },
    ])).toThrow(/loopback origin/i);
    expect(() => reduceDesktopSmokeEvents([
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-old",
        sidecarPid: 41,
      },
      { type: "desktop-smoke.window-loaded" },
      { type: "desktop-smoke.state-visible" },
      { type: "desktop-smoke.agent-running" },
      { type: "desktop-smoke.window-hidden", hidden: true, sidecarPid: 0 },
    ])).toThrow(/sidecar process/i);
  });

  it("rejects readiness without a boot identity and owned sidecar process", () => {
    expect(() => reduceDesktopSmokeEvents([
      { type: "desktop-smoke.sidecar-ready", origin: "http://127.0.0.1:43123" },
    ])).toThrow(/boot identity|sidecar process/i);
  });

  it("rejects a second restart request before creating another successor", () => {
    const workHash = "#/work/active-session?cwd=%2Fpaper";
    expect(() => reduceDesktopSmokeEvents([
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-old",
        sidecarPid: 41,
      },
      { type: "desktop-smoke.window-loaded" },
      { type: "desktop-smoke.state-visible" },
      { type: "desktop-smoke.agent-running" },
      { type: "desktop-smoke.restart-api-accepted", bootId: "boot-old", hash: workHash },
      { type: "desktop-smoke.restart-api-accepted", bootId: "boot-old", hash: workHash },
    ])).toThrow(/duplicate.*restart API/i);
  });

  it("rejects duplicate validated sidecar restart events", () => {
    const workHash = "#/work/active-session?cwd=%2Fpaper";
    expect(() => reduceDesktopSmokeEvents([
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-old",
        sidecarPid: 41,
      },
      { type: "desktop-smoke.window-loaded" },
      { type: "desktop-smoke.state-visible" },
      { type: "desktop-smoke.agent-running" },
      { type: "desktop-smoke.restart-api-accepted", bootId: "boot-old", hash: workHash },
      { type: "desktop-smoke.restart-requested", bootId: "boot-old" },
      { type: "desktop-smoke.restart-requested", bootId: "boot-old" },
    ])).toThrow(/duplicate.*restart event/i);
  });

  it("accepts validated machine restart before API response consumption", () => {
    const workHash = "#/work/active-session?cwd=%2Fpaper";
    expect(reduceDesktopSmokeEvents([
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-old",
        sidecarPid: 41,
      },
      { type: "desktop-smoke.window-loaded" },
      { type: "desktop-smoke.state-visible" },
      { type: "desktop-smoke.agent-running" },
      { type: "desktop-smoke.restart-requested", bootId: "boot-old" },
      { type: "desktop-smoke.restart-api-accepted", bootId: "boot-old", hash: workHash },
      { type: "desktop-smoke.old-sidecar-exited", bootId: "boot-old", clean: true },
    ])).toMatchObject({
      restartAccepted: true,
      restartRequested: true,
      oldSidecarExited: true,
    });
  });

  it("accepts clean old exit before delayed API response consumption", () => {
    const workHash = "#/work/active-session?cwd=%2Fpaper";
    expect(reduceDesktopSmokeEvents([
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-old",
        sidecarPid: 41,
      },
      { type: "desktop-smoke.window-loaded" },
      { type: "desktop-smoke.state-visible" },
      { type: "desktop-smoke.agent-running" },
      { type: "desktop-smoke.restart-requested", bootId: "boot-old" },
      { type: "desktop-smoke.old-sidecar-exited", bootId: "boot-old", clean: true },
      { type: "desktop-smoke.restart-api-accepted", bootId: "boot-old", hash: workHash },
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-new",
        sidecarPid: 42,
        rendererCredentialFresh: true,
      },
    ])).toMatchObject({
      restartAccepted: true,
      restartRequested: true,
      oldSidecarExited: true,
      successorBootId: "boot-new",
    });
  });

  it("accepts successor readiness before delayed API response consumption", () => {
    const workHash = "#/work/active-session?cwd=%2Fpaper";
    expect(reduceDesktopSmokeEvents([
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-old",
        sidecarPid: 41,
      },
      { type: "desktop-smoke.window-loaded" },
      { type: "desktop-smoke.state-visible" },
      { type: "desktop-smoke.agent-running" },
      { type: "desktop-smoke.restart-requested", bootId: "boot-old" },
      { type: "desktop-smoke.old-sidecar-exited", bootId: "boot-old", clean: true },
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-new",
        sidecarPid: 42,
        rendererCredentialFresh: true,
      },
      { type: "desktop-smoke.restart-api-accepted", bootId: "boot-old", hash: workHash },
      {
        type: "desktop-smoke.successor-visible",
        bootId: "boot-new",
        hash: workHash,
        authenticated: true,
        persistedSessionVisible: true,
      },
    ])).toMatchObject({
      restartAccepted: true,
      oldSidecarExited: true,
      successorVisible: true,
    });
  });

  it("accepts authenticated successor visibility before delayed API response consumption", () => {
    const workHash = "#/work/active-session?cwd=%2Fpaper";
    expect(reduceDesktopSmokeEvents([
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-old",
        sidecarPid: 41,
      },
      { type: "desktop-smoke.window-loaded" },
      { type: "desktop-smoke.state-visible" },
      { type: "desktop-smoke.agent-running" },
      { type: "desktop-smoke.restart-requested", bootId: "boot-old" },
      { type: "desktop-smoke.old-sidecar-exited", bootId: "boot-old", clean: true },
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-new",
        sidecarPid: 42,
        rendererCredentialFresh: true,
      },
      {
        type: "desktop-smoke.successor-visible",
        bootId: "boot-new",
        hash: workHash,
        authenticated: true,
        persistedSessionVisible: true,
      },
      { type: "desktop-smoke.restart-api-accepted", bootId: "boot-old", hash: workHash },
    ])).toMatchObject({
      restartAccepted: true,
      successorVisible: true,
      restoredHash: workHash,
    });
  });

  it("rejects a successor that restores a different Work hash", () => {
    expect(() => reduceDesktopSmokeEvents([
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-old",
        sidecarPid: 41,
      },
      { type: "desktop-smoke.window-loaded" },
      { type: "desktop-smoke.state-visible" },
      { type: "desktop-smoke.agent-running" },
      {
        type: "desktop-smoke.restart-api-accepted",
        bootId: "boot-old",
        hash: "#/work/expected?cwd=%2Fpaper",
      },
      { type: "desktop-smoke.restart-requested", bootId: "boot-old" },
      { type: "desktop-smoke.old-sidecar-exited", bootId: "boot-old", clean: true },
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-new",
        sidecarPid: 42,
        rendererCredentialFresh: true,
      },
      {
        type: "desktop-smoke.successor-visible",
        bootId: "boot-new",
        hash: "#/work/wrong?cwd=%2Fpaper",
        authenticated: true,
        persistedSessionVisible: true,
      },
    ])).toThrow(/Work hashes did not match/i);
  });

  it("rejects a third ready sidecar as a restart loop", () => {
    const workHash = "#/work/active-session?cwd=%2Fpaper";
    expect(() => reduceDesktopSmokeEvents([
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-old",
        sidecarPid: 41,
      },
      { type: "desktop-smoke.window-loaded" },
      { type: "desktop-smoke.state-visible" },
      { type: "desktop-smoke.agent-running" },
      { type: "desktop-smoke.restart-api-accepted", bootId: "boot-old", hash: workHash },
      { type: "desktop-smoke.restart-requested", bootId: "boot-old" },
      { type: "desktop-smoke.old-sidecar-exited", bootId: "boot-old", clean: true },
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-new",
        sidecarPid: 42,
        rendererCredentialFresh: true,
      },
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43124",
        bootId: "boot-loop",
        sidecarPid: 43,
        rendererCredentialFresh: true,
      },
    ])).toThrow(/restart loop|duplicate.*readiness/i);
  });

  it("preserves a host failure immediately without requiring later lifecycle milestones", () => {
    expect(reduceDesktopSmokeEvents([
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-old",
        sidecarPid: 41,
      },
      { type: "desktop-smoke.window-loaded" },
      { type: "desktop-smoke.failure", message: "root activity message POST timed out" },
      { type: "desktop-smoke.exit-started" },
      { type: "desktop-smoke.sidecar-stopped" },
    ])).toMatchObject({
      origin: "http://127.0.0.1:43123",
      loaded: true,
      failure: "root activity message POST timed out",
      agentRunning: false,
    });
  });

  it("turns the unexpected-exit recovery path into an immediate smoke failure", () => {
    expect(reduceDesktopSmokeEvents([
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-old",
        sidecarPid: 41,
      },
      { type: "desktop-smoke.unexpected-exit", bootId: "boot-old" },
    ])).toMatchObject({
      failure: "Desktop smoke entered the unexpected-exit recovery path.",
    });
  });

  it("turns a successor unexpected-exit path into an immediate smoke failure", () => {
    const workHash = "#/work/active-session?cwd=%2Fpaper";
    expect(reduceDesktopSmokeEvents([
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-old",
        sidecarPid: 41,
      },
      { type: "desktop-smoke.window-loaded" },
      { type: "desktop-smoke.state-visible" },
      { type: "desktop-smoke.agent-running" },
      { type: "desktop-smoke.restart-api-accepted", bootId: "boot-old", hash: workHash },
      { type: "desktop-smoke.restart-requested", bootId: "boot-old" },
      { type: "desktop-smoke.old-sidecar-exited", bootId: "boot-old", clean: true },
      {
        type: "desktop-smoke.sidecar-ready",
        origin: "http://127.0.0.1:43123",
        bootId: "boot-new",
        sidecarPid: 42,
        rendererCredentialFresh: true,
      },
      { type: "desktop-smoke.unexpected-exit", bootId: "boot-new" },
    ])).toMatchObject({
      failure: "Desktop smoke entered the unexpected-exit recovery path.",
    });
  });

  it.each([undefined, "", 42])("rejects a malformed desktop host failure message: %j", (message) => {
    expect(() => reduceDesktopSmokeEvents([
      { type: "desktop-smoke.failure", message },
    ])).toThrow(/failure message/i);
  });

  it("reads complete JSONL events and rejects a partial trailing record", () => {
    const path = join(root, "events.jsonl");
    writeFileSync(path, '{"type":"desktop-smoke.sidecar-ready","origin":"http://127.0.0.1:43123"}\n');
    expect(readDesktopSmokeEvents(path)).toHaveLength(1);
    writeFileSync(path, '{"type":"desktop-smoke.sidecar-ready"');
    expect(() => readDesktopSmokeEvents(path)).toThrow(/invalid desktop smoke event/i);
  });
});
