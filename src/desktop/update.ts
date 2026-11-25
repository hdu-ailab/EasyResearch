import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { LATEST_RELEASE_PAGE, type UpdateController, type UpdateSnapshot, type UpdateAction, type UpdateActionResult } from "../runtime/update-contract";
import { discoverDesktopRelease, downloadDesktopAsset, readUpdateMetadata, type DesktopPackageKind, type DesktopRelease, type UpdateFetch } from "./update-download";
import { cleanupDesktopUpdateStaging, retainManualDesktopDownload, verifyDesktopDownload } from "./update-staging";
import { DesktopUpdateCleanupError, type DesktopUpdateBusy } from "./update-install";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
}

export interface DesktopReleaseUpdate {
  version: string;
  url: string;
}

export function parseSemanticVersion(value: string): SemanticVersion {
  const match = value.match(
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  );
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  const core = [match[1], match[2], match[3]].map(Number);
  if (core.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`Invalid semantic version: ${value}`);
  }
  const prerelease = match[4]
    ? match[4].split(".").map((identifier): number | string => {
      if (!/^\d+$/u.test(identifier)) return identifier;
      if (identifier.length > 1 && identifier.startsWith("0")) {
        throw new Error(`Invalid semantic version: ${value}`);
      }
      const numeric = Number(identifier);
      if (!Number.isSafeInteger(numeric)) throw new Error(`Invalid semantic version: ${value}`);
      return numeric;
    })
    : [];
  return { major: core[0]!, minor: core[1]!, patch: core[2]!, prerelease };
}

export function compareSemanticVersions(left: string, right: string): -1 | 0 | 1 {
  const a = parseSemanticVersion(left);
  const b = parseSemanticVersion(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    if (typeof leftIdentifier === "number" && typeof rightIdentifier === "string") return -1;
    if (typeof leftIdentifier === "string" && typeof rightIdentifier === "number") return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export async function checkDesktopUpdate(
  currentVersion: string,
  options: { fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<DesktopReleaseUpdate | null> {
  parseSemanticVersion(currentVersion);
  const body = await readUpdateMetadata(options) as { tag_name?: unknown; html_url?: unknown };
  if (typeof body.tag_name !== "string" || typeof body.html_url !== "string") {
    throw new Error("GitHub Release check returned malformed metadata.");
  }
  const latest = parseSemanticVersion(body.tag_name);
  const version = formatSemanticVersion(latest);
  const url = validateReleaseUrl(body.html_url, body.tag_name);
  return compareSemanticVersions(version, currentVersion) > 0 ? { version, url } : null;
}

function formatSemanticVersion(version: SemanticVersion): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length > 0 ? `${core}-${version.prerelease.join(".")}` : core;
}

function validateReleaseUrl(value: string, tag: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("GitHub Release metadata contained an invalid release URL.", { cause: error });
  }
  if (
    url.origin !== "https://github.com"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || url.pathname !== `/hdu-ailab/EasyResearch/releases/tag/${tag}`
  ) {
    throw new Error("GitHub Release metadata contained an invalid release URL.");
  }
  return url.href;
}

export interface DesktopDownloadedUpdate extends DesktopRelease { path: string; directory: string; operationId: string }
export interface DesktopUpdateOptions {
  currentVersion: string;
  kind: DesktopPackageKind | null;
  stagingRoot: string;
  /** The host has observed an installation-recovery failure before opening the UI. */
  recoveredInstallationFailure?: boolean;
  fetch?: UpdateFetch;
  discover?: typeof discoverDesktopRelease;
  download?: typeof downloadDesktopAsset;
  /** Resolves only after explicit custody commitment, never just after spawn. */
  install?(update: DesktopDownloadedUpdate, signal: AbortSignal, committed: () => void, controls: {
    force: boolean; stagingAccepted(): void; stagingReleased(): void;
  }): Promise<void | DesktopUpdateBusy>;
  reveal?(path: string): Promise<void>;
  activity?(signal: AbortSignal): Promise<Extract<UpdateActionResult, { code: "RUNTIME_BUSY" }>>;
  onError?(error: unknown): void;
}

export function validateDesktopUpdateAction(value: unknown): UpdateAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid update action.");
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some((key) => !["action", "operationId", "force"].includes(key))
    || !["check", "download", "install", "activate", "cancel", "reveal"].includes(request.action as string)
    || (request.operationId !== undefined && (typeof request.operationId !== "string" || request.operationId.length > 100))
    || (request.force !== undefined && typeof request.force !== "boolean")) throw new Error("Invalid update action.");
  return request as unknown as UpdateAction;
}

