import type { LiveConfiguration } from "../runtime/live-configuration";
import { join } from "node:path";
import { validProviderTimeout } from "../runtime/provider-timeout-settings";
import type { ProviderTimeoutSettingsDto } from "./contracts";
import { ConfigServiceError, type ConfigFileService } from "./config-files";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function patchGlobalProviderTimeout(config: ConfigFileService, value: unknown): Promise<void> {
  if (!record(value) || Object.keys(value).length !== 1 || !("timeoutMs" in value)
    || (value.timeoutMs !== null && !validProviderTimeout(value.timeoutMs))) {
    throw new ConfigServiceError(400, "timeoutMs must be an integer from 0 through 2147483647, or null to restore the default");
  }
  await config.mutateGlobalSettings((settings) => {
    if (settings.retry !== undefined && !record(settings.retry)) {
      throw new ConfigServiceError(409, `Invalid retry object in ${join(config.globalRoot, "settings.json")}`, "CONFIG_INVALID");
    }
    const retry = { ...(settings.retry as Record<string, unknown> | undefined) };
    if (retry.provider !== undefined && !record(retry.provider)) {
      throw new ConfigServiceError(409, `Invalid retry.provider object in ${join(config.globalRoot, "settings.json")}`, "CONFIG_INVALID");
    }
    const provider = { ...(retry.provider as Record<string, unknown> | undefined) };
    if (value.timeoutMs === null) delete provider.timeoutMs;
    else provider.timeoutMs = value.timeoutMs;
    retry.provider = provider;
    return { settings: { ...settings, retry }, result: undefined };
  });
}

export function createProviderTimeoutSettingsService(
  config: ConfigFileService,
  live: Pick<LiveConfiguration, "providerTimeoutSettings" | "synchronize">,
) {
  const get = async (): Promise<ProviderTimeoutSettingsDto> => {
    await live.synchronize();
    return { ...live.providerTimeoutSettings };
  };
  return { get, async patch(value: unknown) { await patchGlobalProviderTimeout(config, value); return get(); } };
}
