import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Platform } from "electron-builder";
import { createElectronFrameworkSupport } from "app-builder-lib/out/electron/ElectronFramework";
import type { BeforeCopyExtraFilesOptions } from "app-builder-lib/out/Framework";
import { Packager } from "app-builder-lib/out/packager";
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

describe("Windows package locale acceptance", () => {
  function packageFixture(): string {
    const appOutDir = join(root, "installed app");
    const localesDir = join(appOutDir, "locales");
    mkdirSync(localesDir, { recursive: true });
    for (const language of ["en-US", "en-GB", "zh-CN", "zh-TW"]) {
      writeFileSync(join(localesDir, `${language}.pak`), `locale bytes: ${language}`);
    }
    return appOutDir;
  }

  async function acceptPackage(appOutDir: string): Promise<void> {
    const config = electronBuilderConfig("windows-x64", "1.2.3", join(root, "stage"), join(root, "desktop"));
    expect(typeof config.afterPack).toBe("function");
    await (config.afterPack as (context: { appOutDir: string }) => Promise<void>)({ appOutDir });
  }

  it("accepts physical nonempty packs for both English and Chinese regional variants without rewriting them", async () => {
    const appOutDir = packageFixture();
    const localesDir = join(appOutDir, "locales");
    const before = readdirSync(localesDir).map(name => [name, readFileSync(join(localesDir, name))]);

    await acceptPackage(appOutDir);

    expect(readdirSync(localesDir).map(name => [name, readFileSync(join(localesDir, name))])).toEqual(before);
  });

  it("rejects stale unselected locale packs rather than silently repairing package contents", async () => {
    const appOutDir = packageFixture();
    const stale = join(appOutDir, "locales", "fr.pak");
    writeFileSync(stale, "old installation locale");

    await expect(acceptPackage(appOutDir)).rejects.toThrow(/unexpected.*fr\.pak/i);
    expect(readFileSync(stale, "utf8")).toBe("old installation locale");
  });

  it.each(["en-US", "en-GB", "zh-CN", "zh-TW"])("rejects a missing %s pack, including the English fallback", async (language) => {
    const appOutDir = packageFixture();
    rmSync(join(appOutDir, "locales", `${language}.pak`));

    await expect(acceptPackage(appOutDir)).rejects.toThrow(`missing: ${language}.pak`);
  });

  it.each(["empty", "directory"])("rejects a named fallback pack that is %s", async (kind) => {
    const appOutDir = packageFixture();
    const fallback = join(appOutDir, "locales", "en-US.pak");
    rmSync(fallback);
    if (kind === "directory") mkdirSync(fallback);
    else writeFileSync(fallback, "");

    await expect(acceptPackage(appOutDir)).rejects.toThrow(/en-US\.pak.*nonempty regular file/i);
  });

  it("rejects an absent locale directory", async () => {
    const appOutDir = packageFixture();
    rmSync(join(appOutDir, "locales"), { recursive: true });

    await expect(acceptPackage(appOutDir)).rejects.toThrow(/ENOENT|locales|no such file/i);
  });
});

describe("electron-builder configuration", () => {
  it("prunes only unselected Windows locale files through the pinned builder while preserving retained bytes", async () => {
    const stage = join(root, "stage");
    const appOutDir = join(root, "win-unpacked");
    const localesDir = join(appOutDir, "locales");
    mkdirSync(stage);
    mkdirSync(localesDir, { recursive: true });
    writeFileSync(join(stage, "package.json"), JSON.stringify({
      name: "desktop-locale-fixture",
      version: "1.2.3",
      description: "Isolated desktop packaging fixture",
      author: "fixture",
    }));
    const retained = ["en-US", "en-GB", "zh-CN", "zh-TW"];
    for (const language of [...retained, "fr", "de", "ja", "en-AU", "zh-HK"]) {
      writeFileSync(join(localesDir, `${language}.pak`), Buffer.from(`\0${language}\xff`, "latin1"));
    }
    const preserved = new Map([
      [join(appOutDir, "LICENSES.chromium.html"), "required Chromium notices"],
      [join(appOutDir, "icudtl.dat"), "required Unicode data"],
      [join(appOutDir, "resources.pak"), "required shared resources"],
    ]);
    for (const [path, bytes] of preserved) writeFileSync(path, bytes);
    writeFileSync(join(appOutDir, "electron.exe"), "fixture host");

    const invocation = desktopBuilderInvocation("windows-x64", "1.2.3", stage, join(root, "desktop"));
    const builder = new Packager(invocation);
    await builder.validateConfig();
    const framework = await createElectronFrameworkSupport(builder.config, builder);
    // Execute the real builder's file-stage hook only: no Electron download,
    // native executable, signing, full build or repository output is involved.
    await framework.beforeCopyExtraFiles!({
      appOutDir,
      asarIntegrity: null,
      platformName: "win32",
      packager: {
        config: builder.config,
        platformSpecificBuildOptions: builder.config.win!,
        platform: Platform.WINDOWS,
        appInfo: { productFilename: "EasyResearch" },
        getResourcesDir: (directory: string) => join(directory, "resources"),
      } as BeforeCopyExtraFilesOptions["packager"],
    });

    expect(readdirSync(localesDir).sort()).toEqual(retained.map(language => `${language}.pak`).sort());
    for (const language of retained) {
      expect(readFileSync(join(localesDir, `${language}.pak`)))
        .toEqual(Buffer.from(`\0${language}\xff`, "latin1"));
    }
    for (const [path, bytes] of preserved) expect(readFileSync(path, "utf8")).toBe(bytes);
  });

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

  it("uses explicit allowlists and ad-hoc-signed unnotarized arm64 DMG configuration", () => {
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
        identity: "-",
        notarize: false,
        target: [{ target: "dmg", arch: ["arm64"] }],
        artifactName: "EasyResearch-1.2.3-macos-arm64.${ext}",
      },
    });
  });

  it("enables the assisted directory page with current-user defaults and no elevation", () => {
    const config = electronBuilderConfig(
      "windows-x64",
      "1.2.3",
      join(root, "stage"),
      join(root, "desktop"),
    );
    expect(config.win).toMatchObject({
      signExecutable: false,
      target: [{ target: "nsis", arch: ["x64"] }],
      artifactName: "EasyResearch-1.2.3-windows-x64.${ext}",
    });
    const installer = config.nsis!;
    expect(installer.oneClick).toBe(false);
    expect(installer.allowToChangeInstallationDirectory).toBe(true);
    expect(installer.perMachine).toBe(false);
    expect(installer.selectPerMachineByDefault).not.toBe(true);
    expect(installer.allowElevation).toBe(false);
    expect(installer.script).toBeUndefined();
    expect(installer.include).toBeUndefined();
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
