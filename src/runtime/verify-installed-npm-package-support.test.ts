import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  NPM_REGISTRY,
  assertInstalledPackageManifest,
  assertInstalledVersionInvocation,
  verifyInstalledNpmPackage,
  waitForPublishedPackages,
} from "../../scripts/verify-installed-npm-package-support.mjs";

type CommandResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
};

describe("post-publish installed npm package gate", () => {
  it("retries registry visibility within a fixed attempt bound", async () => {
    const checks: string[] = [];
    const waits: number[] = [];

    await waitForPublishedPackages({
      specs: ["easyresearch@0.0.79", "easyresearch-linux-x64@0.0.79"],
      attempts: 3,
      delayMs: 25,
      check: (spec: string) => {
        checks.push(spec);
        return checks.length > 2;
      },
      wait: async (delayMs: number) => { waits.push(delayMs); },
    });

    expect(checks).toEqual([
      "easyresearch@0.0.79",
      "easyresearch-linux-x64@0.0.79",
      "easyresearch@0.0.79",
      "easyresearch-linux-x64@0.0.79",
    ]);
    expect(waits).toEqual([25]);
  });

  it("reports packages still absent after the bounded visibility attempts", async () => {
    const wait = vi.fn(async () => {});

    await expect(waitForPublishedPackages({
      specs: ["easyresearch@0.0.79", "easyresearch-linux-x64@0.0.79"],
      attempts: 2,
      delayMs: 10,
      check: async () => false,
      wait,
    })).rejects.toThrow(/easyresearch@0\.0\.79.*easyresearch-linux-x64@0\.0\.79.*2 attempts/is);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("requires exact installed package identities and bin-link version output", () => {
    expect(() => assertInstalledPackageManifest(
      { name: "easyresearch", version: "0.0.79" },
      "easyresearch",
      "0.0.79",
    )).not.toThrow();
    expect(() => assertInstalledPackageManifest(
      { name: "easyresearch-linux-x64", version: "0.0.78" },
      "easyresearch-linux-x64",
      "0.0.79",
    )).toThrow(/easyresearch-linux-x64@0\.0\.79/i);

    expect(() => assertInstalledVersionInvocation(
      { status: 0, stdout: "easyresearch 0.0.79\n", stderr: "" },
      "0.0.79",
    )).not.toThrow();
    for (const result of [
      { status: 1, stdout: "easyresearch 0.0.79\n", stderr: "failed" },
      { status: 0, stdout: "easyresearch 0.0.78\n", stderr: "" },
      { status: 0, stdout: "extra\neasyresearch 0.0.79\n", stderr: "" },
    ]) {
      expect(() => assertInstalledVersionInvocation(result, "0.0.79"))
        .toThrow(/easyresearch 0\.0\.79/i);
    }
  });

  it("installs in isolation and invokes npm's generated Linux bin link", async () => {
    expect(NPM_REGISTRY).toBe("https://registry.npmjs.org/");
    const version = "0.0.79";
    const calls: Array<{
      command: string;
      args: readonly string[];
      env: NodeJS.ProcessEnv;
    }> = [];
    let temporaryRoot: string | undefined;
    let generatedBin: string | undefined;
    const run = (
      command: string,
      args: readonly string[],
      options: { encoding: "utf8"; env: NodeJS.ProcessEnv },
    ): CommandResult => {
      calls.push({ command, args: [...args], env: options.env });
      if (command === "npm" && args[0] === "view") {
        return { status: 0, stdout: `${version}\n`, stderr: "" };
      }
      if (command === "npm" && args[0] === "install") {
        const prefixIndex = args.indexOf("--prefix");
        const prefix = args[prefixIndex + 1];
        if (!prefix) throw new Error("test install did not receive a prefix");
        temporaryRoot = dirname(prefix);
        const metaDir = join(prefix, "lib", "node_modules", "easyresearch");
        const platformDir = join(metaDir, "node_modules", "easyresearch-linux-x64");
        const binDir = join(prefix, "bin");
        mkdirSync(platformDir, { recursive: true });
        mkdirSync(binDir, { recursive: true });
        writeFileSync(join(metaDir, "package.json"), JSON.stringify({ name: "easyresearch", version }));
        writeFileSync(join(metaDir, "launcher.mjs"), "");
        writeFileSync(join(platformDir, "package.json"), JSON.stringify({
          name: "easyresearch-linux-x64",
          version,
        }));
        generatedBin = join(binDir, "easyresearch");
        symlinkSync("../lib/node_modules/easyresearch/launcher.mjs", generatedBin);
        return { status: 0, stdout: "installed\n", stderr: "" };
      }
      if (command === generatedBin && args.length === 1 && args[0] === "--version") {
        expect(options.env.HOME).toBe(join(temporaryRoot!, "home"));
        expect(existsSync(join(options.env.HOME!, ".easyresearch"))).toBe(false);
        return { status: 0, stdout: `easyresearch ${version}\n`, stderr: "" };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };

    const result = await verifyInstalledNpmPackage({
      version,
      platform: "linux",
      arch: "x64",
      baseEnv: {
        PATH: "/usr/bin",
        NODE_PATH: "/ambient/node_modules",
        NODE_OPTIONS: "--require=/ambient/hook.cjs",
      },
      run,
      wait: async () => {},
      log: () => {},
    });

    expect(result).toEqual({ version, binPath: generatedBin });
    expect(calls.filter(({ command }) => command === "npm").every(({ args }) =>
      args.includes(`--registry=${NPM_REGISTRY}`)
    )).toBe(true);
    expect(calls.find(({ command, args }) => command === "npm" && args[0] === "install")?.args)
      .toContain(`easyresearch@${version}`);
    expect(calls.at(-1)).toMatchObject({ command: generatedBin, args: ["--version"] });
    expect(calls.every(({ env }) => env.NODE_PATH === undefined && env.NODE_OPTIONS === undefined))
      .toBe(true);
    expect(generatedBin).not.toContain("easyresearch-linux-x64/bin");
    expect(temporaryRoot).toBeTypeOf("string");
    expect(existsSync(temporaryRoot!)).toBe(false);
  });

  it("rejects a resolved platform manifest outside the temporary prefix", async () => {
    const version = "0.0.79";
    const outsideRoot = mkdtempSync(join(tmpdir(), "easyresearch-outside-platform-"));
    const outsideManifest = join(outsideRoot, "package.json");
    writeFileSync(outsideManifest, JSON.stringify({
      name: "easyresearch-linux-x64",
      version,
    }));
    let generatedBin: string | undefined;
    const run = (
      command: string,
      args: readonly string[],
      _options: { encoding: "utf8"; env: NodeJS.ProcessEnv },
    ): CommandResult => {
      if (command === "npm" && args[0] === "view") {
        return { status: 0, stdout: `${version}\n`, stderr: "" };
      }
      if (command === "npm" && args[0] === "install") {
        const prefix = args[args.indexOf("--prefix") + 1];
        if (!prefix) throw new Error("test install did not receive a prefix");
        const metaDir = join(prefix, "lib", "node_modules", "easyresearch");
        const platformDir = join(metaDir, "node_modules", "easyresearch-linux-x64");
        const binDir = join(prefix, "bin");
        mkdirSync(platformDir, { recursive: true });
        mkdirSync(binDir, { recursive: true });
        writeFileSync(join(metaDir, "package.json"), JSON.stringify({ name: "easyresearch", version }));
        writeFileSync(join(metaDir, "launcher.mjs"), "");
        writeFileSync(join(platformDir, "package.json"), JSON.stringify({
          name: "easyresearch-linux-x64",
          version,
        }));
        generatedBin = join(binDir, "easyresearch");
        symlinkSync("../lib/node_modules/easyresearch/launcher.mjs", generatedBin);
        return { status: 0, stdout: "installed\n", stderr: "" };
      }
      if (command === generatedBin) {
        return { status: 0, stdout: `easyresearch ${version}\n`, stderr: "" };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };

    try {
      await expect(verifyInstalledNpmPackage({
        version,
        platform: "linux",
        arch: "x64",
        baseEnv: { PATH: "/usr/bin" },
        run,
        wait: async () => {},
        resolvePlatformManifest: () => outsideManifest,
      })).rejects.toThrow(/platform manifest.*temporary prefix.*node_modules/i);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("rejects a simulated non-x64 Linux host before invoking npm", async () => {
    const run = vi.fn();
    await expect(verifyInstalledNpmPackage({
      version: "0.0.79",
      platform: "linux",
      arch: "arm64",
      run,
    })).rejects.toThrow(/must run on Linux x64/i);
    expect(run).not.toHaveBeenCalled();
  });
});
