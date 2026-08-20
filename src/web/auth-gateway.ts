import {
  assembleProviderInfo,
  singleFlightGuard,
  summarizeCredential,
  framePromptEvent,
  frameNotifyEvent,
  type AuthProviderInfoDto,
  type SingleFlightGuard,
  type CredentialSummary,
} from "./auth-gateway-logic";
import { createAuthFlowStore, type AuthFlowStore } from "./auth-flow-store";
import type { AuthFlowEventDto, ModelOptionDto } from "./contracts";
import type { Logger } from "../runtime/logger";

// Type-only imports of Pi SDK types (erased at compile time; safe before
// `importPi()` has bootstrapped the easyresearch identity).
// `AuthStatus` isn't exported at the `@earendil-works/pi-coding-agent`
// package root (it lives in `core/provider-composer.ts`), so we mirror its
// expected shape here. authorize against the real type via the
// `AuthModelRuntime` consumer below.
import type {
  AuthInteraction,
  AuthPrompt,
  AuthEvent,
  Credential,
  AuthCheck,
} from "@earendil-works/pi-ai";

export interface AuthStatusLike {
  configured: boolean;
  source?: string;
  label?: string;
}

export type AuthFlowId = string;
export type AuthType = "api_key" | "oauth";

const SAFE_LOGOUT_SYNCHRONIZATION_ERROR =
  "Credential removal was saved, but local model state could not be synchronized.";

export interface AuthGatewaySettings {
  /** Flow timeout in ms. `0` disables it; `-1` never expires. Default 10 min. */
  timeoutMs: number;
  /** Optional info/warn logger (ADR-039). Secrets are never logged. */
  logger?: Pick<Logger, "info" | "warn">;
  /** Provider ids declared in `models.json` (custom providers), for pinning. */
  modelsJsonProviderIds?: () => Promise<ReadonlySet<string>>;
  /** Provider ids captured by the same transaction as the accepted runtime. */
  acceptedModelsJsonProviderIds?: () => ReadonlySet<string>;
  /**
   * Daemon-owned accepted-catalog synchronization. When present, routine
   * readers must not refresh the accepted runtime in place.
   */
  synchronizeCatalog?: () => Promise<void>;
  /** Force a daemon model generation after credentials change. */
  onModelsChanged?: () => Promise<void>;
}

/** Minimal view of `ModelRuntime` this gateway relies on. */
export interface AuthModelRuntime {
  getProviders(): readonly { id: string; name: string; auth?: any }[];
  getProvider(providerId: string): { id: string; name: string; auth?: any } | undefined;
  getAvailableSnapshot(): readonly {
    provider: string;
    id: string;
    reasoning: boolean;
    thinkingLevelMap?: Record<string, string | null>;
  }[];
  getError(): string | undefined;
  getProviderAuthStatus(providerId: string): AuthStatusLike;
  checkAuth(providerId: string): Promise<AuthCheck | undefined>;
  login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;
  logout(providerId: string): Promise<void>;
  refresh(options: {
    allowNetwork?: boolean;
    providers?: readonly string[];
    signal?: AbortSignal;
  }): Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>;
}

export class AuthGatewayError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "AuthGatewayError";
  }
}

export interface PreflightRequest {
  flowId: AuthFlowId;
  providerId: string;
  type: AuthType;
}

export type RunFlowRequest = PreflightRequest;

export interface AuthGateway {
  refreshCatalog(): Promise<void>;
  listModels(): Promise<ModelOptionDto[]>;
  listProviders(): Promise<AuthProviderInfoDto[]>;
  preflight(req: PreflightRequest): Promise<void>;
  runFlow(req: RunFlowRequest): Promise<void>;
  logout(providerId: string): Promise<void>;
  activeFlow(): AuthFlowId | null;
  store(): AuthFlowStore;
  /**
   * Used by tests to seed the single-flight lock with an externally-tracked
   * flowId. Production paths use `preflight`/`runFlow` only.
   */
  markExternalControl(flowId: AuthFlowId, ctrl: AbortController): void;
  shutdown(): Promise<void>;
}

