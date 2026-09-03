import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePiSettingsJson } from "./pi-settings-json";

export type NetworkProxyField = "settings" | "all" | "llm" | "search";
export type NetworkProxySource = "configured" | "all" | "environment" | "direct";
export type NetworkProxyRouteClass = "all" | "llm" | "search";
export type NetworkProxyTargetProtocol = "http:" | "https:";
export type EnvironmentMap = Record<string, string | undefined>;

export interface ConfiguredNetworkProxies {
  readonly all?: string;
  readonly llm?: string;
  readonly search?: string;
}

export interface NetworkProxyValidationError {
  readonly code: "NETWORK_PROXY_INVALID";
  readonly field: NetworkProxyField;
}

export interface ParsedNetworkProxySettings {
  readonly configured: ConfiguredNetworkProxies;
  readonly configuredFingerprint: string;
  readonly errors: readonly NetworkProxyValidationError[];
}

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;
const BYPASS_ENV_KEYS = ["NO_PROXY", "no_proxy"] as const;
const NPM_PROXY_ENV_KEYS = [
  "npm_config_proxy",
  "NPM_CONFIG_PROXY",
  "npm_config_https_proxy",
  "NPM_CONFIG_HTTPS_PROXY",
] as const;
const NPM_BYPASS_ENV_KEYS = ["npm_config_noproxy", "NPM_CONFIG_NOPROXY"] as const;
const NPM_ENV_KEYS = [...NPM_PROXY_ENV_KEYS, ...NPM_BYPASS_ENV_KEYS] as const;
const PIP_PROXY_ENV_KEYS = ["PIP_PROXY"] as const;
const INHERITED_ENV_KEYS = [...PROXY_ENV_KEYS, ...BYPASS_ENV_KEYS] as const;
const PLAYWRIGHT_PROXY_ENV_KEYS = [
  "PLAYWRIGHT_MCP_PROXY_SERVER",
  "PLAYWRIGHT_MCP_PROXY_BYPASS",
] as const;
const MANAGED_ENV_KEYS = [
  ...INHERITED_ENV_KEYS,
  ...NPM_ENV_KEYS,
  ...PIP_PROXY_ENV_KEYS,
  ...PLAYWRIGHT_PROXY_ENV_KEYS,
] as const;
const MANDATORY_BYPASS_ENTRIES = ["localhost", "127.0.0.1", "::1"] as const;
const FAIL_CLOSED_SETUP_PROXY = "http://127.0.0.1:0";
const preparedSandboxEnvironments = new WeakSet<object>();

type InheritedProxyEnvironmentKey = (typeof INHERITED_ENV_KEYS)[number];
type ManagedProxyEnvironmentKey = (typeof MANAGED_ENV_KEYS)[number];

export interface InheritedProxyEnvironment {
  readonly values: Readonly<Partial<Record<ManagedProxyEnvironmentKey, string>>>;
}

export interface NetworkProxySources {
  readonly all: Exclude<NetworkProxySource, "all">;
  readonly llm: NetworkProxySource;
  readonly search: NetworkProxySource;
}

export interface NetworkPolicy extends ParsedNetworkProxySettings {
  readonly sources: NetworkProxySources;
  readonly bypass: string;
}

export interface LoadedNetworkPolicy {
  readonly baseline: InheritedProxyEnvironment;
  readonly policy: NetworkPolicy;
}

export interface BunSandboxEnvironmentOptions {
  isBun?: boolean;
  readEnviron?: () => string;
}

interface ProtocolProxyRoute {
  readonly http?: string;
  readonly https?: string;
}

interface PrivateNetworkPolicyState {
  readonly baseline: InheritedProxyEnvironment;
  readonly routes: Readonly<Record<NetworkProxyRouteClass, ProtocolProxyRoute>>;
}

const privateNetworkPolicyState = new WeakMap<NetworkPolicy, PrivateNetworkPolicyState>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(field: NetworkProxyField): NetworkProxyValidationError {
  return Object.freeze({ code: "NETWORK_PROXY_INVALID", field });
}

