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
import type { AuthFlowEventDto } from "./contracts";
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

export interface AuthGatewaySettings {
  /** Flow timeout in ms. `0` disables it; `-1` never expires. Default 10 min. */
  timeoutMs: number;
  /** Optional info/warn logger (ADR-039). Secrets are never logged. */
  logger?: Pick<Logger, "info" | "warn">;
  /** Provider ids declared in `models.json` (custom providers), for pinning. */
  modelsJsonProviderIds?: ReadonlySet<string>;
}

/** Minimal view of `ModelRuntime` this gateway relies on. */
export interface AuthModelRuntime {
  getProviders(): readonly { id: string; name: string; auth?: any }[];
  getProvider(providerId: string): { id: string; name: string; auth?: any } | undefined;
  getProviderAuthStatus(providerId: string): AuthStatusLike;
  checkAuth(providerId: string): Promise<AuthCheck | undefined>;
  login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;
  logout(providerId: string): Promise<void>;
  refresh?(options: {
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
  providerId: string;
  type: AuthType;
}

export interface RunFlowRequest extends PreflightRequest {
  flowId: AuthFlowId;
}

export interface AuthGateway {
  listProviders(): Promise<AuthProviderInfoDto[]>;
  preflight(req: PreflightRequest): void;
  runFlow(req: RunFlowRequest): Promise<void>;
  logout(providerId: string): Promise<void>;
  activeFlow(): AuthFlowId | null;
  store(): AuthFlowStore;
  /**
   * Used by tests to seed the single-flight lock with an externally-tracked
   * flowId. Production paths use `preflight`/`runFlow` only.
   */
  markExternalControl(flowId: AuthFlowId, ctrl: AbortController): void;
  shutdown(): void;
}

export function createAuthGateway(
  runtime: AuthModelRuntime,
  store: AuthFlowStore = createAuthFlowStore(),
  settings: AuthGatewaySettings = { timeoutMs: 600_000 },
): AuthGateway {
  const guard = singleFlightGuard();
  const externalAbortMap = new Map<AuthFlowId, AbortController>();
  const { logger } = settings;

  const preflight = (req: PreflightRequest): void => {
    const provider = runtime.getProvider(req.providerId);
    if (!provider) throw new AuthGatewayError(404, `unknown provider: ${req.providerId}`);
    const auth = provider.auth ?? {};
    const hasMethod =
      (req.type === "api_key" && auth.apiKey) || (req.type === "oauth" && auth.oauth);
    if (!hasMethod) {
      throw new AuthGatewayError(400, `provider ${req.providerId} has no ${req.type} auth method`);
    }
    if (guard.active()) throw new AuthGatewayError(409, "another auth flow is active");
  };

  const runFlow = async (req: RunFlowRequest): Promise<void> => {
    // Re-validate preflight in case the request was reconstructed elsewhere.
    preflight(req);
    if (!guard.tryAcquire(req.flowId)) {
      throw new AuthGatewayError(409, "another auth flow is active");
    }
    logger?.info("auth login start", { provider: req.providerId, type: req.type, flowId: req.flowId });
    const shutdownCtrl = new AbortController();
    externalAbortMap.set(req.flowId, shutdownCtrl);
    const rec = store.create(req.flowId, shutdownCtrl.signal);

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
      if (typeof runtime.refresh === "function") {
        try {
          const res = await runtime.refresh({ providers: [req.providerId], signal: AbortSignal.timeout(15_000) });
          if (res.aborted) warning = "Catalog refresh timed out; models may not refresh until restart.";
          else if (res.errors.size > 0) warning = "Credential saved; models may not refresh until restart.";
        } catch {
          warning = "Credential saved; models may not refresh until restart.";
        }
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
      if (isCredentialSynchronizationError(err)) {
        // Credential committed, local snapshot sync failed (ADR-065). Success
        // with a warning, never an error.
        const committed = (err as { credential?: Credential }).credential;
        const summary = (committed
          ? summarizeCredential(committed as never)
          : { type: "api_key" }) as never as CredentialSummary;
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

  return {
    async listProviders() {
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
            settings.modelsJsonProviderIds,
          ),
        );
      }
      return out;
    },
    preflight,
    runFlow,
    async logout(providerId) {
      if (!runtime.getProvider(providerId)) {
        throw new AuthGatewayError(404, `unknown provider: ${providerId}`);
      }
      await runtime.logout(providerId);
      logger?.info("auth logout", { provider: providerId, outcome: "ok" });
    },
    activeFlow: () => guard.active(),
    store: () => store,
    markExternalControl(flowId, ctrl) {
      externalAbortMap.set(flowId, ctrl);
      guard.tryAcquire(flowId);
    },
    shutdown() {
      for (const [, ctrl] of externalAbortMap) ctrl.abort();
      externalAbortMap.clear();
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
 * would violate the bootstrap boundary). When true, the credential was already
 * committed to `auth.json` but the local model/auth snapshot failed to sync.
 */
function isCredentialSynchronizationError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; credential?: unknown };
  return e.name === "CredentialSynchronizationError" && typeof e.credential === "object";
}