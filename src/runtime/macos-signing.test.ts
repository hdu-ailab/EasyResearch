import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeBuildArtifact, TARGETS } from "../../scripts/build";
import { electronBuilderConfig } from "../../scripts/build-desktop";
import { installMacOsDmgApplication } from "../../scripts/smoke-desktop-support";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawnSync: vi.fn(),
}));

let root: string;
const darwin = TARGETS.find((target) => target.name === "darwin-arm64")!;
const success = { status: 0, signal: null, stdout: "", stderr: "", pid: 1, output: [] };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-macos-signing-"));
  vi.mocked(spawnSync).mockReset().mockReturnValue(success);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("native macOS artifact finalization", () => {
  it("records the signed bytes only after successful strict verification", () => {
    const binary = join(root, "binary with spaces");
    writeFileSync(binary, "invalid compiler signature");
    const operations: string[] = [];
    vi.mocked(spawnSync).mockImplementation((command, args) => {
      expect(command).toBe("/usr/bin/codesign");
      expect(args!.at(-1)).toBe(binary);
      if (args!.includes("--sign")) {
        expect(args).toEqual(expect.arrayContaining(["--force", "--sign", "-", "--timestamp=none"]));
        expect(args).not.toContain("--deep");
        operations.push("sign");
        writeFileSync(binary, "final signed executable");
      } else {
        expect(args).toEqual(expect.arrayContaining(["--verify", "--strict"]));
        expect(readFileSync(binary, "utf8")).toBe("final signed executable");
        operations.push("verify");
      }
      return success;
    });

    const artifact = finalizeBuildArtifact(darwin, binary, "1.2.3", "darwin");

    expect(operations).toEqual(["sign", "verify"]);
    expect(artifact).toMatchObject({
      version: "1.2.3", target: darwin.name, binaryName: "easyresearch",
      size: Buffer.byteLength("final signed executable"),
      sha256: createHash("sha256").update("final signed executable").digest("hex"),
    });
  });

  it.each([
    { phase: "sign", result: { status: 1, stderr: "signing failed" } },
    { phase: "sign", result: { status: null, signal: "SIGKILL" } },
    { phase: "sign", result: { status: null, error: new Error("codesign unavailable") } },
    { phase: "verify", result: { status: 1, stderr: "invalid signature" } },
  ])("rejects the artifact when $phase fails ($result)", ({ phase, result }) => {
    const binary = join(root, "easyresearch");
    writeFileSync(binary, "unaccepted bytes");
    if (phase === "verify") vi.mocked(spawnSync).mockReturnValueOnce(success);
    vi.mocked(spawnSync).mockReturnValueOnce({ ...success, ...result } as ReturnType<typeof spawnSync>);

    expect(() => finalizeBuildArtifact(darwin, binary, "1.2.3", "darwin"))
      .toThrow(/codesign/i);
    expect(spawnSync).toHaveBeenCalledTimes(phase === "verify" ? 2 : 1);
  });

  it.each([
    ["linux-x64", "linux"], ["linux-x64", "darwin"],
    ["windows-x64", "win32"], ["darwin-arm64", "linux"],
  ] as const)("does not invoke macOS tools for %s on %s", (name, host) => {
    const binary = join(root, "binary");
    writeFileSync(binary, "original bytes");
    const artifact = finalizeBuildArtifact(TARGETS.find((target) => target.name === name)!, binary, "1.2.3", host);
    expect(artifact.sha256).toBe(createHash("sha256").update("original bytes").digest("hex"));
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

function bundleFixture() {
  const stage = join(root, "stage");
  const output = join(root, "mac-arm64");
  const app = posix.join(output, "EasyResearch.app");
  const accepted = join(stage, "sidecar", "easyresearch");
  const packaged = posix.join(app, "Contents", "Resources", "sidecar", "easyresearch");
  for (const path of [accepted, packaged]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "accepted signed sidecar");
  }
  const config = electronBuilderConfig("darwin-arm64", "1.2.3", stage, root);
  return { stage, output, app, accepted, packaged, config };
}

describe("macOS bundle signing boundary", () => {
  it("re-signs the host and helpers while excluding only the accepted sidecar executable", () => {
    const { app, packaged, config } = bundleFixture();
    expect(config.mac?.identity).toBe("-");
    const filters = [config.mac?.signIgnore].flat().filter((filter): filter is string => typeof filter === "string");
    const ignores = (path: string) => filters.some((filter) => new RegExp(filter).test(path));
    expect(ignores(packaged)).toBe(true);
    expect(ignores(app)).toBe(false);
    expect(ignores(posix.join(app, "Contents", "MacOS", "EasyResearch"))).toBe(false);
    expect(ignores(`${packaged}-other`)).toBe(false);
    expect(ignores(`${packaged}/nested`)).toBe(false);
  });

  it("strictly verifies the preserved sidecar and sealed bundle before distribution", async () => {
    const { output, app, packaged, config } = bundleFixture();
    expect(config.afterSign).toBeTypeOf("function");
    await (config.afterSign as (context: { appOutDir: string }) => Promise<void>)({ appOutDir: output });
    const calls = vi.mocked(spawnSync).mock.calls;
    expect(calls.map(([, args]) => args!.at(-1))).toEqual([packaged, app]);
    for (const [, args] of calls) expect(args).toEqual(expect.arrayContaining(["--verify", "--strict"]));
    expect(calls[1]![1]).toContain("--deep");
    expect(calls.every(([, args]) => !args!.includes("--sign"))).toBe(true);
  });

  it("rejects an app whose signing step changed the accepted sidecar bytes", async () => {
    const { output, packaged, config } = bundleFixture();
    writeFileSync(packaged, "sidecar re-signed differently");
    expect(config.afterSign).toBeTypeOf("function");
    await expect((config.afterSign as (context: { appOutDir: string }) => Promise<void>)({ appOutDir: output }))
      .rejects.toThrow(/sidecar.*(match|changed)/i);
  });

  it.each(["sidecar", "app"])("rejects an invalid %s signature after packaging", async (part) => {
    const { output, config } = bundleFixture();
    if (part === "app") vi.mocked(spawnSync).mockReturnValueOnce(success);
    vi.mocked(spawnSync).mockReturnValueOnce({ ...success, status: 1, stderr: "invalid signature" });
    expect(config.afterSign).toBeTypeOf("function");
    await expect((config.afterSign as (context: { appOutDir: string }) => Promise<void>)({ appOutDir: output }))
      .rejects.toThrow(/invalid signature/i);
  });
});

describe("installed DMG acceptance", () => {
  it("copies from the mounted package and validates the installed paths without repairing signatures", () => {
    const { output: mounted, accepted, packaged } = bundleFixture();
    const installed = join(root, "installed with spaces");
    const result = installMacOsDmgApplication(mounted, installed, accepted, (command) => {
      expect(command.command).toBe("/usr/bin/ditto");
      expect(command.args).toEqual([posix.join(mounted, "EasyResearch.app"), posix.join(installed, "EasyResearch.app")]);
      cpSync(command.args[0]!, command.args[1]!, { recursive: true });
    });

    expect(result.executable).toBe(posix.join(installed, "EasyResearch.app", "Contents", "MacOS", "EasyResearch"));
    expect(readFileSync(result.sidecar)).toEqual(readFileSync(accepted));
    expect(readFileSync(packaged)).toEqual(readFileSync(accepted));
    const calls = vi.mocked(spawnSync).mock.calls;
    expect(calls.map(([, args]) => args!.at(-1))).toEqual([result.sidecar, posix.join(installed, "EasyResearch.app")]);
    expect(calls.every(([, args]) => args!.includes("--verify") && !args!.includes("--sign"))).toBe(true);
  });

  it("fails when the installed copy has an invalid signature", () => {
    const { output: mounted, accepted } = bundleFixture();
    vi.mocked(spawnSync).mockReturnValueOnce({ ...success, status: 1, stderr: "invalid installed signature" });
    expect(() => installMacOsDmgApplication(mounted, join(root, "installed"), accepted, ({ args }) => {
      cpSync(args[0]!, args[1]!, { recursive: true });
    })).toThrow(/invalid installed signature/);
  });
});