export function createDesktopUpdateController(options: DesktopUpdateOptions): UpdateController {
  parseSemanticVersion(options.currentVersion);
  let state: UpdateSnapshot = { revision: 0, operationId: null, owner: "desktop", phase: options.recoveredInstallationFailure ? "failed" : "idle", currentVersion: options.currentVersion,
    latestVersion: null, canDownload: false, canInstall: false, canActivate: false, canCancel: false, releaseUrl: LATEST_RELEASE_PAGE,
    ...(options.recoveredInstallationFailure ? { message: "Installation failed. Open latest Release." } : {}) };
  let candidate: DesktopRelease | null = null;
  let downloaded: DesktopDownloadedUpdate | undefined;
  let directory: string | undefined;
  let closed = false;
  let committed = false;
  let custodyStarted = false;
  let retainedManual = false;
  let operation: { abort: AbortController; promise: Promise<UpdateActionResult> } | undefined;
  const listeners = new Set<(snapshot: UpdateSnapshot) => void>();
  const snapshot = () => ({ ...state });
  const publish = (patch: Partial<UpdateSnapshot>) => {
    state = { ...state, ...patch, revision: state.revision + 1 };
    for (const listener of listeners) { try { listener(snapshot()); } catch { /* View lifetime never owns the operation. */ } }
  };
  const removeStaging = async () => {
    // After helper admission, its receipt/recovery copy may still be needed even
    // when a bounded cleanup fails. Only the process custodian owns that staging.
    if (directory && !committed && !custodyStarted) {
      if (downloaded && !retainedManual) await cleanupDesktopUpdateStaging(directory, downloaded.asset.name);
      else await rm(directory, { recursive: true, force: true });
    }
    directory = undefined; downloaded = undefined;
    retainedManual = false;
    if (!committed) custodyStarted = false;
  };
  const manualReason = () => options.kind === "macos-arm64.dmg" ? "Automatic installation is unavailable for this macOS package. Open latest Release."
    : options.kind === "linux-arm64.deb" ? "Install this DEB package through your system package manager. Open latest Release."
    : "Automatic installation is unavailable for this installation. Open latest Release.";
  const action = async (raw: UpdateAction): Promise<UpdateActionResult> => {
    const request = validateDesktopUpdateAction(raw);
    if (closed) throw new Error("Desktop updater is closed.");
    if (request.action !== "check" && request.operationId !== state.operationId) throw new Error("Stale update operation. Check again.");
    if (request.action === "cancel") {
      if (!operation || !state.canCancel || committed) throw new Error("This update cannot be cancelled.");
      operation.abort.abort(); return operation.promise;
    }
    if (operation || committed) throw new Error("An update operation is already active.");
    if (request.action === "activate") throw new Error("Desktop installation owns its restart.");
    if (request.action === "download" && !state.canDownload) throw new Error("No update is available to download.");
    if (request.action === "reveal" && (!downloaded || !options.reveal)) throw new Error("No verified download is available.");
    if (request.action === "install" && !state.canInstall) {
      publish({ phase: "failed", message: manualReason(), canCancel: false }); return snapshot();
    }
    // Every Desktop installation stops the entire owned runtime, including work admitted
    // after a prior status read. Sample actual activity, but always require force consent.
    const abort = new AbortController();
    let resolveOwned!: (result: UpdateActionResult) => void;
    let rejectOwned!: (error: unknown) => void;
    const owned = { abort, promise: new Promise<UpdateActionResult>((resolve, reject) => { resolveOwned = resolve; rejectOwned = reject; }) };
    operation = owned;
    if (request.action === "check") {
      candidate = null;
      publish({ operationId: randomUUID(), phase: "checking", latestVersion: null, message: undefined, bytesReceived: undefined,
        bytesTotal: undefined, canDownload: false, canInstall: false, canReveal: false, canCancel: true });
    } else publish({ ...(request.action === "reveal" || (request.action === "install" && !request.force) ? {} : { phase: request.action === "download" ? "downloading" as const : "installing" as const }), canDownload: false, canInstall: false, canCancel: true, message: undefined });
    const promise = Promise.resolve().then(async (): Promise<UpdateActionResult> => {
      try {
        if (request.action === "install" && !request.force) {
          if (!options.activity) throw new Error("Desktop activity check is unavailable.");
          const busy = await options.activity(abort.signal);
          abort.signal.throwIfAborted();
          if (busy.activeSessions > 0 || busy.authFlowActive) {
            publish({ phase: "downloaded", canInstall: true, canCancel: false });
            return busy;
          }
        }
        if (request.action === "reveal") {
          await verifyDesktopDownload(downloaded!.path, downloaded!.asset);
          await options.reveal!(downloaded!.path);
          publish({ phase: "downloaded", canInstall: Boolean(options.install), canReveal: true, canCancel: false });
        } else if (request.action === "check") {
          await removeStaging(); abort.signal.throwIfAborted();
          if (!options.kind) {
            publish({ phase: "failed", canCancel: false, message: "This Desktop preview has no installable release. Open latest Release." });
          } else {
            candidate = await (options.discover ?? discoverDesktopRelease)(options.currentVersion, options.kind, { signal: abort.signal, fetch: options.fetch });
            abort.signal.throwIfAborted();
            publish({ phase: candidate ? "available" : "current", latestVersion: candidate?.version ?? null, canDownload: Boolean(candidate), canCancel: false });
          }
        } else if (request.action === "download") {
          await removeStaging();
          await mkdir(options.stagingRoot, { recursive: true, mode: 0o700 });
          directory = await mkdtemp(join(options.stagingRoot, "update-"));
          const result = await (options.download ?? downloadDesktopAsset)(candidate!.asset, directory, { signal: abort.signal, fetch: options.fetch,
            onProgress: (bytesReceived, bytesTotal) => { if (!abort.signal.aborted) publish({ bytesReceived, bytesTotal }); } });
          abort.signal.throwIfAborted();
          downloaded = { ...candidate!, ...result, directory, operationId: state.operationId! };
          if (!options.install) {
            downloaded.path = await retainManualDesktopDownload(downloaded.path, options.stagingRoot, downloaded.asset);
            retainedManual = true;
            abort.signal.throwIfAborted();
          }
          publish({ phase: "downloaded", canInstall: Boolean(options.install), canReveal: Boolean(options.reveal), canCancel: false,
            ...(!options.install ? { message: manualReason() } : {}) });
        } else {
          const result = await options.install!(downloaded!, abort.signal, () => { committed = true; publish({ phase: "activating", canCancel: false, canReveal: false }); }, {
            force: request.force === true,
            stagingAccepted: () => { custodyStarted = true; },
            stagingReleased: () => { custodyStarted = false; },
          });
          if (result?.code === "RUNTIME_BUSY") {
            abort.signal.throwIfAborted();
            publish({ phase: "downloaded", canInstall: true, canCancel: false, canReveal: Boolean(options.reveal) });
            return result;
          }
          // This process cannot claim the new host/sidecar is running; the custodian
          // and authenticated successor own verification after this host has exited.
          committed = true;
          publish({ phase: "activating", canCancel: false, bytesReceived: undefined, bytesTotal: undefined });
        }
      } catch (error) {
        if (error instanceof DesktopUpdateCleanupError) custodyStarted = true;
        options.onError?.(error);
        publish({ phase: abort.signal.aborted ? "cancelled" : "failed", canDownload: Boolean(candidate) && !committed,
          canInstall: false, canCancel: false, canReveal: false, bytesReceived: undefined, bytesTotal: undefined,
          message: abort.signal.aborted ? "Update cancelled." : request.action === "install" ? "Installation failed. Open latest Release." : "Update verification or download failed. Open latest Release." });
        if (!committed) await removeStaging().catch((error) => options.onError?.(error));
      }
      return snapshot();
    }).finally(() => { if (operation === owned) operation = undefined; });
    void promise.then(resolveOwned, rejectOwned);
    return owned.promise;
  };
  return { snapshot, action, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() {
      closed = true;
      if (!committed) operation?.abort.abort();
      await operation?.promise;
      if (!committed) await removeStaging();
      listeners.clear();
    },
  };
}
