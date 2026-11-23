import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, readFile, opendir, realpath, rename } from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import { acquireTransitionLease, adoptTransitionLease, waitForTransitionLeaseOwnership, type RuntimeLease } from "../cli/runtime-lease";
import type { DesktopDownloadedUpdate } from "./update";
import { DesktopUpdateCleanupError, type DesktopUpdateCustodian } from "./update-install";
import { regularUpdateFile, writeUpdateJson, type UpdateFileHasher } from "./update-files";
import { spawnDesktopUpdateOwner, type OwnedUpdateProcess } from "./update-process";
import { cleanupDesktopUpdateStaging } from "./update-staging";
import {
  UPDATE_EVENT_PREFIX, UPDATE_SUCCESSOR_ENV, UPDATE_WORKER_ENTRY, UPDATE_WORKER_TOKEN_ENV,
  validateUpdateHandoff, validateDesktopRecoveryTicket, canReclaimDesktopUpdateReceipt, validToken, validDigest,
  type DesktopUpdateHandoff, type DesktopUpdateReceipt, type DesktopUpdateSuccessor,
} from "./update-protocol";

export async function prepareDesktopUpdateCustodian(options: {
  update: DesktopDownloadedUpdate;
  sidecarPath: string;
  hostPath: string;
  userDataDir: string;
  agentDir: string;
  currentVersion: string;
  oldBootId: string;
  route: string;
  signal: AbortSignal;
  hashFile: UpdateFileHasher;
  /** The host retains every spawned helper until exit or explicit commitment. */
  retain(handle: DesktopUpdateCustodian): void;
  accepted(): void;
  released(): void;
}): Promise<DesktopUpdateCustodian> {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Automatic installation is unavailable on this platform.");
  options.signal.throwIfAborted();
  const { update } = options;
  const token = randomBytes(32).toString("base64url");
  const helperPath = join(update.directory, "custodian.exe");
  const hostPath = await realpath(options.hostPath);
  const userDataDir = await realpath(options.userDataDir);
  if ((await realpath(options.sidecarPath)).toLowerCase() !== join(dirname(hostPath), "resources", "sidecar", "easyresearch.exe").toLowerCase()) throw new Error("Unknown Desktop installation layout.");
  const sourceHash = await options.hashFile(options.sidecarPath);
  await copyFile(options.sidecarPath, helperPath, constants.COPYFILE_EXCL);
  if (await options.hashFile(helperPath) !== sourceHash) throw new Error("Update helper copy verification failed.");
  const h: DesktopUpdateHandoff = validateUpdateHandoff({ schema: 1, token, operationId: update.operationId,
    hostPid: process.pid, hostPath, userDataDir, agentDir: options.agentDir, directory: update.directory,
    currentVersion: options.currentVersion, version: update.version, installerName: update.asset.name,
    installerSize: update.asset.size, installerSha256: update.asset.sha256, helperSha256: sourceHash,
    oldHostSha256: await options.hashFile(hostPath), oldAppSha256: await options.hashFile(join(dirname(hostPath), "resources", "app.asar")), oldSidecarSha256: sourceHash,
    oldBootId: options.oldBootId, route: options.route, expiresAt: Date.now() + 20 * 60_000 });
  await writeUpdateJson(join(update.directory, "handoff.json"), h);
  options.signal.throwIfAborted();
  const lease = await acquireTransitionLease(options.agentDir, "desktop");
  let child: OwnedUpdateProcess | undefined;
  let committed = false;
  let aborting: Promise<void> | undefined;
  const transfer = (() => {
    try { return lease.reserveHandoff(token); }
    catch (error) { lease.release(); throw error; }
  })();
  const abort = (): Promise<void> => {
    if (aborting) return aborting;
    const attempt = (async () => {
      if (child && !child.treeClosed) {
        if (!child.closed) await child.send({ type: "abort", token }).catch(() => {});
        await child.stop();
      }
      if (!transfer.transferred) transfer.cancel();
      if (lease.held) lease.release();
      await cleanupDesktopUpdateStaging(update.directory, update.asset.name, true);
      options.released();
    })();
    aborting = attempt;
    void attempt.catch(() => { if (aborting === attempt) aborting = undefined; });
    return attempt;
  };
  const onAbort = () => { void abort().catch(() => { /* The result-bearing owner retries and reports cleanup failures. */ }); };
  const handle: DesktopUpdateCustodian = {
    get exited() { return child?.treeSettled; },
    async commit() {
      options.signal.throwIfAborted();
      if (!child || child.closed || committed || aborting) throw new Error("Update custody is no longer available.");
      await child.send({ type: "commit", token });
      await child.event("committed", token, 10_000);
      options.signal.throwIfAborted();
      committed = true;
      options.signal.removeEventListener("abort", onAbort);
      transfer.relinquish();
      // No unowned installer spawn: the helper now owns the transition, and only
      // actual host death authorizes installation. Keep the parent-life pipe open.
      child.child.unref();
    },
    abort: async () => { options.signal.removeEventListener("abort", onAbort); if (!committed) await abort(); },
  };
  try {
    child = spawnDesktopUpdateOwner(helperPath, [UPDATE_WORKER_ENTRY], userDataDir,
      { ...process.env, [UPDATE_WORKER_TOKEN_ENV]: token });
    options.retain(handle);
    if (!child.child.pid) throw new Error("Update helper did not spawn.");
    transfer.commit(child.child.pid);
    options.signal.addEventListener("abort", onAbort, { once: true });
    options.signal.throwIfAborted();
    await child.send({ type: "prepare", token, handoff: h });
    await child.event("prepared", token, 120_000);
    options.accepted();
    options.signal.throwIfAborted();
    return handle;
  } catch (error) {
    options.signal.removeEventListener("abort", onAbort);
    try { await abort(); }
    catch (cleanup) { throw new DesktopUpdateCleanupError([error, cleanup]); }
    throw error;
  }
}

