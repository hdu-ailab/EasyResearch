import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { opendir, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { NpmUpdateCandidate } from "../runtime/npm-update";

interface ArtifactReceipt {
  schema: 1;
  executable: string;
  version: string;
  sha256: string;
  token: string;
  creatorPid: number;
  state: "staged" | "active" | "retired";
}
const NAME = /^easyresearch-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-([a-f0-9]{16})-([a-f0-9-]{36})(?:\.exe)?$/;
const receiptPath = (executable: string) => join(dirname(executable), `.${basename(executable)}.npm-update.json`);
const ownersPath = (executable: string) => `${receiptPath(executable)}.owners`;
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function regularJson(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid executable ownership receipt.");
  return JSON.parse(readFileSync(path, "utf8"));
}
function readReceipt(executable: string): ArtifactReceipt | undefined {
  const match = NAME.exec(basename(executable));
  if (!match || basename(dirname(executable)) !== "bin" || realpathSync(dirname(executable)) !== resolve(dirname(executable))) return undefined;
  const path = receiptPath(executable);
  if (!existsSync(path)) return undefined;
  const value = regularJson(path) as ArtifactReceipt;
  if (value.schema !== 1 || value.executable !== basename(executable) || value.version !== match[1] || value.token !== match[3]
    || !/^[a-f0-9]{64}$/.test(value.sha256) || !value.sha256.startsWith(match[2]!)
    || !Number.isSafeInteger(value.creatorPid) || value.creatorPid <= 0 || !["staged", "active", "retired"].includes(value.state)) throw new Error("Invalid executable ownership receipt.");
  return value;
}
function replaceReceipt(executable: string, receipt: ArtifactReceipt): void {
  const path = receiptPath(executable); const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(receipt), { flag: "wx", mode: 0o600 }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

export function recordNpmUpdateArtifact(candidate: NpmUpdateCandidate): void {
  const token = NAME.exec(basename(candidate.executable))?.[3];
  if (!token || token !== candidate.artifactToken) throw new Error("Invalid staged executable identity.");
  const receipt: ArtifactReceipt = { schema: 1, executable: basename(candidate.executable), version: candidate.version, sha256: candidate.sha256, token, creatorPid: process.pid, state: "staged" };
  writeFileSync(receiptPath(candidate.executable), JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
}

/** Each daemon and process-only shell worker keeps a separate, bounded-size use receipt. */
export function registerNpmArtifactProcess(executable: string): { retire(): void; close(): void } | undefined {
  const receipt = readReceipt(executable);
  if (!receipt) return undefined;
  if (receipt.state === "retired") throw new Error("The runtime executable has been retired.");
  const directory = ownersPath(executable);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== resolve(directory)) throw new Error("Invalid executable use directory.");
  pruneOwnerPage(executable, receipt.token);
  const ownerPath = join(directory, `${randomUUID()}.json`);
  writeFileSync(ownerPath, JSON.stringify({ schema: 1, pid: process.pid, artifactToken: receipt.token }), { flag: "wx", mode: 0o600 });
  if (receipt.state === "staged") replaceReceipt(executable, { ...receipt, state: "active" });
  return {
    retire() {
      const current = readReceipt(executable);
      if (!current || current.token !== receipt.token) throw new Error("Executable ownership changed.");
      replaceReceipt(executable, { ...current, state: "retired" });
    },
    close() {
      // The native process still executes briefly after its finalizer. Retain
      // its PID receipt until a later owner can prove actual process death.
      if (resolve(executable) !== resolve(process.execPath)) rmSync(ownerPath, { force: true });
    },
  };
}

function ownerRecord(path: string, token: string): { pid: number } {
  if (!/^[a-f0-9-]{36}\.json$/.test(basename(path))) throw new Error("Unknown executable owner.");
  const owner = regularJson(path) as { schema: number; pid: number; artifactToken: string };
  if (owner.schema !== 1 || owner.artifactToken !== token || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid executable owner.");
  return owner;
}

/** Bound work on every worker admission, so completed-worker receipts do not pile up. */
function pruneOwnerPage(executable: string, token: string): void {
  const directory = ownersPath(executable); const entries = opendirSync(directory, { bufferSize: 64 });
  try {
    for (let count = 0; count < 64; count++) {
      const entry = entries.readSync(); if (!entry) break;
      const path = join(directory, entry.name);
      try { if (!alive(ownerRecord(path, token).pid)) rmSync(path); } catch { /* Live or unverifiable guards remain. */ }
    }
  } finally { entries.closeSync(); }
}

async function inspectOwners(executable: string, token: string, signal: AbortSignal): Promise<{ busy: boolean; complete: boolean }> {
  const directory = ownersPath(executable);
  if (!existsSync(directory)) return { busy: false, complete: true };
  if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== resolve(directory)) throw new Error("Invalid executable use directory.");
  const entries = await opendir(directory, { bufferSize: 128 });
  const deadline = performance.now() + 5000;
  let busy = false;
  for await (const entry of entries) {
    if (signal.aborted || performance.now() >= deadline) return { busy: true, complete: false };
    const path = join(directory, entry.name);
    try {
      if (alive(ownerRecord(path, token).pid)) busy = true;
      else rmSync(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") busy = true; }
  }
  return { busy, complete: true };
}

export async function hashNpmArtifact(path: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const hash = createHash("sha256"); const stream = createReadStream(path);
  const abort = () => { stream.destroy(new Error("Candidate verification cancelled.")); };
  signal.addEventListener("abort", abort, { once: true });
  try { for await (const chunk of stream) hash.update(chunk); signal.throwIfAborted(); return hash.digest("hex"); }
  finally { signal.removeEventListener("abort", abort); stream.destroy(); }
}

/** Call only with the in-memory candidate after its process custody has settled. */
export async function discardNpmUpdateCandidate(candidate: NpmUpdateCandidate, signal = AbortSignal.timeout(30_000)): Promise<void> {
  if (!candidate.artifactToken) return; // Legacy/unreceipted files are never inferred as owned.
  const receipt = readReceipt(candidate.executable);
  const match = NAME.exec(basename(candidate.executable));
  if (!match || match[3] !== candidate.artifactToken || (receipt && (receipt.token !== candidate.artifactToken || receipt.sha256 !== candidate.sha256))) throw new Error("Staged executable ownership changed.");
  if (resolve(candidate.executable) === resolve(process.execPath)) throw new Error("Cannot remove the executing runtime.");
  const owners = await inspectOwners(candidate.executable, candidate.artifactToken, signal);
  if (owners.busy || !owners.complete) throw new Error("The staged executable is still in use or its use could not be fully inspected.");
  if (receipt && receipt.state !== "retired") replaceReceipt(candidate.executable, { ...receipt, state: "retired" });
  if (existsSync(candidate.executable)) {
    const before = lstatSync(candidate.executable);
    if (!before.isFile() || realpathSync(candidate.executable) !== resolve(candidate.executable)
      || await hashNpmArtifact(candidate.executable, signal) !== candidate.sha256) throw new Error("Staged executable bytes changed.");
    const after = lstatSync(candidate.executable);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Staged executable changed during disposal.");
    await unlink(candidate.executable);
  }
  if (existsSync(ownersPath(candidate.executable))) rmdirSync(ownersPath(candidate.executable));
  rmSync(receiptPath(candidate.executable), { force: true });
}

/** Demand-driven reclamation. Locked Windows files retain receipts for the next operation. */
export async function reclaimNpmUpdateArtifacts(agentDir: string): Promise<void> {
  const signal = AbortSignal.timeout(5000);
  const nativeDirectory = join(agentDir, "bin");
  if (!existsSync(nativeDirectory)) return;
  const directory = realpathSync(nativeDirectory);
  const names = readdirSync(directory);
  if (names.length > 8192) return;
  for (const name of names) {
    if (signal.aborted) break;
    if (!name.startsWith(".easyresearch-") || !name.endsWith(".npm-update.json")) continue;
    const executable = join(directory, name.slice(1, -".npm-update.json".length));
    try {
      const receipt = readReceipt(executable);
      if (!receipt) continue;
      const owners = await inspectOwners(executable, receipt.token, signal);
      if (owners.busy || !owners.complete) continue;
      // Only a completed terminal shutdown grants retirement. A crashed or
      // interrupted staging/launch phase has no inferred disposal authority.
      if (receipt.state !== "retired") continue;
      await discardNpmUpdateCandidate({ executable, version: receipt.version, sha256: receipt.sha256, runtimeId: "", artifactToken: receipt.token }, signal);
    } catch { /* Unproven use, changed bytes or locks retain their durable ownership receipt. */ }
  }
}
