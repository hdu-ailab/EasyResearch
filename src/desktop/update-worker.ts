/** Compiled, process-only custodian. This graph imports no Pi, Electron or Web runtime. */
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { realpath, rm, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import type { Readable } from "node:stream";
import { dirname, join, win32 } from "node:path";
import { acquireTransitionLease, adoptTransitionLease, serverLeasePath, type RuntimeLease } from "../cli/runtime-lease";
import { backupWindowsInstallation, regularUpdateFile, updateFileHash, writeUpdateJson } from "./update-files";
import { spawnDesktopUpdateOwner, ownDesktopInstallerJob, verifyDesktopSidecarVersion, waitForDesktopUpdateReadiness, exitedWithin, type OwnedDesktopInstaller, type OwnedUpdateProcess } from "./update-process";
import { startWindowsUpdateJob } from "../runtime/windows-update-job";
import { createDesktopSuccessorChannel } from "./update-successor-channel";
import { captureDesktopRollbackDirectories } from "./update-rollback";
import {
  UPDATE_EVENT_PREFIX, UPDATE_SUCCESSOR_ENV, UPDATE_WORKER_ENTRY, UPDATE_WORKER_TOKEN_ENV,
  validateUpdateHandoff, createDesktopRecoveryTicket, windowsNsisArguments, windowsInstallationLocation, validToken,
  desktopUpdateFailure, type DesktopUpdateFailure, type DesktopUpdateOperation,
  type DesktopUpdateHandoff, type DesktopUpdateReceipt, type DesktopUpdateOutcome, type InstalledDesktopIdentity,
} from "./update-protocol";

export async function runUpdateCustody(options: {
  prepare(): Promise<void>;
  awaitCommit(): Promise<boolean>;
  waitForHostExit(): Promise<void>;
  install(admitted: () => void): Promise<void>;
  verify(): Promise<void>;
  startSuccessor(): Promise<void>;
  rollback(): Promise<void>;
  recover(): Promise<void>;
  report(phase: DesktopUpdateReceipt["phase"], outcome: DesktopUpdateOutcome): Promise<void>;
  release(): Promise<void>;
  cancelled?(): boolean;
}): Promise<void> {
  const outcome: DesktopUpdateOutcome = { installerAdmitted: false, hostExited: false, rollback: "not-required", recoveryComplete: false };
  const report = (phase: DesktopUpdateReceipt["phase"]) => options.report(phase, { ...outcome });
  try {
    await options.prepare();
    await report("prepared");
    if (!await options.awaitCommit()) { await report("cancelled"); return; }
    await options.waitForHostExit();
    outcome.hostExited = true;
    await report("installing");
    await options.install(() => { outcome.installerAdmitted = true; });
    await report("verifying");
    await options.verify();
    await options.startSuccessor();
    await report("complete");
  } catch (error) {
    if ((error as { custodyUnresolved?: boolean } | null)?.custodyUnresolved) {
      if (outcome.installerAdmitted) outcome.rollback = "pending";
      await report("failed"); throw error;
    }
    try {
      if (outcome.installerAdmitted) {
        outcome.rollback = "pending";
        await options.rollback();
        outcome.rollback = "complete";
      }
    } catch (cleanup) { await report("failed"); throw cleanup; }
    await report(!outcome.installerAdmitted && options.cancelled?.() ? "cancelled" : "failed");
    if (outcome.hostExited) {
      await options.recover();
      outcome.recoveryComplete = true;
      await report("failed");
    }
    throw error;
  } finally { await options.release(); }
}

/** Entry hook: await runDesktopUpdateWorker(process.argv.slice(2)); before runtime registrations. */
export async function runDesktopUpdateWorker(argv: readonly string[]): Promise<number> {
  const token = process.env[UPDATE_WORKER_TOKEN_ENV];
  delete process.env[UPDATE_WORKER_TOKEN_ENV];
  delete process.env[UPDATE_SUCCESSOR_ENV];
  if (process.platform !== "win32" || process.arch !== "x64" || argv.length !== 1 || argv[0] !== UPDATE_WORKER_ENTRY || !validToken(token)) throw new Error("Invalid Desktop updater entry.");
  // This is the only parent input channel. EOF before commit is cancellation;
  // after commitment both EOF and actual parent death are required before mutation.
  const input = createDesktopUpdateInput(token, process.stdin);
  let handoff: DesktopUpdateHandoff | undefined;
  let lease: RuntimeLease | undefined;
  let installer: OwnedDesktopInstaller | undefined;
  let successor: OwnedUpdateProcess | undefined;
  let identity: InstalledDesktopIdentity | undefined;
  let successorToken: string | undefined;
  let backupComplete = false;
  let ownsBackup = false;
  let successorAccepted = false;
  let recovering = false;
  let ownsQuarantine = false;
  let receiptPhase: DesktopUpdateReceipt["phase"] | undefined;
  let receiptOutcome: DesktopUpdateOutcome | undefined;
  let failure: DesktopUpdateFailure | undefined;
  const observe = async <T>(operation: DesktopUpdateOperation, run: () => T | Promise<T>): Promise<T> => {
    try { return await run(); }
    catch (error) { failure = desktopUpdateFailure(operation, error); throw error; }
  };
  const abort = new AbortController();
  input.onAbort(() => abort.abort());
  let backup = "";
  let registryBackup: Array<{ path: string; sha256: string }> = [];
  const emit = (type: string) => { process.stdout.write(`${UPDATE_EVENT_PREFIX}${JSON.stringify({ type, token })}\n`); };
  process.stdout.on("error", () => {});
  try {
    const raw = await input.prepare();
    handoff = validateUpdateHandoff(raw);
    if (handoff.token !== token || handoff.hostPid !== process.ppid
      || (await realpath(process.execPath)).toLowerCase() !== join(handoff.directory, "custodian.exe").toLowerCase()) throw new Error("Update custodian identity mismatch.");
    const h = handoff;
    lease = adoptTransitionLease(h.agentDir, "desktop", process.pid, token);
    const original = dirname(h.hostPath);
    // One reserved recovery slot per installation bounds retained failed copies.
    // A foreign/unrecovered slot blocks a new update rather than being overwritten.
    backup = `${original}.update-backup`;
    const quarantined = `${original}.update-failed`;
    const installedIdentity = async (): Promise<InstalledDesktopIdentity> => ({
      hostSha256: await updateFileHash(h.hostPath), appSha256: await updateFileHash(join(original, "resources", "app.asar")),
      sidecarSha256: await updateFileHash(join(original, "resources", "sidecar", "easyresearch.exe")),
    });
    const verifyVersion = async (version: string) => {
      const sidecar = join(original, "resources", "sidecar", "easyresearch.exe"); await regularUpdateFile(sidecar);
      await verifyDesktopSidecarVersion(sidecar, version, cleanUpdateEnvironment());
    };
    const launchHost = async (recovery: boolean) => {
      recovering = recovery;
      successorToken = randomBytes(32).toString("base64url");
      if (recovery) {
        const ticket = createDesktopRecoveryTicket(h, identity!, { directory: h.directory, workerPid: process.pid, token: successorToken }, await updateFileHash(join(h.directory, "handoff.json")));
        await writeUpdateJson(join(h.directory, "recovery-handoff.json"), ticket);
      }
      await writeReceipt(h, recovery ? "recovering" : "verifying", identity, successorToken, recovery, installer, false, receiptOutcome);
      const channel = await createDesktopSuccessorChannel(successorToken);
      let transfer: ReturnType<RuntimeLease["reserveHandoff"]> | undefined;
      try {
        transfer = lease!.reserveHandoff(successorToken);
        successor = spawnDesktopUpdateOwner(h.hostPath, [], h.userDataDir, { ...cleanUpdateEnvironment(),
          EASYRESEARCH_CODING_AGENT_DIR: h.agentDir,
          [UPDATE_SUCCESSOR_ENV]: JSON.stringify({ directory: h.directory, token: successorToken, workerPid: process.pid, pipe: channel.path }),
        });
        if (!successor.child.pid) throw new Error("Successor did not spawn.");
        channel.bindChild(successor.child.pid);
        transfer.commit(successor.child.pid);
        const ready = await waitForDesktopUpdateReadiness(channel.ready, successor, 15 * 60_000);
        if (ready.version !== (recovery ? h.currentVersion : h.version) || ready.pid !== successor.child.pid || typeof ready.bootId !== "string"
          || !ready.bootId || ready.bootId === h.oldBootId || !Number.isSafeInteger(ready.sidecarPid) || (ready.sidecarPid as number) <= 0) throw new Error("Successor identity mismatch.");
        transfer.relinquish();
        lease = adoptTransitionLease(h.agentDir, "desktop", process.pid, successorToken);
        await channel.accept();
        successorAccepted = true;
        successor.child.stdin.end();
        successor.child.unref(); successor.child.stdout.destroy(); successor.child.stderr.destroy();
      } catch (error) {
        await channel.close();
        if (successor) await successor.stop();
        if (transfer && !transfer.transferred) transfer.cancel();
        throw error;
      } finally { await channel.close(); }
    };
    await runUpdateCustody({
      async prepare() {
        await verifyPrivateUpdateDirectory(h.directory);
        if (await updateFileHash(process.execPath) !== h.helperSha256 || await updateFileHash(h.hostPath) !== h.oldHostSha256) throw new Error("Update source changed.");
        await verifyInstaller(h);
        await verifyPerUserInstallation(original, h.directory);
        try { await lstat(quarantined); throw new Error("A previous Desktop recovery requires manual attention."); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        registryBackup = await exportInstallationRegistry(h.directory);
        await backupWindowsInstallation(original, backup, abort.signal, () => { ownsBackup = true; });
        if (await updateFileHash(join(backup, "EasyResearch.exe")) !== h.oldHostSha256
          || await updateFileHash(join(backup, "resources", "app.asar")) !== h.oldAppSha256
          || await updateFileHash(join(backup, "resources", "sidecar", "easyresearch.exe")) !== h.oldSidecarSha256) throw new Error("Desktop recovery backup verification failed.");
        backupComplete = true;
        // Close admission was synchronous at the host, but its files remain intact here.
        abort.signal.throwIfAborted();
        input.allowCommit();
        emit("prepared");
      },
      async awaitCommit() {
        const commit = await input.commit();
        if (!commit || abort.signal.aborted) return false;
        emit("committed");
        return true;
      },
      async waitForHostExit() {
        await input.parentEnded();
        const deadline = Date.now() + 30_000;
        while (processAlive(h.hostPid)) {
          abort.signal.throwIfAborted();
          if (Date.now() >= deadline) throw new Error("Previous Desktop host has not exited.");
          await delay(100);
        }
        abort.signal.throwIfAborted();
      },
      async install(admitted) {
        await verifyInstaller(h);
        installer = ownDesktopInstallerJob(await startWindowsUpdateJob(join(h.directory, h.installerName), windowsNsisArguments(original), {
          windowsVerbatimArguments: true, env: cleanUpdateEnvironment(),
        }));
        admitted();
        await writeReceipt(h, "installing", undefined, undefined, false, installer, false, { installerAdmitted: true, hostExited: true, rollback: "not-required", recoveryComplete: false });
        if (!await exitedWithin(installer.treeSettled, 10 * 60_000)) {
          await installer.stop(); throw new Error("Installer timed out.");
        }
        const exit = await installer.treeSettled;
        if (exit.code !== 0 || exit.signal !== null) throw new Error("Installer failed.");
      },
      async verify() {
        await observe("verify-registry", () => verifyPerUserInstallation(original, h.directory));
        await observe("verify-version", () => verifyVersion(h.version));
        identity = await observe("verify-files", installedIdentity);
      },
      startSuccessor: () => launchHost(false),
      async rollback() {
        successorAccepted = false;
        // Never restore under an installer/successor that may still hold files.
        if (successor) await observe("rollback-stop", () => successor!.stop());
        if (installer) await observe("rollback-stop", () => installer!.stop());
        if (!backupComplete) return;
        // A failed successor may have returned/released its startup lease. Reclaim
        // exclusive transition custody before touching installed files, and refuse
        // rollback if a server (including an unverifiable forced-exit record) remains.
        let returned: RuntimeLease | undefined;
        for (const candidateToken of [successorToken, h.token]) {
          if (!candidateToken) continue;
          try { returned = adoptTransitionLease(h.agentDir, "desktop", process.pid, candidateToken); break; }
          catch { /* Only a matching on-disk worker identity can be adopted. */ }
        }
        lease = returned ?? await observe("rollback-lease", () => acquireTransitionLease(h.agentDir, "desktop", { timeoutMs: 0 }));
        await observe("rollback-server", () => waitForUpdateServerRelease(h.agentDir));
        await observe("rollback-quarantine", () => mkdir(quarantined, { mode: 0o700 }));
        ownsQuarantine = true;
        const moves = await observe("rollback-quarantine", () => captureDesktopRollbackDirectories(original, backup, quarantined));
        await observe("rollback-remove-current", () => moves.quarantineCurrent());
        await observe("rollback-restore-files", () => moves.restoreBackup());
        ownsBackup = false;
        backupComplete = false;
        for (const record of registryBackup) {
          await observe("rollback-registry", async () => {
            if (await updateFileHash(record.path) !== record.sha256) throw new Error("Registry backup changed.");
            registryCommand(["import", record.path]);
          });
        }
        await observe("rollback-verify", async () => {
          if (await updateFileHash(h.hostPath) !== h.oldHostSha256) throw new Error("Original Desktop recovery failed.");
        });
      },
      async recover() {
        identity = await observe("recovery-verify", async () => {
          const restored = await installedIdentity();
          if (restored.hostSha256 !== h.oldHostSha256 || restored.appSha256 !== h.oldAppSha256 || restored.sidecarSha256 !== h.oldSidecarSha256) throw new Error("Restored Desktop identity mismatch.");
          return restored;
        });
        await observe("recovery-version", () => verifyVersion(h.currentVersion));
        await observe("recovery-launch", () => launchHost(true));
      },
      async report(phase, outcome) { receiptPhase = phase; receiptOutcome = outcome; await writeReceipt(h, phase, identity, successorToken, recovering, installer, false, outcome, failure); },
      async release() {
        // A failed bounded kill never releases the transition while a child survives.
        // Keep this custodian alive until the real close event; the failure receipt
        // remains available to the next manually launched host.
        if (installer && !installer.treeClosed) await installer.treeSettled;
        if (successor && !successorAccepted) {
          await successor.treeSettled;
          await waitForUpdateServerRelease(h.agentDir);
        }
        if (ownsBackup && ((!installer && !successor) || receiptPhase === "complete" || (successorAccepted && recovering))) {
          // Retaining a recoverable backup is harmless if antivirus still holds it.
          await rm(backup, { recursive: true, force: true }).catch(() => {});
        }
        if (ownsQuarantine && successorAccepted && recovering) await rm(quarantined, { recursive: true, force: true }).catch(() => {});
        if (lease?.held) lease.release();
      },
      cancelled: () => abort.signal.aborted,
    });
    return 0;
  } catch (error) {
    const unresolved = (error as { custodyUnresolved?: boolean } | null)?.custodyUnresolved === true;
    if (handoff) await writeReceipt(handoff, abort.signal.aborted && !installer ? "cancelled" : "failed", identity, successorToken, recovering, installer, unresolved, receiptOutcome, failure).catch(() => {});
    if (unresolved && lease?.held) {
      // Persist an unresolved handoff guard: worker death must not let another
      // launcher mistake an unverified descendant tree for a completed transition.
      try { lease.reserveHandoff(randomBytes(32).toString("base64url")); } catch { /* Existing guards remain fail-closed. */ }
    } else if (lease?.held && (!installer || installer.treeClosed) && (!successor || successor.treeClosed)) lease.release();
    return 1;
  } finally { input.dispose(); }
}

async function verifyInstaller(h: DesktopUpdateHandoff): Promise<void> {
  const path = join(h.directory, h.installerName);
  if (await regularUpdateFile(path) !== h.installerSize || await updateFileHash(path) !== h.installerSha256) throw new Error("Installer verification failed.");
}

async function writeReceipt(h: DesktopUpdateHandoff, phase: DesktopUpdateReceipt["phase"], identity?: InstalledDesktopIdentity, successorToken?: string, recovery = false, installer?: Pick<OwnedUpdateProcess, "child" | "treeClosed">, unresolved = false, outcome?: DesktopUpdateOutcome, failure?: DesktopUpdateFailure): Promise<void> {
  await writeUpdateJson(join(h.directory, "receipt.json"), { phase, operationId: h.operationId, version: h.version, workerPid: process.pid,
    ...(identity ? { identity } : {}), ...(successorToken ? { successorToken } : {}),
    ...(recovery ? { recovery: true } : {}),
    ...(installer?.child.pid ? { installerGuardPid: installer.child.pid } : {}),
    ...(installer?.treeClosed ? { installerSettled: true } : {}),
    ...(unresolved ? { custodyUnresolved: true } : {}),
    ...(outcome ? { outcome } : {}),
    ...(failure ? { failure } : {}),
    ...(phase === "failed" ? { message: "Installation failed. Open latest Release." } : {}),
  } satisfies DesktopUpdateReceipt);
}

export async function verifyPrivateUpdateDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory)).toLowerCase() !== directory.toLowerCase()
    || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("Update staging is not private.");
}

function cleanUpdateEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("EASYRESEARCH_DESKTOP_") || key === "ELECTRON_RUN_AS_NODE" || key === "NODE_OPTIONS") delete env[key];
  return env;
}

export function windowsInstallerRegistryId(): string {
  // electron-builder 26.15.2 UUID.v5(appId, ELECTRON_BUILDER_NS_UUID), no SDK runtime.
  const digest = createHash("sha1").update(Buffer.from("50e065bc313411e69bab38c9862bdaf3", "hex")).update("ai.easyresearch.desktop").digest().subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50; digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function registryCommand(args: string[]): string {
  const result = spawnSync(win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe"), args, { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
  if (result.error || result.status !== 0 || result.signal !== null) throw new Error("Per-user installation registry check failed.");
  return result.stdout;
}

async function verifyPerUserInstallation(directory: string, staging: string): Promise<void> {
  const probe = join(staging, "registry-probe.reg");
  registryCommand(["export", `HKCU\\Software\\${windowsInstallerRegistryId()}`, probe]);
  try {
    await regularUpdateFile(probe, 64 * 1024);
    const location = windowsInstallationLocation(await readFile(probe));
    if (win32.resolve(location).toLowerCase() !== win32.resolve(directory).toLowerCase()) throw new Error("Only the existing per-user installation can be updated automatically.");
  } finally { await unlink(probe); }
}

async function exportInstallationRegistry(directory: string): Promise<Array<{ path: string; sha256: string }>> {
  // Hashes are filled from exact exported bytes before any installer starts.
  const keys = [`HKCU\\Software\\${windowsInstallerRegistryId()}`, `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${windowsInstallerRegistryId()}`];
  const records: Array<{ path: string; sha256: string }> = [];
  for (const [index, key] of keys.entries()) {
    const path = join(directory, `registry-${index}.reg`);
    registryCommand(["export", key, path]);
    // The read is bounded by the tiny, fixed application-only registry subtree.
    const result = spawnSync(win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe"), ["query", key, "/s"], { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
    if (result.error || result.status !== 0) throw new Error("Installation registry backup failed.");
    await regularUpdateFile(path, 64 * 1024);
    records.push({ path, sha256: await updateFileHash(path) });
  }
  return records;
}

function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForUpdateServerRelease(agentDir: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (true) {
    try { await lstat(serverLeasePath(agentDir)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (Date.now() >= deadline) throw Object.assign(new Error("Desktop sidecar cleanup could not be verified."), { custodyUnresolved: true });
    await delay(100);
  }
}

export function createDesktopUpdateInput(token: string, stdin: Readable, timeoutMs = 120_000) {
  let buffer = ""; let total = 0; let ended = false; let committed = false; let cancelled = false;
  let prepared = false;
  let canCommit = false;
  let abort: (() => void) | undefined;
  let resolvePrepare!: (value: unknown) => void; let rejectPrepare!: (error: Error) => void;
  let resolveCommit!: (value: boolean) => void; let resolveEnd!: () => void;
  const prepare = new Promise<unknown>((resolve, reject) => { resolvePrepare = resolve; rejectPrepare = reject; });
  const commit = new Promise<boolean>((resolve) => { resolveCommit = resolve; });
  const end = new Promise<void>((resolve) => { resolveEnd = resolve; });
  const cancel = () => { cancelled = true; abort?.(); resolveCommit(false); rejectPrepare(new Error("Update parent disconnected.")); };
  const finish = () => { ended = true; resolveEnd(); if (!committed) cancel(); };
  const data = (chunk: Buffer) => {
    total += chunk.length;
    if (total > 32 * 1024) { cancel(); return; }
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const event = JSON.parse(line);
        if (cancelled || event.token !== token) throw new Error("Invalid updater parent message.");
        if (event.type === "prepare" && !prepared) { prepared = true; resolvePrepare(event.handoff); }
        else if (event.type === "commit" && prepared && canCommit && !committed) { committed = true; resolveCommit(true); }
        else if (event.type === "abort") cancel();
        else throw new Error("Invalid updater parent phase.");
      } catch { cancel(); }
    }
  };
  const timer = setTimeout(cancel, timeoutMs);
  stdin.on("data", data); stdin.once("end", finish); stdin.once("error", cancel); stdin.resume();
  return {
    prepare: () => prepare,
    allowCommit() { canCommit = true; },
    commit: async () => { const accepted = await commit; if (accepted) clearTimeout(timer); return accepted; },
    parentEnded: async () => {
      if (ended) return;
      if (!await exitedWithin(end, 30_000)) throw new Error("Update host did not release its parent pipe.");
    },
    onAbort(callback: () => void) { abort = callback; if (cancelled) abort(); },
    dispose() { clearTimeout(timer); stdin.removeListener("data", data); stdin.removeListener("end", finish); stdin.removeListener("error", cancel); stdin.pause(); },
  };
}