export function consumeDesktopUpdateSuccessor(env: NodeJS.ProcessEnv): DesktopUpdateSuccessor | undefined {
  const raw = env[UPDATE_SUCCESSOR_ENV]; delete env[UPDATE_SUCCESSOR_ENV];
  if (raw === undefined) return undefined;
  if (raw.length > 8192) throw new Error("Invalid update successor.");
  const value = JSON.parse(raw) as DesktopUpdateSuccessor;
  if (!value || Object.keys(value).sort().join(",") !== "directory,token,workerPid" || !validToken(value.token)
    || typeof value.directory !== "string" || !isAbsolute(value.directory) || !Number.isSafeInteger(value.workerPid) || value.workerPid <= 0) throw new Error("Invalid update successor.");
  return value;
}

export async function acceptDesktopUpdateSuccessor(context: DesktopUpdateSuccessor, host: { hostPath: string; userDataDir: string; version: string; hashFile: UpdateFileHasher }): Promise<{ lease: RuntimeLease; handoff: DesktopUpdateHandoff; recovery: boolean; finish(): Promise<void>; ready(bootId: string, sidecarPid: number): void }> {
  await regularUpdateFile(join(context.directory, "handoff.json"), 32 * 1024);
  await regularUpdateFile(join(context.directory, "receipt.json"), 32 * 1024);
  const receipt = JSON.parse(await readFile(join(context.directory, "receipt.json"), "utf8")) as DesktopUpdateReceipt;
  const identity = receipt.identity;
  const recovery = receipt.recovery === true;
  const h = validateUpdateHandoff(JSON.parse(await readFile(join(context.directory, "handoff.json"), "utf8")), Date.now(), recovery);
  const installedVersion = recovery ? h.currentVersion : h.version;
  if (process.platform !== "win32" || context.workerPid !== process.ppid || context.directory !== h.directory
    || (await realpath(host.userDataDir)).toLowerCase() !== h.userDataDir.toLowerCase()
    || (await realpath(host.hostPath)).toLowerCase() !== h.hostPath.toLowerCase() || host.version !== installedVersion
    || receipt.version !== h.version || receipt.operationId !== h.operationId || receipt.phase !== (recovery ? "recovering" : "verifying")
    || receipt.workerPid !== context.workerPid || receipt.successorToken !== context.token || !identity
    || ![identity.hostSha256, identity.appSha256, identity.sidecarSha256].every(validDigest)) throw new Error("Installed Desktop identity mismatch.");
  if (recovery && (identity.hostSha256 !== h.oldHostSha256 || identity.appSha256 !== h.oldAppSha256 || identity.sidecarSha256 !== h.oldSidecarSha256)) throw new Error("Recovery Desktop identity mismatch.");
  if (recovery) {
    if (!receipt.outcome?.hostExited || receipt.outcome.rollback !== (receipt.outcome.installerAdmitted ? "complete" : "not-required")) throw new Error("Recovery completion evidence is missing.");
    const path = join(context.directory, "recovery-handoff.json"); await regularUpdateFile(path, 16 * 1024);
    validateDesktopRecoveryTicket(JSON.parse(await readFile(path, "utf8")), h, identity, context, await host.hashFile(join(context.directory, "handoff.json")));
  }
  const original = dirname(h.hostPath);
  if (await host.hashFile(h.hostPath) !== identity.hostSha256
    || await host.hashFile(join(original, "resources", "app.asar")) !== identity.appSha256
    || await host.hashFile(join(original, "resources", "sidecar", "easyresearch.exe")) !== identity.sidecarSha256) throw new Error("Installed Desktop file verification failed.");
  await waitForTransitionLeaseOwnership(h.agentDir, "desktop", process.pid, context.token);
  const lease = adoptTransitionLease(h.agentDir, "desktop", process.pid, context.token);
  return { lease, handoff: h, recovery,
    async finish() {
      const deadline = Date.now() + 30_000;
      while (processAlive(context.workerPid)) {
        if (Date.now() >= deadline) return; // A live helper keeps its files; next startup retries.
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await regularUpdateFile(join(h.directory, "receipt.json"), 32 * 1024);
      const final = JSON.parse(await readFile(join(h.directory, "receipt.json"), "utf8")) as DesktopUpdateReceipt;
      if (!canReclaimDesktopUpdateReceipt(final)) return;
      await cleanupDesktopUpdateStaging(h.directory, h.installerName);
    },
    ready(bootId, sidecarPid) {
      if (!bootId || bootId === h.oldBootId || !Number.isSafeInteger(sidecarPid) || sidecarPid <= 0) throw new Error("Update sidecar readiness mismatch.");
      // The sidecar kept this exact lease through its authenticated readiness.
      // Return it to the custodian only after the installed host also loaded.
      const transfer = lease.reserveHandoff(context.token);
      transfer.commit(context.workerPid);
      transfer.relinquish();
      process.stdout.write(`${UPDATE_EVENT_PREFIX}${JSON.stringify({ type: "successor-ready", token: context.token, version: installedVersion, pid: process.pid, bootId, sidecarPid })}\n`);
    },
  };
}

/** Startup consumes bounded private receipts only; a stale installer is never replayed. */
export async function desktopUpdateRecovery(userDataDir: string, isAlive = processAlive): Promise<boolean> {
  const root = join(userDataDir, "updates");
  let children;
  try { children = await opendir(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  let failed = false;
  let inspected = 0;
  for await (const entry of children) {
    if (++inspected > 64) break;
    if (!entry.isDirectory() || !/^update-[A-Za-z0-9]+$/u.test(entry.name)) continue;
    const path = join(root, entry.name, "receipt.json");
    try {
      await regularUpdateFile(path, 32 * 1024);
      const receipt = JSON.parse(await readFile(path, "utf8")) as DesktopUpdateReceipt;
      if (!["complete", "cancelled", "failed", "prepared", "installing", "verifying", "recovering"].includes(receipt.phase)) continue;
      if (!Number.isSafeInteger(receipt.workerPid) || receipt.workerPid <= 0) continue;
      if (isAlive(receipt.workerPid)) continue;
      const handoffPath = join(root, entry.name, "handoff.json");
      await regularUpdateFile(handoffPath, 32 * 1024);
      const handoff = validateUpdateHandoff(JSON.parse(await readFile(handoffPath, "utf8")), Date.now(), true);
      if (handoff.directory !== join(root, entry.name) || handoff.userDataDir !== userDataDir
        || handoff.operationId !== receipt.operationId || handoff.version !== receipt.version) continue;
      if (!canReclaimDesktopUpdateReceipt(receipt)) {
        failed = true; continue;
      }
      if (receipt.phase !== "complete" && receipt.phase !== "cancelled") failed = true;
      await cleanupDesktopUpdateStaging(handoff.directory, handoff.installerName);
    } catch { /* Malformed/unowned receipts never grant install or removal authority. */ }
  }
  return failed;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
