import { createHash } from "node:crypto";
import { directoryAnchor, readBoundedFile } from "./filesystem.js";
import { checkAbort, ensure, evidencePaths, MEMORY_LIMITS, safeError } from "./policy.js";
import type { EvidenceProof } from "./types.js";

/** Hash small inspectable files only; artifact naming remains a Skill concern. */
export async function captureEvidence(cwd: string, paths: string[], signal?: AbortSignal): Promise<EvidenceProof[]> {
  try {
    const acceptedPaths = evidencePaths(paths);
    const proofs: EvidenceProof[] = [];
    let remaining = MEMORY_LIMITS.evidenceTotalBytes;
    for (const path of acceptedPaths) {
      checkAbort(signal);
      const parts = path.split("/");
      const name = parts.pop()!;
      const directory = await directoryAnchor(cwd, parts, false, signal);
      ensure(directory, "EVIDENCE", "Evidence directory is unavailable in the exact project.");
      const bytes = await readBoundedFile(directory, name, Math.min(remaining, MEMORY_LIMITS.evidenceFileBytes), signal, true);
      remaining -= bytes.length;
      proofs.push({ path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    checkAbort(signal);
    return proofs;
  } catch (error) { throw safeError(error); }
}

export async function checkEvidence(cwd: string, proofs: EvidenceProof[], signal?: AbortSignal): Promise<void> {
  // Capture expected bytes before awaiting: callers cannot change the comparison.
  const expected = proofs.map(proof => ({ ...proof }));
  const actual = await captureEvidence(cwd, expected.map(proof => proof.path), signal);
  ensure(actual.every((proof, index) => proof.sha256 === expected[index]!.sha256 && proof.size === expected[index]!.size), "EVIDENCE", "Evidence changed since capture; obtain fresh proposal/verification evidence.");
}
