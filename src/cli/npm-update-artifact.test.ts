import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyNpmUpdateCandidate } from "./npm-update-candidate";
import { discardNpmUpdateCandidate, reclaimNpmUpdateArtifacts, registerNpmArtifactProcess } from "./npm-update-artifact";
import type { NpmProvenance } from "../runtime/npm-update-provenance";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(linkedRoot = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "npm-artifact-"))); roots.push(root);
  const metaRoot = join(root, "prefix/lib/node_modules/easyresearch");
  const platformRoot = join(metaRoot, "node_modules/easyresearch-linux-x64");
  const binary = join(platformRoot, "bin/easyresearch"); const launcher = join(metaRoot, "launcher.mjs");
  mkdirSync(dirname(binary), { recursive: true }); mkdirSync(join(root, "prefix/bin"), { recursive: true });
  writeFileSync(launcher, ""); writeFileSync(binary, "native executable fixture"); symlinkSync(launcher, join(root, "prefix/bin/easyresearch"));
  writeFileSync(join(metaRoot, "package.json"), JSON.stringify({ name: "easyresearch", version: "2.0.0", bin: { easyresearch: "launcher.mjs" }, optionalDependencies: { "easyresearch-linux-x64": "2.0.0" } }));
  writeFileSync(join(platformRoot, "package.json"), JSON.stringify({ name: "easyresearch-linux-x64", version: "2.0.0" }));
  const provenance: NpmProvenance = { schema: 1, metaRoot, launcher, binary, platformManifest: join(platformRoot, "package.json"), nodeExecutable: process.execPath, version: "1.0.0", platform: "linux", arch: "x64" };
  const agentDir = linkedRoot ? join(root, "linked-home") : root;
  if (linkedRoot) symlinkSync(root, agentDir, "junction");
  const candidate = await verifyNpmUpdateCandidate(provenance, "2.0.0", agentDir, AbortSignal.timeout(2000), { environment: {}, run: async () => ({ code: 0, stdout: "easyresearch 2.0.0\n", stderr: "" }) });
  return { root, candidate, agentDir };
}
describe("owned npm executable disposal", () => {
  it("canonicalizes a linked native config ancestor once for staging and later reclamation", async () => {
    const f = await fixture(true);
    expect(f.candidate.executable).toBe(realpathSync(f.candidate.executable));
    const user = registerNpmArtifactProcess(f.candidate.executable)!; user.retire(); user.close();
    await reclaimNpmUpdateArtifacts(f.agentDir);
    expect(existsSync(f.candidate.executable)).toBe(false);
  });
  it("prunes thousands of dead worker receipts while preserving a live guard and eventually reclaims the retired artifact", async () => {
    const f = await fixture(); const daemon = registerNpmArtifactProcess(f.candidate.executable)!;
    const owners = join(f.root, "bin", `.${f.candidate.executable.split(/[\\/]/).at(-1)}.npm-update.json.owners`);
    const deadPid = 2_000_000_000;
    expect(() => process.kill(deadPid, 0)).toThrow();
    for (let index = 0; index < 4100; index++) writeFileSync(join(owners, `${randomUUID()}.json`), JSON.stringify({ schema: 1, pid: deadPid, artifactToken: f.candidate.artifactToken }));
    for (let attempt = 0; attempt < 20 && readdirSync(owners).length > 1; attempt++) await reclaimNpmUpdateArtifacts(f.root);
    expect(readdirSync(owners)).toHaveLength(1);
    expect(existsSync(f.candidate.executable)).toBe(true);
    daemon.retire(); daemon.close();
    await reclaimNpmUpdateArtifacts(f.root);
    expect(existsSync(f.candidate.executable)).toBe(false);
  });
  it("removes a cancelled staged executable and its receipt", async () => {
    const f = await fixture();
    await discardNpmUpdateCandidate(f.candidate);
    expect(existsSync(f.candidate.executable)).toBe(false);
  });
  it("preserves active and live-worker copies, then reclaims a retired copy after every user closes", async () => {
    const f = await fixture();
    const daemon = registerNpmArtifactProcess(f.candidate.executable)!;
    const worker = registerNpmArtifactProcess(f.candidate.executable)!;
    expect(daemon).toBeDefined(); expect(worker).toBeDefined();
    await reclaimNpmUpdateArtifacts(f.root);
    expect(existsSync(f.candidate.executable)).toBe(true);
    daemon.retire(); daemon.close();
    await reclaimNpmUpdateArtifacts(f.root);
    expect(existsSync(f.candidate.executable)).toBe(true);
    worker.close();
    await reclaimNpmUpdateArtifacts(f.root);
    expect(existsSync(f.candidate.executable)).toBe(false);
  });
  it("never reclaims an unreceipted file or changed executable bytes", async () => {
    const f = await fixture();
    const owner = registerNpmArtifactProcess(f.candidate.executable)!; owner.retire(); owner.close();
    writeFileSync(f.candidate.executable, "changed by another owner");
    const foreign = join(f.root, "bin/easyresearch-foreign"); writeFileSync(foreign, "user file");
    await reclaimNpmUpdateArtifacts(f.root);
    expect(readFileSync(f.candidate.executable, "utf8")).toBe("changed by another owner");
    expect(readFileSync(foreign, "utf8")).toBe("user file");
  });
});
