import { describe, expect, it } from "vitest";
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
});
