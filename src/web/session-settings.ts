import { ConfigPathError, ConfigServiceError, type ConfigFileService } from "./config-files";
import { parsePiSettingsJson } from "../runtime/pi-settings-json";

export const DEFAULT_WEB_SESSION_IDLE_TIMEOUT_MS = 3_600_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveWebSessionIdleTimeout(settings: unknown): number {
  const root = isRecord(settings) ? settings : undefined;
  const easyresearch = isRecord(root?.easyresearch) ? root.easyresearch : undefined;
  const web = isRecord(easyresearch?.web) ? easyresearch.web : undefined;
  const value = web?.sessionIdleTimeoutMs;

  if (value === -1 || value === 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  return DEFAULT_WEB_SESSION_IDLE_TIMEOUT_MS;
}

export async function readWebSessionIdleTimeout(config: ConfigFileService): Promise<number> {
  try {
    const content = await config.read({ scope: "global", path: "settings.json" });
    return resolveWebSessionIdleTimeout(parsePiSettingsJson(content));
  } catch (error) {
    if (error instanceof SyntaxError) return DEFAULT_WEB_SESSION_IDLE_TIMEOUT_MS;
    if (error instanceof ConfigPathError) return DEFAULT_WEB_SESSION_IDLE_TIMEOUT_MS;
    if (error instanceof ConfigServiceError && error.status === 404) return DEFAULT_WEB_SESSION_IDLE_TIMEOUT_MS;
    throw error;
  }
}