export function createAuthGateway(
  runtime: AuthModelRuntime,
  store: AuthFlowStore = createAuthFlowStore(),
  settings: AuthGatewaySettings = { timeoutMs: 600_000 },
): AuthGateway {
  const guard = singleFlightGuard();
  const externalAbortMap = new Map<AuthFlowId, AbortController>();
  const { logger } = settings;
  let refreshPromise: Promise<void> | undefined;
  let modelsJsonProviderIds: ReadonlySet<string> = new Set();
  const activeOperations = new Set<Promise<unknown>>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  const shutdownError = (): AuthGatewayError =>
    new AuthGatewayError(503, "provider authentication is shutting down");

  const trackOperation = <T>(operation: Promise<T>): Promise<T> => {
    activeOperations.add(operation);
    void operation.then(
      () => activeOperations.delete(operation),
      () => activeOperations.delete(operation),
    );
    return operation;
  };

  const ownOperation = <T>(start: () => Promise<T>): Promise<T> => {
    if (shuttingDown) return Promise.reject(shutdownError());
    return trackOperation(start());
  };

  const assertRuntimeHealthy = (): void => {
    const semanticError = runtime.getError();
    if (semanticError) {
      throw new Error("Model catalog refresh failed", { cause: semanticError });
    }
  };

  const refreshLocal = (): Promise<void> =>
    refreshPromise ??= (async () => {
      let synchronizedProviderIds: ReadonlySet<string>;
      if (settings.synchronizeCatalog) {
        await settings.synchronizeCatalog();
        assertRuntimeHealthy();
        synchronizedProviderIds = settings.acceptedModelsJsonProviderIds?.() ?? new Set();
      } else {
        const result = await runtime.refresh({ allowNetwork: false });
        if (result.aborted || result.errors.size > 0) throw firstRefreshError(result);
        assertRuntimeHealthy();
        synchronizedProviderIds = settings.modelsJsonProviderIds
          ? await settings.modelsJsonProviderIds()
          : new Set();
      }
      modelsJsonProviderIds = synchronizedProviderIds;
    })()
      .finally(() => {
        refreshPromise = undefined;
      });

  const preflight = async (req: PreflightRequest): Promise<void> => {
    await refreshLocal();
    if (shuttingDown) throw shutdownError();
    const provider = runtime.getProvider(req.providerId);
    if (!provider) throw new AuthGatewayError(404, `unknown provider: ${req.providerId}`);
    const auth = provider.auth ?? {};
    const hasMethod =
      (req.type === "api_key" && auth.apiKey) || (req.type === "oauth" && auth.oauth);
    if (!hasMethod) {
      throw new AuthGatewayError(400, `provider ${req.providerId} has no ${req.type} auth method`);
    }
    if (!guard.tryAcquire(req.flowId)) throw new AuthGatewayError(409, "another auth flow is active");
    const shutdownCtrl = new AbortController();
    externalAbortMap.set(req.flowId, shutdownCtrl);
    try {
      store.create(req.flowId, shutdownCtrl.signal);
    } catch (error) {
      externalAbortMap.delete(req.flowId);
      guard.release(req.flowId);
      throw error;
    }
  };

  const executeFlow = async (req: RunFlowRequest): Promise<void> => {
    if (guard.active() !== req.flowId) {
      throw new AuthGatewayError(409, "auth flow was not reserved");
    }
    const rec = store.get(req.flowId);
    if (!rec) throw new AuthGatewayError(409, "auth flow was not registered");
    logger?.info("auth login start", { provider: req.providerId, type: req.type, flowId: req.flowId });

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (settings.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        rec.abortController.abort();
      }, settings.timeoutMs);
    }

    const interaction: AuthInteraction = {
      signal: rec.abortController.signal,
      prompt(p: AuthPrompt) {
        const ev = framePromptEvent(p as never) as never as AuthFlowEventDto;
        store.emitPrompt(req.flowId, ev);
        return store.awaitRespond(req.flowId);
      },
      notify(e: AuthEvent) {
        store.emit(req.flowId, {
          type: "notify",
          event: frameNotifyEvent(e as never) as never,
        });
      },
    };
    try {
      const credential = await runtime.login(req.providerId, req.type, interaction);
      let warning: string | undefined;
      try {
        const res = await runtime.refresh({ providers: [req.providerId], signal: AbortSignal.timeout(15_000) });
        if (res.aborted) warning = "Catalog refresh timed out; models may not refresh until restart.";
        else if (res.errors.size > 0) warning = "Credential saved; models may not refresh until restart.";
      } catch {
        warning = "Credential saved; models may not refresh until restart.";
      }
      try {
        await settings.onModelsChanged?.();
      } catch {
        warning ??= "Credential saved; models may not refresh until restart.";
      }
      const summary = summarizeCredential(credential as never) as never as CredentialSummary;
      store.terminate(req.flowId, {
        type: "done",
        credential: summary as never,
        warning,
      });
      logger?.info("auth login done", {
        provider: req.providerId,
        flowId: req.flowId,
        outcome: warning ? "sync-error" : "ok",
      });
    } catch (err) {
      if (isCredentialSynchronizationError(err, "login")) {
        // Credential committed, local snapshot sync failed (ADR-065). Success
        // with a warning, never an error.
        const committed = (err as { credential?: Credential }).credential;
        const summary = (committed
          ? summarizeCredential(committed as never)
          : { type: "api_key" }) as never as CredentialSummary;
        try {
          await settings.onModelsChanged?.();
        } catch {
          // The credential is already committed; retain warning-only semantics.
        }
        store.terminate(req.flowId, {
          type: "done",
          credential: summary,
          warning: "Credential saved; models may not refresh until restart.",
        });
        logger?.info("auth login done", { provider: req.providerId, flowId: req.flowId, outcome: "sync-error" });
      } else {
        const reason: "aborted" | "timeout" | "reject" = timedOut
          ? "timeout"
          : err instanceof DOMException && err.name === "AbortError"
            ? "aborted"
            : "reject";
        store.terminate(req.flowId, {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
          reason,
        });
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      guard.release(req.flowId);
      externalAbortMap.delete(req.flowId);
    }
  };

  const runFlow = (req: RunFlowRequest): Promise<void> => {
    if (shuttingDown) {
      const rec = store.get(req.flowId);
      rec?.abortController.abort();
      if (rec && !rec.terminated) {
        store.terminate(req.flowId, {
          type: "error",
          message: "Authentication was cancelled.",
          reason: "aborted",
        });
      }
      guard.release(req.flowId);
      externalAbortMap.delete(req.flowId);
      return Promise.resolve();
    }
    return trackOperation(executeFlow(req));
  };

  return {
    refreshCatalog: () => ownOperation(refreshLocal),
    listModels: () => ownOperation(async () => {
      await refreshLocal();
      return runtime.getAvailableSnapshot().map((model) => ({
        provider: model.provider,
        id: model.id,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
      }));
    }),
    listProviders: () => ownOperation(async () => {
      await refreshLocal();
      const providers = runtime.getProviders();
      const out: AuthProviderInfoDto[] = [];
      for (const p of providers) {
        const status = runtime.getProviderAuthStatus(p.id);
        let authCheck: AuthCheck | undefined;
        try {
          authCheck = await runtime.checkAuth(p.id);
        } catch {
          authCheck = undefined;
        }
        out.push(
          assembleProviderInfo(
            p as never,
            { configured: status?.configured ?? false, source: status?.source },
            authCheck as never,
            modelsJsonProviderIds,
          ),
        );
      }
      return out;
    }),
    preflight: (req) => ownOperation(() => preflight(req)),
    runFlow,
    logout: (providerId) => ownOperation(async () => {
      await refreshLocal();
      if (!runtime.getProvider(providerId)) {
        throw new AuthGatewayError(404, `unknown provider: ${providerId}`);
      }
      try {
        await runtime.logout(providerId);
      } catch (error) {
        if (!isCredentialSynchronizationError(error, "logout")) throw error;
        try {
          await settings.onModelsChanged?.();
        } catch {
          // Credential removal already committed; preserve the fixed safe error.
        }
        throw new AuthGatewayError(500, SAFE_LOGOUT_SYNCHRONIZATION_ERROR);
      }
      try {
        await settings.onModelsChanged?.();
      } catch {
        throw new AuthGatewayError(500, SAFE_LOGOUT_SYNCHRONIZATION_ERROR);
      }
      logger?.info("auth logout", { provider: providerId, outcome: "ok" });
    }),
    activeFlow: () => guard.active(),
    store: () => store,
    markExternalControl(flowId, ctrl) {
      externalAbortMap.set(flowId, ctrl);
      guard.tryAcquire(flowId);
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      shuttingDown = true;
      for (const [, ctrl] of externalAbortMap) ctrl.abort();
      shutdownPromise = Promise.allSettled([...activeOperations]).then(() => {
        externalAbortMap.clear();
      });
      return shutdownPromise;
    },
  };
}

// Silence the unused-import lint when `SingleFlightGuard`/`CredentialSummary`
// type helpers are referenced only via JSDoc; they are exported above for
// external test consumers.
export type { SingleFlightGuard, CredentialSummary };

/**
 * Detect Pi's `CredentialSynchronizationError` by name and committed-credential
 * shape, avoiding a value import of `@earendil-works/pi-coding-agent` (which
 * would violate the bootstrap boundary). Login carries its committed
 * credential; logout deliberately carries `undefined` after removal commits.
 */
function isCredentialSynchronizationError(err: unknown, operation: "login" | "logout"): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    name?: unknown;
    providerId?: unknown;
    operation?: unknown;
    credential?: unknown;
  };
  return (
    e.name === "CredentialSynchronizationError" &&
    typeof e.providerId === "string" &&
    e.operation === operation &&
    (operation === "logout" ? e.credential === undefined : typeof e.credential === "object")
  );
}

function firstRefreshError(result: {
  aborted: boolean;
  errors: ReadonlyMap<string, Error>;
}): Error {
  const error = result.errors.values().next().value;
  return error ?? new Error("Model catalog refresh aborted");
}
