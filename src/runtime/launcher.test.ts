import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as launcher from "../../launcher.mjs";

describe("npm launcher diagnostics", () => {
  it("captures the actual launcher Node and canonical package relationship without inheriting a forged descriptor", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "launcher-provenance-")));
    try {
      const platformRoot = join(root, "node_modules/easyresearch-linux-x64");
      mkdirSync(join(platformRoot, "bin"), { recursive: true });
      writeFileSync(join(root, "launcher.mjs"), "");
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "easyresearch", version: "1.0.0", optionalDependencies: { "easyresearch-linux-x64": "1.0.0" } }));
      writeFileSync(join(platformRoot, "package.json"), JSON.stringify({ name: "easyresearch-linux-x64", version: "1.0.0" }));
      const binary = join(platformRoot, "bin/easyresearch"); writeFileSync(binary, "fixture");
      const captured = launcher.captureNpmProvenance(root, binary, "easyresearch-linux-x64", { platform: "linux", arch: "x64", execPath: process.execPath });
      expect(captured).toMatchObject({ metaRoot: root, binary, version: "1.0.0", nodeExecutable: realpathSync(process.execPath) });
      writeFileSync(join(platformRoot, "package.json"), JSON.stringify({ name: "easyresearch-linux-x64", version: "0.9.0" }));
      expect(launcher.captureNpmProvenance(root, binary, "easyresearch-linux-x64", { platform: "linux", arch: "x64", execPath: process.execPath })).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("distinguishes missing optional packages from unsupported platforms", () => {
    const missingOptionalPackageMessage = (launcher as typeof launcher & {
      missingOptionalPackageMessage(name: string): string;
    }).missingOptionalPackageMessage;
    expect(missingOptionalPackageMessage("easyresearch-linux-x64")).toContain("npm reinstall");
    expect(missingOptionalPackageMessage("easyresearch-linux-x64")).toContain("easyresearch-linux-x64");
  });

  it("reports spawn errors, signals, and nonzero exits distinctly", () => {
    const describeSpawnFailure = (launcher as typeof launcher & {
      describeSpawnFailure(result: { error?: NodeJS.ErrnoException; signal?: string | null; status?: number | null }, target: string): string;
    }).describeSpawnFailure;
    expect(describeSpawnFailure({ error: Object.assign(new Error("denied"), { code: "EACCES" }) }, "/bin/easyresearch")).toContain("EACCES");
    expect(describeSpawnFailure({ signal: "SIGTERM", status: null }, "/bin/easyresearch")).toContain("SIGTERM");
    expect(describeSpawnFailure({ status: 7 }, "/bin/easyresearch")).toContain("code 7");
  });

  it("runs when invoked through a symlink like an npm bin link", () => {
    const dir = mkdtempSync(join(tmpdir(), "easyresearch-launcher-symlink-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "easyresearch-test", version: "0.0.0", optionalDependencies: { "easyresearch-linux-x64": "0.0.0" } }),
      );
      const target = join(dir, "launcher.mjs");
      writeFileSync(target, readLauncherSource());
      const link = join(dir, "easyresearch");
      symlinkSync(target, link);

      const result = spawnSync("node", [link, "--version"], { encoding: "utf8" });

      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain(".mjs");
      expect(result.stderr + result.stdout).toContain("npm reinstall");
      expect(result.stderr + result.stdout).toContain("easyresearch-linux-x64");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function readLauncherSource(): string {
  return readFileSync(fileURLToPath(new URL("../../launcher.mjs", import.meta.url)), "utf8");
}
