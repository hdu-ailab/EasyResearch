import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as launcher from "../../launcher.mjs";

describe("npm launcher diagnostics", () => {
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
