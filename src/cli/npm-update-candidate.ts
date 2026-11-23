import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { EnvironmentMap } from "../runtime/network-policy";
import type { NpmUpdateCandidate } from "../runtime/npm-update";
import { inspectNpmInstallation, type NpmProvenance } from "../runtime/npm-update-provenance";
import { runNpmUpdateProcess } from "../runtime/npm-update-process";
import { discardNpmUpdateCandidate, hashNpmArtifact as digest, recordNpmUpdateArtifact } from "./npm-update-artifact";

export async function verifyNpmUpdateCandidate(
  provenance: NpmProvenance, version: string, agentDir: string, signal: AbortSignal,
  options: { environment: EnvironmentMap; run?: typeof runNpmUpdateProcess },
): Promise<NpmUpdateCandidate> {
  signal.throwIfAborted();
  inspectNpmInstallation(provenance, version);
  const run = options.run ?? runNpmUpdateProcess;
  const check = async (executable: string) => {
    const result = await run(executable, ["--version"], { environment: options.environment, signal, timeoutMs: 15_000 });
    if (result.code !== 0 || result.stdout.trim() !== `easyresearch ${version}`) throw new Error("Installed native executable version verification failed.");
  };
  await check(provenance.binary);
  const sha256 = await digest(provenance.binary, signal);
  const nativeDirectory = join(agentDir, "bin");
  await mkdir(nativeDirectory, { recursive: true, mode: 0o700 });
  const directory = await realpath(nativeDirectory);
  const artifactToken = randomUUID();
  const executable = join(directory, `easyresearch-${version}-${sha256.slice(0, 16)}-${artifactToken}${provenance.platform === "win32" ? ".exe" : ""}`);
  const candidate: NpmUpdateCandidate = { executable, version, sha256, runtimeId: "", artifactToken };
  let copied = false;
  try {
    await copyFile(provenance.binary, executable, constants.COPYFILE_EXCL);
    copied = true;
    recordNpmUpdateArtifact(candidate);
    await chmod(executable, 0o700);
    if (await digest(executable, signal) !== sha256 || await digest(provenance.binary, signal) !== sha256) throw new Error("Installed executable changed during staging.");
    inspectNpmInstallation(provenance, version);
    await check(executable);
    signal.throwIfAborted();
    const original = await stat(provenance.binary);
    candidate.runtimeId = `${version}:${original.size}:${original.mtimeMs}`;
    return candidate;
  } catch (error) {
    if (copied) {
      if (error && typeof error === "object" && "custodyUnresolved" in error && error.custodyUnresolved) throw Object.assign(error, { cleanupCandidate: candidate });
      try { await discardNpmUpdateCandidate(candidate); }
      catch (cleanupError) { throw Object.assign(new Error("Candidate cleanup is pending.", { cause: cleanupError }), { cleanupCandidate: candidate }); }
    }
    throw error;
  }
}

export async function revalidateNpmCandidate(candidate: NpmUpdateCandidate, signal: AbortSignal): Promise<void> {
  if (await digest(candidate.executable, signal) !== candidate.sha256) throw new Error("Prepared update executable changed.");
}
