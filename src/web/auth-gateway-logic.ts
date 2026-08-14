import type { AuthFlowEventDto } from "./contracts";

export type AuthType = "api_key" | "oauth";
export type PromptKind = "text" | "secret" | "select" | "manual_code";

export interface AuthStatusLike {
  configured: boolean;
  source?: string;
}

export interface AuthCheckLike {
  source?: string;
  type: "api_key" | "oauth";
}

export interface ProviderLike {
  id: string;
  name: string;
  auth?: {
    apiKey?: { name: string; login?: unknown };
    oauth?: { name?: string; login?: unknown; loginLabel?: string };
  };
}

export interface AuthProviderInfoDto {
  id: string;
  name: string;
  authMethods: AuthType[];
  connectable: boolean;
  authStatus: { configured: boolean; source?: string };
  source?: string;
  hint?: string;
  /** True when the provider is declared in `models.json` (custom provider). */
  modelsJson: boolean;
}

/**
 * Build the immutable DTO describing a provider's auth surface from the raw
 * Pi provider, its cached auth status, and (optionally) the resolved auth
 * check. Pure: no Pi imports, no async, no I/O — unit tested directly.
 *
 * `modelsJsonProviderIds` marks providers the user declared in `models.json`
 * (custom providers); they surface as `modelsJson: true` so the UI can pin
 * them with the configured ones.
 */
export function assembleProviderInfo(
  provider: ProviderLike,
  status: AuthStatusLike,
  authCheck: AuthCheckLike | undefined,
  modelsJsonProviderIds: ReadonlySet<string> = new Set(),
): AuthProviderInfoDto {
  const methods: AuthType[] = [];
  if (provider.auth?.apiKey) methods.push("api_key");
  if (provider.auth?.oauth) methods.push("oauth");

  const connectable = Boolean(
    (provider.auth?.apiKey && typeof provider.auth.apiKey.login === "function") ||
      (provider.auth?.oauth && typeof provider.auth.oauth.login === "function"),
  );
  const ambient = !connectable && methods.length > 0;
  const hint = ambient
    ? `${provider.name} uses ambient credentials (environment / config file). Configure there, not here.`
    : undefined;

  return {
    id: provider.id,
    name: provider.name,
    authMethods: methods,
    connectable,
    authStatus: { configured: status.configured, source: status.source },
    source: authCheck?.source,
    hint,
    modelsJson: modelsJsonProviderIds.has(provider.id),
  };
}

export interface SingleFlightGuard {
  tryAcquire(flowId: string): boolean;
  release(flowId: string): void;
  active(): string | null;
}

/**
 * One-slot single-flight lock for provider-login flows. Owns a single
 * `active` slot; a second `tryAcquire` while busy is rejected. Releases of
 * an unknown or non-matching id are no-ops so timeout/abort paths cannot
 * release a flow that has already been replaced.
 */
export function singleFlightGuard(): SingleFlightGuard {
  let active: string | null = null;
  return {
    tryAcquire(flowId) {
      if (active !== null) return false;
      active = flowId;
      return true;
    },
    release(flowId) {
      if (active === flowId) active = null;
    },
    active: () => active,
  };
}

/**
 * Resolve the per-flow timeout from settings. Positive ms wins; `0` disables
 * the timeout; `-1` makes the flow never expire; `undefined` falls back to
 * the 10-minute default.
 */
export function resolveTimeoutMs(value: number | undefined): number {
  if (value === undefined) return 600_000;
  return value;
}

export type CredentialSummary =
  | { type: "api_key" }
  | { type: "oauth"; expires: number };

/**
 * Strip credential secrets down to a safe, surfacable summary. The OAuth
 * access/refresh tokens never cross the SSE boundary.
 */
export function summarizeCredential(cred: {
  type: "api_key" | "oauth";
  expires?: number;
}): CredentialSummary {
  if (cred.type === "oauth") return { type: "oauth", expires: cred.expires ?? 0 };
  return { type: "api_key" };
}

/**
 * Frame a Pi `AuthPrompt` into an SSE `prompt` event DTO. Unknown
 * (provider-specific) prompt types collapse to `text`.
 */
export function framePromptEvent(prompt: {
  type: string;
  message: string;
  placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[];
}): Extract<AuthFlowEventDto, { type: "prompt" }> {
  const kind: PromptKind =
    prompt.type === "secret" || prompt.type === "select" || prompt.type === "manual_code"
      ? prompt.type
      : "text";
  return {
    type: "prompt",
    kind,
    message: prompt.message,
    placeholder: prompt.placeholder,
    options: kind === "select" ? (prompt.options as Extract<AuthFlowEventDto, { type: "prompt" }>["options"]) : undefined,
  };
}

/**
 * Frame a Pi `AuthEvent` into an SSE `notify` event DTO.
 */
export function frameNotifyEvent(event: {
  type: "info" | "auth_url" | "device_code" | "progress";
  message?: string;
  links?: readonly { url: string; label?: string }[];
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
}): Extract<AuthFlowEventDto, { type: "notify" }>["event"] {
  switch (event.type) {
    case "info":
      return { kind: "info", message: event.message ?? "", links: [...(event.links ?? [])] };
    case "auth_url":
      return { kind: "auth_url", url: event.url ?? "", instructions: event.instructions };
    case "device_code":
      return {
        kind: "device_code",
        userCode: event.userCode ?? "",
        verificationUri: event.verificationUri ?? "",
        intervalSeconds: event.intervalSeconds,
        expiresInSeconds: event.expiresInSeconds,
      };
    case "progress":
      return { kind: "progress", message: event.message ?? "" };
  }
}