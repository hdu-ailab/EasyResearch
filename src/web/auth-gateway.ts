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
  timeoutMs: number;
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
  _settings: AuthGatewaySettings = { timeoutMs: 600_000 },
): AuthGateway {
  const guard = singleFlightGuard();
  const externalAbortMap = new Map<AuthFlowId, AbortController>();

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
    const shutdownCtrl = new AbortController();
    externalAbortMap.set(req.flowId, shutdownCtrl);
    const rec = store.create(req.flowId, shutdownCtrl.signal);
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
    } catch (err) {
      const reason: "aborted" | "reject" =
        err instanceof DOMException && err.name === "AbortError" ? "aborted" : "reject";
      store.terminate(req.flowId, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        reason,
      });
    } finally {
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