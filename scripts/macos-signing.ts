import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

function runCodesign(args: string[]): void {
  const result = spawnSync("/usr/bin/codesign", args, {
    encoding: "utf8",
    timeout: 180_000,
    killSignal: "SIGKILL",
  });
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error(
      `codesign ${args.join(" ")} failed (exit ${result.status ?? "none"}, signal ${result.signal ?? "none"}): `
      + `${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
      { cause: result.error },
    );
  }
}

/** Finalize Mach-O bytes before native smoke or manifest hashing. */
export function signMacOsBinary(binary: string): void {
  // Bun's generated ad-hoc signature can hash a zero-padded final page (#7).
  // Re-sign the finished executable with Apple's tool, never an accepted copy.
  runCodesign(["--force", "--sign", "-", "--timestamp=none", binary]);
  verifyMacOsSignature(binary);
}

export function verifyMacOsSignature(path: string, deep = false): void {
  runCodesign(["--verify", "--strict", "--verbose=2", ...(deep ? ["--deep"] : []), path]);
}

/** Verification only: packaging and smoke must not repair or replace the sidecar. */
export function verifyMacOsBundle(app: string, acceptedBinary: string): void {
  const sidecar = posix.join(app, "Contents", "Resources", "sidecar", "easyresearch");
  if (!readFileSync(sidecar).equals(readFileSync(acceptedBinary))) {
    throw new Error(`Packaged macOS sidecar does not match the accepted native binary: ${sidecar}`);
  }
  verifyMacOsSignature(sidecar);
  verifyMacOsSignature(app, true);
}
