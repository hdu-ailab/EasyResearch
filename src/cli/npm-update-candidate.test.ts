import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyNpmUpdateCandidate } from "./npm-update-candidate";
import type { NpmProvenance } from "../runtime/npm-update-provenance";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(version = "2.0.0") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "npm-candidate-"))); roots.push(root);
  const metaRoot = join(root, "prefix/lib/node_modules/easyresearch");
  const platformRoot = join(metaRoot, "node_modules/easyresearch-linux-x64");
  const binary = join(platformRoot, "bin/easyresearch");
  const launcher = join(metaRoot, "launcher.mjs");
  mkdirSync(dirname(binary), { recursive: true }); mkdirSync(join(root, "prefix/bin"), { recursive: true });
  writeFileSync(join(metaRoot, "package.json"), JSON.stringify({ name: "easyresearch", version, bin: { easyresearch: "launcher.mjs" }, optionalDependencies: { "easyresearch-linux-x64": version } }));
  writeFileSync(join(platformRoot, "package.json"), JSON.stringify({ name: "easyresearch-linux-x64", version }));
  writeFileSync(launcher, ""); writeFileSync(binary, "binary candidate fixture"); symlinkSync(launcher, join(root, "prefix/bin/easyresearch"));
  const provenance: NpmProvenance = { schema: 1, version: "1.0.0", platform: "linux", arch: "x64", metaRoot, launcher, binary, platformManifest: join(platformRoot, "package.json"), nodeExecutable: process.execPath };
  return { root, provenance };
}
describe("installed npm candidate verification", () => {
  it("rejects an unchanged package after an installer exits zero", async () => {
    const f = fixture("1.0.0");
    await expect(verifyNpmUpdateCandidate(f.provenance, "2.0.0", f.root, AbortSignal.timeout(1000), { environment: {}, run: async () => ({ code: 0, stdout: "easyresearch 2.0.0\n", stderr: "" }) })).rejects.toThrow();
  });
  it("rejects wrong native version even when manifests claim success", async () => {
    const f = fixture();
    await expect(verifyNpmUpdateCandidate(f.provenance, "2.0.0", f.root, AbortSignal.timeout(1000), { environment: {}, run: async () => ({ code: 0, stdout: "easyresearch 1.0.0\n", stderr: "" }) })).rejects.toThrow();
  });
  it("stages distinct immutable artifact copies and verifies their executable version", async () => {
    const f = fixture(); const executions: string[] = [];
    const options = { environment: {}, run: async (exe: string, args: string[]) => { expect(args).toEqual(["--version"]); executions.push(exe); return { code: 0, stdout: "easyresearch 2.0.0\n", stderr: "" }; } };
    const a = await verifyNpmUpdateCandidate(f.provenance, "2.0.0", f.root, AbortSignal.timeout(1000), options);
    const b = await verifyNpmUpdateCandidate(f.provenance, "2.0.0", f.root, AbortSignal.timeout(1000), options);
    expect(a.executable).not.toBe(b.executable);
    expect(readFileSync(a.executable)).toEqual(readFileSync(f.provenance.binary));
    expect(a.sha256).toBe(b.sha256);
    expect(executions).toContain(a.executable);
  });
});
