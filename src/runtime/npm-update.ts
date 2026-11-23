import { randomUUID } from "node:crypto";
import { isNewerVersion } from "../web/update-check";
import { LATEST_RELEASE_PAGE, type UpdateAction, type UpdateActionResult, type UpdateController, type UpdateSnapshot } from "./update-contract";
import { stableNpmVersion } from "./npm-update-provenance";

export interface NpmUpdateCandidate { executable: string; version: string; runtimeId: string; sha256: string; artifactToken?: string }
export interface NpmUpdateLease { release(): boolean | void }
export interface NpmUpdateDependencies {
  owner: "cli" | "desktop";
  currentVersion: string;
  capability(): { available: boolean; reason?: string };
  manualCommand(version: string): string | undefined;
  latest(signal: AbortSignal): Promise<string>;
  reserve(): Promise<NpmUpdateLease>;
  install(version: string, signal: AbortSignal): Promise<void>;
  verify(version: string, signal: AbortSignal): Promise<NpmUpdateCandidate>;
  discard(candidate: NpmUpdateCandidate): Promise<void>;
  busy(): Extract<UpdateActionResult, { code: string }>;
  beginShutdown(): void;
  /** Synchronously transfers the held lease/candidate to the existing CLI successor owner. */
  activate(candidate: NpmUpdateCandidate, lease: NpmUpdateLease): void;
}
export class NpmUpdateError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Operation ownership is independent of HTTP/SSE view lifetimes. */
export class NpmUpdateController implements UpdateController {
  private value: UpdateSnapshot;
  private readonly listeners = new Set<(snapshot: UpdateSnapshot) => void>();
  private task?: Promise<void>;
  private abort?: AbortController;
  private lease?: NpmUpdateLease;
  private candidate?: NpmUpdateCandidate;
  private disposal?: Promise<void>;
  private closed = false;
  private cancelling = false;
  private custodyFailure?: unknown;
  constructor(private readonly dependencies: NpmUpdateDependencies) {
    this.value = { revision: 0, operationId: null, owner: dependencies.owner, phase: "idle", currentVersion: dependencies.currentVersion, latestVersion: null, canDownload: false, canInstall: false, canActivate: false, canCancel: false, releaseUrl: LATEST_RELEASE_PAGE,
      message: dependencies.owner === "desktop" ? "Use the Desktop update controls." : dependencies.capability().reason,
      manualCommand: dependencies.manualCommand("latest"),
    };
  }
  snapshot(): UpdateSnapshot { return { ...this.value }; }
  subscribe(listener: (snapshot: UpdateSnapshot) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private publish(patch: Partial<UpdateSnapshot>): void {
    this.value = { ...this.value, ...patch, revision: this.value.revision + 1 };
    for (const listener of this.listeners) { try { listener(this.snapshot()); } catch { /* Views do not own the operation. */ } }
  }
  async action(request: UpdateAction): Promise<UpdateActionResult> {
    if (this.closed) throw new NpmUpdateError(409, "UPDATE_CLOSED", "The runtime is stopping.");
    if (this.cancelling || this.custodyFailure) throw new NpmUpdateError(409, "UPDATE_BUSY", "Update cleanup is still in progress.");
    if (request.action !== "check" && (!request.operationId || request.operationId !== this.value.operationId)) {
      throw new NpmUpdateError(409, "UPDATE_STALE", "Update state changed. Check again.");
    }
    if (request.action === "cancel") {
      if (!this.value.canCancel) throw new NpmUpdateError(409, "UPDATE_UNAVAILABLE", "This update cannot be cancelled.");
      this.cancelling = true;
      this.abort?.abort();
      this.publish({ canCancel: false, canActivate: false, canInstall: false, message: "Cancelling the update and waiting for installer cleanup." });
      try {
        await this.task;
        await this.discardCandidate();
        this.release();
        this.publish({ phase: "cancelled", canCancel: false, canActivate: false, canInstall: false, message: "Update cancelled. Package changes may already have been written; the running version is unchanged." });
      } catch {
        this.publish({ phase: "failed", canCancel: !this.custodyFailure, canActivate: false, message: "Update cleanup is pending. Close any process using the staged executable and try Cancel again." });
        throw new NpmUpdateError(409, "UPDATE_CLEANUP_PENDING", "Update cleanup has not completed.");
      } finally { this.cancelling = false; }
      return this.snapshot();
    }
    if (this.task || ["checking", "installing", "verifying", "activating"].includes(this.value.phase)) throw new NpmUpdateError(409, "UPDATE_BUSY", "An update operation is already active.");
    if (request.action === "check") {
      if (this.lease) throw new NpmUpdateError(409, "UPDATE_BUSY", "Activate or cancel the prepared update first.");
      this.candidate = undefined;
      this.abort = new AbortController();
      this.publish({ operationId: randomUUID(), phase: "checking", latestVersion: null, canInstall: false, canActivate: false, canCancel: true, message: undefined, manualCommand: this.dependencies.manualCommand("latest") });
      this.start(async (signal) => {
        const version = await this.dependencies.latest(signal);
        signal.throwIfAborted();
        if (!stableNpmVersion(version)) throw new Error("Invalid registry version");
        const capability = this.dependencies.capability();
        const available = isNewerVersion(version, this.value.currentVersion);
        this.publish({ latestVersion: version, phase: available ? "available" : "current", canCancel: false,
          canInstall: available && capability.available && this.dependencies.owner === "cli",
          message: this.dependencies.owner === "desktop" ? "Use the Desktop update controls." : capability.reason,
          manualCommand: this.dependencies.manualCommand(version) });
      }, "Update check failed. Try again or use the manual command.");
      return this.snapshot();
    }
    if (request.action === "install" && this.value.canInstall && this.value.latestVersion) {
      const version = this.value.latestVersion;
      this.abort = new AbortController();
      this.publish({ phase: "installing", canInstall: false, canCancel: true, message: "Installing the selected npm package. The running version remains available." });
      this.start(async (signal) => {
        this.lease = await this.dependencies.reserve();
        signal.throwIfAborted();
        await this.dependencies.install(version, signal);
        signal.throwIfAborted();
        this.publish({ phase: "verifying", message: "Package installation completed. Verifying the installed executable." });
        const candidate = await this.dependencies.verify(version, signal);
        this.candidate = candidate;
        signal.throwIfAborted();
        if (candidate.version !== version) throw new Error("Candidate version changed");
        this.publish({ phase: "ready", canActivate: true, canCancel: true, message: "Installed and verified. Activate to stop owned work and start the new version." });
      }, "npm update or verification failed. The running version is unchanged. Check installation permissions and use the manual command.");
      return this.snapshot();
    }
    if (request.action === "activate" && this.value.canActivate && this.candidate && this.lease) {
      const busy = this.dependencies.busy();
      if (!request.force && (busy.activeSessions > 0 || busy.authFlowActive)) return busy;
      // No await between the final busy sample, admission fence and owner transfer.
      try {
        this.dependencies.beginShutdown();
        this.publish({ phase: "activating", canActivate: false, canCancel: false, message: "Stopping owned work and starting the verified version." });
        this.dependencies.activate(this.candidate, this.lease);
        this.lease = undefined;
        this.candidate = undefined; // The existing successor owner now owns these bytes.
      } catch {
        try { await this.discardCandidate(); this.release(); } catch { /* Retain candidate and lease for terminal cleanup retry. */ }
        this.publish({ phase: "failed", canInstall: false, canActivate: false, canCancel: !!this.candidate && !this.custodyFailure, message: "Activation failed. Use the manual command, then start EasyResearch again." });
      }
      return this.snapshot();
    }
    throw new NpmUpdateError(409, "UPDATE_UNAVAILABLE", "This update action is unavailable for the current installation.");
  }
  private start(operation: (signal: AbortSignal) => Promise<void>, failure: string): void {
    const signal = this.abort!.signal;
    // Store the task before any dependency can re-enter through a listener.
    const task = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); }).catch(async (error: unknown) => {
      if (error && typeof error === "object" && "cleanupCandidate" in error) this.candidate = error.cleanupCandidate as NpmUpdateCandidate;
      if (error && typeof error === "object" && "custodyUnresolved" in error && error.custodyUnresolved) this.custodyFailure = error;
      else {
        try { await this.discardCandidate(); this.release(); }
        catch (cleanupError) { if (!this.candidate) this.custodyFailure = cleanupError; }
      }
      const pendingCleanup = !!this.candidate || !!this.custodyFailure;
      this.publish({ phase: signal.aborted && !pendingCleanup ? "cancelled" : "failed", canInstall: false, canActivate: false, canCancel: !!this.candidate && !this.custodyFailure,
        message: pendingCleanup ? "Update cleanup is pending; installation custody is retained." : signal.aborted ? "Update cancelled. The running version is unchanged." : failure });
    }).finally(() => { if (this.task === task) this.task = undefined; });
    this.task = task;
  }
  private async discardCandidate(): Promise<void> {
    if (this.custodyFailure) throw this.custodyFailure;
    if (this.disposal) return this.disposal;
    const candidate = this.candidate;
    if (!candidate) return;
    const task = Promise.resolve().then(() => this.dependencies.discard(candidate)).then(() => {
      if (this.candidate === candidate) this.candidate = undefined;
    }).finally(() => { if (this.disposal === task) this.disposal = undefined; });
    this.disposal = task;
    return task;
  }
  private release(): void {
    if (this.custodyFailure) throw this.custodyFailure;
    if (this.lease) {
      if (this.lease.release() === false) throw new Error("Update transition ownership could not be released.");
      this.lease = undefined;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.abort?.abort();
    await this.task;
    await this.discardCandidate();
    this.release();
    this.listeners.clear();
  }
}
