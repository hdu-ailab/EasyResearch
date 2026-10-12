import type { ProviderTimeoutSettingsDto } from "../web/contracts";

export const DEFAULT_PROVIDER_TIMEOUT_MS = 3_600_000;
export const MAX_PROVIDER_TIMEOUT_MS = 2_147_483_647;

export function validProviderTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PROVIDER_TIMEOUT_MS;
}

function record(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid timeout settings object");
  return value as Record<string, unknown>;
}

export function parseProviderTimeoutSettings(value: unknown): ProviderTimeoutSettingsDto {
  const settings = record(value);
  const provider = record(record(settings.retry).provider);
  if (provider.timeoutMs !== undefined) {
    if (!validProviderTimeout(provider.timeoutMs)) throw new Error("Invalid provider timeout");
    return { timeoutMs: provider.timeoutMs, source: "provider" };
  }
  if (settings.httpIdleTimeoutMs !== undefined) {
    if (!validProviderTimeout(settings.httpIdleTimeoutMs)) throw new Error("Invalid HTTP idle timeout");
    return { timeoutMs: settings.httpIdleTimeoutMs, source: "httpIdle" };
  }
  return { timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS, source: "default" };
}