function normalizeConfiguredProxy(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (candidate.length === 0) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname || parsed.pathname !== "/") return null;
  if (candidate.includes("?") || candidate.includes("#")) return null;

  const authorityStart = candidate.indexOf("://") + 3;
  const authorityTail = candidate.slice(authorityStart);
  const authorityEnd = authorityTail.search(/[/?#]/u);
  const authority = authorityEnd === -1 ? authorityTail : authorityTail.slice(0, authorityEnd);
  if (authorityStart < 3 || authority.includes("@") || parsed.username || parsed.password) return null;

  return parsed.origin;
}

function fingerprintConfigured(
  configured: ConfiguredNetworkProxies,
  errors: readonly NetworkProxyValidationError[],
): string {
  const normalized = JSON.stringify([
    configured.all ?? null,
    configured.llm ?? null,
    configured.search ?? null,
    errors.map((error) => error.field),
  ]);
  return createHash("sha256")
    .update("easyresearch-network-proxy-v1\0")
    .update(normalized)
    .digest("hex");
}

export function parseNetworkProxySettings(settings: unknown): ParsedNetworkProxySettings {
  if (!isRecord(settings)) {
    const errors = Object.freeze([invalid("settings")]);
    const configured = Object.freeze({});
    return Object.freeze({
      configured,
      configuredFingerprint: fingerprintConfigured(configured, errors),
      errors,
    });
  }

  let ancestorInvalid = false;
  let network: Record<string, unknown> | undefined;
  const rawEasyResearch = settings.easyresearch;
  if (rawEasyResearch !== undefined) {
    if (!isRecord(rawEasyResearch)) {
      ancestorInvalid = true;
    } else {
      const rawNetwork = rawEasyResearch.network;
      if (rawNetwork !== undefined) {
        if (isRecord(rawNetwork)) network = rawNetwork;
        else ancestorInvalid = true;
      }
    }
  }

  const normalized = {
    all: normalizeConfiguredProxy(settings.httpProxy),
    llm: normalizeConfiguredProxy(network?.llmProxy),
    search: normalizeConfiguredProxy(network?.searchProxy),
  };
  const errors: NetworkProxyValidationError[] = [];
  if (ancestorInvalid) errors.push(invalid("settings"));
  if (normalized.all === null) errors.push(invalid("all"));
  if (normalized.llm === null) errors.push(invalid("llm"));
  if (normalized.search === null) errors.push(invalid("search"));

  const configured: { all?: string; llm?: string; search?: string } = {};
  if (normalized.all !== null && normalized.all !== undefined) configured.all = normalized.all;
  if (normalized.llm !== null && normalized.llm !== undefined) configured.llm = normalized.llm;
  if (normalized.search !== null && normalized.search !== undefined) configured.search = normalized.search;
  const frozenConfigured = Object.freeze(configured);
  const frozenErrors = Object.freeze(errors);
  return Object.freeze({
    configured: frozenConfigured,
    configuredFingerprint: fingerprintConfigured(frozenConfigured, frozenErrors),
    errors: frozenErrors,
  });
}

export function captureInheritedProxyEnvironment(
  env: Readonly<EnvironmentMap>,
): InheritedProxyEnvironment {
  const values: Partial<Record<ManagedProxyEnvironmentKey, string>> = {};
  for (const key of MANAGED_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string") values[key] = value;
  }
  const baseline = {} as { values: InheritedProxyEnvironment["values"] };
  Object.defineProperty(baseline, "values", {
    configurable: false,
    enumerable: false,
    value: Object.freeze(values),
    writable: false,
  });
  return Object.freeze(baseline);
}

function firstNonEmpty(
  values: InheritedProxyEnvironment["values"],
  keys: readonly InheritedProxyEnvironmentKey[],
): string | undefined {
  for (const key of keys) {
    const value = values[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function inheritedHttpsProxy(baseline: InheritedProxyEnvironment): string | undefined {
  // Match Pi's case precedence within each conventional HTTPS -> ALL -> HTTP class.
  return firstNonEmpty(baseline.values, [
    "https_proxy",
    "HTTPS_PROXY",
    "all_proxy",
    "ALL_PROXY",
    "http_proxy",
    "HTTP_PROXY",
  ]);
}

function inheritedHttpProxy(baseline: InheritedProxyEnvironment): string | undefined {
  return firstNonEmpty(baseline.values, [
    "http_proxy",
    "HTTP_PROXY",
    "all_proxy",
    "ALL_PROXY",
  ]);
}

function mergedBypass(
  baseline: InheritedProxyEnvironment,
  hasExplicitProxy: boolean,
): string {
  const entries: string[] = [];
  const seen = new Set<string>();
  const add = (rawEntry: string): void => {
    let entry = rawEntry.trim();
    if (!entry || (entry === "*" && hasExplicitProxy)) return;
    const lower = entry.toLowerCase();
    if (MANDATORY_BYPASS_ENTRIES.includes(lower as (typeof MANDATORY_BYPASS_ENTRIES)[number])) {
      entry = lower;
    }
    const key = entry.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };

  for (const key of ["no_proxy", "NO_PROXY"] as const) {
    for (const entry of baseline.values[key]?.split(/[\s,]+/u) ?? []) add(entry);
  }
  for (const entry of MANDATORY_BYPASS_ENTRIES) add(entry);
  return entries.join(",");
}

function bunCompatibleBypass(bypass: string): string {
  const entries = bypass.split(/\s*,\s*/u).filter(Boolean);
  const seen = new Set(entries.map((entry) => entry.toLowerCase()));
  for (const entry of ["localhost.", "[::1]"]) {
    if (!seen.has(entry)) entries.push(entry);
  }
  return entries.join(",");
}

export function resolveNetworkPolicy(
  parsed: ParsedNetworkProxySettings,
  baseline: InheritedProxyEnvironment,
): NetworkPolicy {
  const inheritedHttp = inheritedHttpProxy(baseline);
  const inheritedHttps = inheritedHttpsProxy(baseline);
  const inherited = inheritedHttps ?? inheritedHttp;
  const configuredAll = parsed.configured.all;
  const configuredLlm = parsed.configured.llm ?? configuredAll;
  const configuredSearch = parsed.configured.search ?? configuredAll;
  const sources: NetworkProxySources = Object.freeze({
    all: parsed.configured.all ? "configured" : inherited ? "environment" : "direct",
    llm: parsed.configured.llm
      ? "configured"
      : parsed.configured.all
        ? "all"
        : inherited
          ? "environment"
          : "direct",
    search: parsed.configured.search
      ? "configured"
      : parsed.configured.all
        ? "all"
        : inherited
          ? "environment"
          : "direct",
  });

  const policy = {
    configured: parsed.configured,
    configuredFingerprint: parsed.configuredFingerprint,
    errors: parsed.errors,
    sources,
    bypass: mergedBypass(baseline, Object.keys(parsed.configured).length > 0),
  } as NetworkPolicy;
  Object.freeze(policy);
  privateNetworkPolicyState.set(policy, Object.freeze({
    baseline,
    routes: Object.freeze({
      all: Object.freeze({
        ...(configuredAll ?? inheritedHttp ? { http: configuredAll ?? inheritedHttp } : {}),
        ...(configuredAll ?? inheritedHttps ? { https: configuredAll ?? inheritedHttps } : {}),
      }),
      llm: Object.freeze({
        ...(configuredLlm ?? inheritedHttp ? { http: configuredLlm ?? inheritedHttp } : {}),
        ...(configuredLlm ?? inheritedHttps ? { https: configuredLlm ?? inheritedHttps } : {}),
      }),
      search: Object.freeze({
        ...(configuredSearch ?? inheritedHttp ? { http: configuredSearch ?? inheritedHttp } : {}),
        ...(configuredSearch ?? inheritedHttps ? { https: configuredSearch ?? inheritedHttps } : {}),
      }),
    }),
  }));
  return policy;
}

function requirePrivateNetworkPolicyState(policy: NetworkPolicy): PrivateNetworkPolicyState {
  const state = privateNetworkPolicyState.get(policy);
  if (!state) throw new TypeError("Network policy was not produced by resolveNetworkPolicy.");
  return state;
}

export function networkProxyForTarget(
  policy: NetworkPolicy,
  scope: NetworkProxyRouteClass,
  protocol: NetworkProxyTargetProtocol,
): string | undefined {
  const route = requirePrivateNetworkPolicyState(policy).routes[scope];
  return protocol === "http:" ? route.http : route.https;
}

export function networkProviderEnvironment(
  policy: NetworkPolicy,
  scope: NetworkProxyRouteClass,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  const configured = scope === "all"
    ? policy.configured.all
    : policy.configured[scope] ?? policy.configured.all;
  if (configured !== undefined) {
    for (const key of PROXY_ENV_KEYS) environment[key] = configured;
  } else if (policy.sources[scope] === "environment") {
    const { values } = requirePrivateNetworkPolicyState(policy).baseline;
    for (const key of PROXY_ENV_KEYS) {
      const value = values[key];
      if (value !== undefined) environment[key] = value;
    }
  }
  const providerBypass = bunCompatibleBypass(policy.bypass);
  environment.NO_PROXY = providerBypass;
  environment.no_proxy = providerBypass;
  return Object.freeze(environment);
}

export function networkPolicyProxySecrets(policy: NetworkPolicy): readonly string[] {
  const inherited = requirePrivateNetworkPolicyState(policy).baseline.values;
  return Object.freeze([...new Set([
    ...Object.values(policy.configured),
    ...PROXY_ENV_KEYS.map((key) => inherited[key]),
    ...NPM_PROXY_ENV_KEYS.map((key) => inherited[key]),
    ...PIP_PROXY_ENV_KEYS.map((key) => inherited[key]),
  ].filter((value): value is string => typeof value === "string" && value.length > 0))]);
}

function restoreInheritedKeys(
  target: EnvironmentMap,
  baseline: InheritedProxyEnvironment,
  keys: readonly ManagedProxyEnvironmentKey[],
): void {
  for (const key of keys) {
    const inherited = baseline.values[key];
    if (inherited === undefined) delete target[key];
    else target[key] = inherited;
  }
}

export function applyNetworkPolicyEnvironment(
  policy: NetworkPolicy,
  baseline: InheritedProxyEnvironment,
  target: EnvironmentMap,
): void {
  const invalidFields = new Set(policy.errors.map((error) => error.field));
  const allInvalid = invalidFields.has("settings") || invalidFields.has("all");
  const searchInvalid = invalidFields.has("settings")
    || invalidFields.has("search")
    || (invalidFields.has("all") && policy.configured.search === undefined);
  const failClosedBypass = mergedBypass(baseline, true);
  const failClosedProcessBypass = bunCompatibleBypass(failClosedBypass);
  const processBypass = allInvalid
    ? failClosedProcessBypass
    : bunCompatibleBypass(policy.bypass);

  if (allInvalid) {
    for (const key of PROXY_ENV_KEYS) target[key] = FAIL_CLOSED_SETUP_PROXY;
  } else if (policy.configured.all !== undefined) {
    for (const key of PROXY_ENV_KEYS) target[key] = policy.configured.all;
  } else {
    restoreInheritedKeys(target, baseline, PROXY_ENV_KEYS);
  }

  target.NO_PROXY = processBypass;
  target.no_proxy = target.NO_PROXY;
  if (allInvalid) {
    for (const key of PIP_PROXY_ENV_KEYS) target[key] = FAIL_CLOSED_SETUP_PROXY;
  } else if (policy.configured.all !== undefined) {
    for (const key of PIP_PROXY_ENV_KEYS) target[key] = policy.configured.all;
  } else {
    restoreInheritedKeys(target, baseline, PIP_PROXY_ENV_KEYS);
  }
  if (allInvalid) {
    for (const key of NPM_PROXY_ENV_KEYS) target[key] = FAIL_CLOSED_SETUP_PROXY;
    for (const key of NPM_BYPASS_ENV_KEYS) target[key] = processBypass;
  } else if (policy.configured.all !== undefined) {
    for (const key of NPM_PROXY_ENV_KEYS) target[key] = policy.configured.all;
    for (const key of NPM_BYPASS_ENV_KEYS) target[key] = processBypass;
  } else {
    restoreInheritedKeys(target, baseline, NPM_ENV_KEYS);
  }
  const configuredSearch = policy.configured.search ?? policy.configured.all;
  if (searchInvalid) {
    target.PLAYWRIGHT_MCP_PROXY_SERVER = FAIL_CLOSED_SETUP_PROXY;
    target.PLAYWRIGHT_MCP_PROXY_BYPASS = failClosedProcessBypass;
  } else if (configuredSearch !== undefined) {
    target.PLAYWRIGHT_MCP_PROXY_SERVER = configuredSearch;
    target.PLAYWRIGHT_MCP_PROXY_BYPASS = processBypass;
  } else {
    const ambientServer = baseline.values.PLAYWRIGHT_MCP_PROXY_SERVER;
    const ambientBypass = baseline.values.PLAYWRIGHT_MCP_PROXY_BYPASS;
    if (ambientServer !== undefined) target.PLAYWRIGHT_MCP_PROXY_SERVER = ambientServer;
    else {
      const inheritedSearch = networkProxyForTarget(policy, "search", "https:");
      if (inheritedSearch !== undefined) target.PLAYWRIGHT_MCP_PROXY_SERVER = inheritedSearch;
      else delete target.PLAYWRIGHT_MCP_PROXY_SERVER;
    }
    if (ambientBypass !== undefined) target.PLAYWRIGHT_MCP_PROXY_BYPASS = ambientBypass;
    else target.PLAYWRIGHT_MCP_PROXY_BYPASS = processBypass;
  }
}

export function reconstructChildEnvironment(
  current: Readonly<EnvironmentMap>,
  baseline: InheritedProxyEnvironment,
): EnvironmentMap {
  const child = { ...current };
  for (const key of MANAGED_ENV_KEYS) delete child[key];
  for (const key of MANAGED_ENV_KEYS) {
    const inherited = baseline.values[key];
    if (inherited !== undefined) child[key] = inherited;
  }
  return child;
}

export function restoreBunSandboxEnvironment(
  target: EnvironmentMap = process.env,
  options: BunSandboxEnvironmentOptions = {},
): boolean {
  if (!(options.isBun ?? Boolean(process.versions?.bun))) return false;
  if (preparedSandboxEnvironments.has(target)) return false;
  preparedSandboxEnvironments.add(target);
  if (Object.keys(target).length > 0) return false;
  try {
    const data = (options.readEnviron ?? (() => readFileSync("/proc/self/environ", "utf8")))();
    for (const entry of data.split("\0")) {
      const separator = entry.indexOf("=");
      if (separator > 0) target[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
    return Object.keys(target).length > 0;
  } catch {
    return false;
  }
}

export function loadNetworkPolicy(
  agentDir: string,
  environment: EnvironmentMap = process.env,
  restoreOptions: BunSandboxEnvironmentOptions = {},
): LoadedNetworkPolicy {
  restoreBunSandboxEnvironment(environment, restoreOptions);
  const baseline = captureInheritedProxyEnvironment(environment);
  const settingsPath = join(agentDir, "settings.json");
  let settings: unknown = {};
  if (existsSync(settingsPath)) {
    try {
      const content = readFileSync(settingsPath, "utf8");
      settings = parsePiSettingsJson(content);
    } catch {
      settings = undefined;
    }
  }
  return Object.freeze({
    baseline,
    policy: resolveNetworkPolicy(parseNetworkProxySettings(settings), baseline),
  });
}

export function withTemporaryNetworkPolicyEnvironment<T>(
  policy: NetworkPolicy,
  baseline: InheritedProxyEnvironment,
  environment: EnvironmentMap,
  operation: () => T,
): T {
  const snapshot: Partial<Record<ManagedProxyEnvironmentKey, string>> = {};
  for (const key of MANAGED_ENV_KEYS) {
    const value = environment[key];
    if (value !== undefined) snapshot[key] = value;
  }
  applyNetworkPolicyEnvironment(policy, baseline, environment);
  try {
    return operation();
  } finally {
    for (const key of MANAGED_ENV_KEYS) {
      const value = snapshot[key];
      if (value === undefined) delete environment[key];
      else environment[key] = value;
    }
  }
}
