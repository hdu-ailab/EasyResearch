import {
  LATEST_RELEASE_PAGE,
  type UpdateAction,
  type UpdateActionResult,
  type UpdatePhase,
  type UpdateSnapshot,
} from "../../../runtime/update-contract";
import { routes } from "./routes";
import { ApiError, connectEventStream, requestJson } from "./transport";

const phases = new Set<UpdatePhase>([
  "idle",
  "checking",
  "current",
  "available",
  "downloading",
  "downloaded",
  "installing",
  "verifying",
  "ready",
  "activating",
  "failed",
  "cancelled",
]);
const version = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid update response");
  return value as Record<string, unknown>;
}

export function parseUpdateSnapshot(value: unknown): UpdateSnapshot {
  const source = object(value);
  if (
    !integer(source.revision) ||
    !(
      source.operationId === null ||
      (typeof source.operationId === "string" && source.operationId.length > 0 && source.operationId.length <= 128)
    ) ||
    !(source.owner === "cli" || source.owner === "desktop") ||
    !phases.has(source.phase as UpdatePhase) ||
    typeof source.currentVersion !== "string" ||
    !version.test(source.currentVersion) ||
    !(
      source.latestVersion === null ||
      (typeof source.latestVersion === "string" && version.test(source.latestVersion))
    ) ||
    [source.canDownload, source.canInstall, source.canActivate, source.canCancel].some(
      (item) => typeof item !== "boolean",
    ) ||
    source.releaseUrl !== LATEST_RELEASE_PAGE
  )
    throw new Error("Invalid update response");
  if (source.canReveal !== undefined && typeof source.canReveal !== "boolean")
    throw new Error("Invalid update capability");
  if (
    source.operationId === null &&
    [source.canDownload, source.canInstall, source.canActivate, source.canCancel, source.canReveal].some(Boolean)
  ) {
    throw new Error("Missing update operation");
  }
  for (const key of ["bytesReceived", "bytesTotal"] as const) {
    if (source[key] !== undefined && !integer(source[key])) throw new Error("Invalid update progress");
  }
  if (
    typeof source.bytesTotal === "number" &&
    (source.bytesTotal === 0 || (typeof source.bytesReceived === "number" && source.bytesReceived > source.bytesTotal))
  ) {
    throw new Error("Invalid update progress");
  }
  for (const key of ["message", "manualCommand"] as const) {
    if (source[key] !== undefined && (typeof source[key] !== "string" || source[key].length > 16_384))
      throw new Error("Invalid update text");
  }
  return {
    revision: source.revision,
    operationId: source.operationId as string | null,
    owner: source.owner,
    phase: source.phase as UpdatePhase,
    currentVersion: source.currentVersion,
    latestVersion: source.latestVersion as string | null,
    canDownload: source.canDownload as boolean,
    canInstall: source.canInstall as boolean,
    canActivate: source.canActivate as boolean,
    canCancel: source.canCancel as boolean,
    ...(source.canReveal === undefined ? {} : { canReveal: source.canReveal as boolean }),
    releaseUrl: LATEST_RELEASE_PAGE,
    ...(source.bytesReceived === undefined ? {} : { bytesReceived: source.bytesReceived as number }),
    ...(source.bytesTotal === undefined ? {} : { bytesTotal: source.bytesTotal as number }),
    ...(source.message === undefined ? {} : { message: source.message as string }),
    ...(source.manualCommand === undefined ? {} : { manualCommand: source.manualCommand as string }),
  };
}

export function parseUpdateResult(value: unknown): UpdateActionResult {
  const source = object(value);
  if (source.code !== "RUNTIME_BUSY") return parseUpdateSnapshot(value);
  if (!integer(source.activeSessions) || typeof source.authFlowActive !== "boolean")
    throw new Error("Invalid update admission");
  return { code: "RUNTIME_BUSY", activeSessions: source.activeSessions, authFlowActive: source.authFlowActive };
}

export async function getUpdateSnapshot(): Promise<UpdateSnapshot> {
  const host = window.easyresearchDesktop;
  if (!host)
    return withUpdateDeadline((signal) =>
      requestJson(routes.update(), parseUpdateSnapshot, { cache: "no-store", signal }),
    );
  const read = host.updateSnapshot;
  if (!read) throw new Error("Install the latest Desktop release to enable in-app updates.");
  return parseUpdateSnapshot(await withUpdateDeadline(() => read()));
}

export async function requestUpdateAction(action: UpdateAction): Promise<UpdateActionResult> {
  const host = window.easyresearchDesktop;
  if (!host) {
    try {
      return await withUpdateDeadline((signal) =>
        requestJson(routes.updateAction(), parseUpdateResult, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action),
          signal,
        }),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const result = parseUpdateResult(error.details);
        if ("code" in result) return result;
      }
      throw error;
    }
  }
  const run = host.updateAction;
  if (!run) throw new Error("Install the latest Desktop release to enable in-app updates.");
  // Desktop replies after its owned operation (including the final busy gate).
  // npm HTTP actions acknowledge admission instead. Keep cancellation independent
  // and allow the bounded host download/preparation budgets to finish.
  const timeoutMs = action.action === "download" ? 16 * 60_000 : action.action === "install" ? 3 * 60_000 : 35_000;
  return parseUpdateResult(await withUpdateDeadline(() => run(action), timeoutMs));
}

/** Expiring an acknowledgement detaches only the view, never cancels host work. */
async function withUpdateDeadline<T>(request: (signal: AbortSignal) => Promise<T>, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Update acknowledgement timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([request(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function subscribeUpdates(onSnapshot: (snapshot: UpdateSnapshot) => void, onError: () => void): () => void {
  const accept = (value: unknown) => {
    try {
      onSnapshot(parseUpdateSnapshot(value));
    } catch {
      onError();
    }
  };
  const host = window.easyresearchDesktop;
  if (host) {
    if (!host.onUpdate) return () => {};
    return host.onUpdate(accept);
  }
  return connectEventStream(routes.updateEvents(), {
    onError,
    onEvent: (value) => {
      try {
        const event = object(value);
        if (event.type === "update") accept(event.snapshot);
      } catch {
        onError();
      }
    },
  });
}
