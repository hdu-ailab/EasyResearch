import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BuildManifest } from "../../scripts/build";
import {
  assertNativeDesktopHost,
  desktopBuilderInvocation,
  desktopTarget,
  electronBuilderConfig,
  stageDesktopNotices,
  validateDesktopSidecar,
} from "../../scripts/build-desktop";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-desktop-build-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixture(bytes = "accepted-sidecar") {
  const binary = join(root, "easyresearch.exe");
  writeFileSync(binary, bytes);
  const manifest: BuildManifest = {
    version: "1.2.3",
    artifacts: [{
      version: "1.2.3",
      target: "windows-x64",
      binaryName: "easyresearch.exe",
      size: Buffer.byteLength(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      builtAt: "2026-08-23T00:00:00.000Z",
    }],
  };
  return { binary, manifest };
}

describe("desktop target selection", () => {
  it("maps supported hosts and retains Linux x64 as preview-only", () => {
    expect(desktopTarget("windows-x64")).toMatchObject({
      name: "windows-x64",
      platform: "win32",
      arch: "x64",
      binaryName: "easyresearch.exe",
    });
    expect(desktopTarget("darwin-arm64")).toMatchObject({
      name: "darwin-arm64",
      platform: "darwin",
      arch: "arm64",
      binaryName: "easyresearch",
    });
    expect(() => desktopTarget("linux-x64")).toThrow(/no desktop package/i);
  });

  it("requires packaging on the matching native host", () => {
    expect(() => assertNativeDesktopHost("windows-x64", "linux", "x64"))
      .toThrow(/must be packaged on win32-x64/i);
    expect(() => assertNativeDesktopHost("windows-x64", "win32", "x64"))
      .not.toThrow();
  });

  it("accepts native Linux ARM64 and rejects a cross-host desktop build", () => {
    expect(desktopTarget("linux-arm64")).toMatchObject({
      platform: "linux", arch: "arm64", binaryName: "easyresearch",
    });
    expect(() => assertNativeDesktopHost("linux-arm64", "linux", "arm64")).not.toThrow();
    expect(() => assertNativeDesktopHost("linux-arm64", "linux", "x64")).toThrow(/native|linux-arm64|packaged/i);
  });
});

describe("accepted sidecar integrity", () => {
  it("returns the exact matching native artifact", () => {
    const { binary, manifest } = fixture();
    expect(validateDesktopSidecar("windows-x64", manifest, binary, "1.2.3"))
      .toEqual(manifest.artifacts[0]);
  });

  it("rejects changed bytes before Electron packaging", () => {
    const { binary, manifest } = fixture();
    writeFileSync(binary, "changed");
    expect(() => validateDesktopSidecar("windows-x64", manifest, binary, "1.2.3"))
      .toThrow(/size|SHA-256/i);
  });

  it("rejects another target or version", () => {
    const { binary, manifest } = fixture();
    expect(() => validateDesktopSidecar("darwin-arm64", manifest, binary, "1.2.3"))
      .toThrow(/target/i);
    expect(() => validateDesktopSidecar("windows-x64", manifest, binary, "1.2.4"))
      .toThrow(/version/i);
  });
});

describe("accepted third-party notices", () => {
  it("stages a byte-identical accepted notice beside the sidecar", () => {
    const source = join(root, "native", "THIRD_PARTY_NOTICES.txt");
    const destination = join(root, "stage", "sidecar", "THIRD_PARTY_NOTICES.txt");
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(source, "accepted notices\n");

    stageDesktopNotices(source, destination, "accepted notices\n");

    expect(readFileSync(destination, "utf8")).toBe("accepted notices\n");
    writeFileSync(source, "tampered\n");
    expect(() => stageDesktopNotices(source, destination, "accepted notices\n"))
      .toThrow(/changed/i);
  });
});

describe("electron-builder configuration", () => {
  it("builds both ARM64 Linux formats with explicit desktop naming and sandbox-preserving arguments", () => {
    const config = electronBuilderConfig("linux-arm64", "1.2.3", join(root, "stage"), join(root, "desktop"));
    expect(config.linux).toMatchObject({
      executableName: "easyresearch-desktop",
      target: [{ target: "AppImage", arch: ["arm64"] }, { target: "deb", arch: ["arm64"] }],
      artifactName: "EasyResearch-1.2.3-linux-arm64.${ext}",
    });
    expect(config.appImage?.executableArgs).toEqual([]);
    expect(config.mac).toBeUndefined();
    expect(config.win).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("stages an AppRun that forwards quoted arguments without an unsandboxed fallback", async () => {
    const appDir = join(root, "app with spaces");
    mkdirSync(appDir);
    const capture = join(root, "arguments");
    const executable = join(appDir, "easyresearch-desktop");
    writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@" > "$ARGUMENT_CAPTURE"\n');
    chmodSync(executable, 0o755);
    const fakeTools = join(root, "tools");
    mkdirSync(fakeTools);
    writeFileSync(join(fakeTools, "unshare"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const config = electronBuilderConfig("linux-arm64", "1.2.3", join(root, "stage"), join(root, "desktop"));
    expect(typeof config.afterPack).toBe("function");
    await (config.afterPack as (context: { appOutDir: string }) => Promise<void>)({ appOutDir: appDir });
    const result = spawnSync(join(appDir, "AppRun"), ["a value with spaces", "--example=one"], {
      env: { ...process.env, PATH: `${fakeTools}:${process.env.PATH ?? ""}`, APPDIR: appDir, ARGUMENT_CAPTURE: capture }, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(capture, "utf8").trim().split("\n")).toEqual(["a value with spaces", "--example=one"]);
    const extractedEnv: NodeJS.ProcessEnv = { ...process.env, ARGUMENT_CAPTURE: capture };
    delete extractedEnv.APPDIR;
    const extracted = spawnSync(join(appDir, "AppRun"), ["extracted launch"], { env: extractedEnv, encoding: "utf8" });
    expect(extracted.status, extracted.stderr).toBe(0);
    expect(readFileSync(capture, "utf8").trim()).toBe("extracted launch");
  });
  it("uses the staging directory as the project root for relative sidecar resources", () => {
    const stage = join(root, "stage");
    const invocation = desktopBuilderInvocation(
      "windows-x64",
      "1.2.3",
      stage,
      join(root, "desktop"),
    );

    expect(invocation.projectDir).toBe(stage);
    const resource = Array.isArray(invocation.config.extraResources)
      ? invocation.config.extraResources[0]
      : undefined;
    expect(resource).toMatchObject({ from: "sidecar", to: "sidecar" });
    expect(join(invocation.projectDir, String((resource as { from?: unknown }).from)))
      .toBe(join(stage, "sidecar"));
  });

  it("uses explicit allowlists and unsigned arm64 DMG configuration", () => {
    const config = electronBuilderConfig(
      "darwin-arm64",
      "1.2.3",
      join(root, "stage"),
      join(root, "desktop"),
    );
    expect(config).toMatchObject({
      appId: "ai.easyresearch.desktop",
      productName: "EasyResearch",
      electronVersion: "42.3.3",
      asar: true,
      files: ["main.cjs", "preload.cjs", "package.json"],
      extraResources: expect.arrayContaining([{ from: "sidecar", to: "sidecar" }]),
      mac: {
        identity: null,
        notarize: false,
        target: [{ target: "dmg", arch: ["arm64"] }],
        artifactName: "EasyResearch-1.2.3-macos-arm64.${ext}",
      },
    });
  });

  it("uses a per-user unsigned x64 NSIS installer", () => {
    const config = electronBuilderConfig(
      "windows-x64",
      "1.2.3",
      join(root, "stage"),
      join(root, "desktop"),
    );
    expect(config).toMatchObject({
      win: {
        signExecutable: false,
        target: [{ target: "nsis", arch: ["x64"] }],
        artifactName: "EasyResearch-1.2.3-windows-x64.${ext}",
      },
      nsis: {
        perMachine: false,
        oneClick: true,
        allowElevation: false,
        differentialPackage: false,
      },
    });
  });

  it.each(["windows-x64", "darwin-arm64", "linux-arm64"] as const)(
    "packages application and window artwork for %s", (target) => {
      const config = electronBuilderConfig(target, "1.2.3", join(root, "stage"), join(root, "desktop"));
      const resources = config.extraResources as Array<{ from: string; to: string; filter?: string[] }>;
      const artwork = resources.find(resource => resource.to === "icons");
      expect(artwork).toBeDefined();
      expect(artwork?.filter).toEqual(expect.arrayContaining(["icon.png", "tray.png", "tray@2x.png"]));
      const icon = target === "windows-x64" ? config.win?.icon : target === "darwin-arm64" ? config.mac?.icon : config.linux?.icon;
      expect(icon).toBe(join(artwork!.from, target === "windows-x64" ? "icon.ico" : target === "darwin-arm64" ? "icon.icns" : "icon.png"));
    },
  );
});
