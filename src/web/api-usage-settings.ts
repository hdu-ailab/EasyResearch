import type { LiveConfiguration } from "../runtime/live-configuration";
import type { ApiUsageSettingsDto, ApiUsageSettingsPatchDto } from "./contracts";
import { ConfigServiceError, type ConfigFileService } from "./config-files";

export { ApiUsageSettingsError, parseGlobalApiUsageSettings } from "../runtime/api-usage-settings";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePatch(value: unknown): ApiUsageSettingsPatchDto {
  if (!isRecord(value)) throw new ConfigServiceError(400, "API usage settings patch must be an object");
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "showApiUsageDetails" || typeof value.showApiUsageDetails !== "boolean") {
    throw new ConfigServiceError(400, "API usage settings patch must include only boolean showApiUsageDetails");
  }
  return { showApiUsageDetails: value.showApiUsageDetails };
}

export async function patchGlobalApiUsageSettings(
  config: ConfigFileService,
  value: unknown,
): Promise<void> {
  const patch = validatePatch(value);
  await config.mutateGlobalSettings((settings) => {
    const rawEasyResearch = settings.easyresearch;
    if (rawEasyResearch !== undefined && !isRecord(rawEasyResearch)) {
      throw new ConfigServiceError(409, "easyresearch settings must contain an object", "CONFIG_INVALID");
    }
    const easyresearch = { ...(rawEasyResearch as Record<string, unknown> | undefined) };
    const rawWeb = easyresearch.web;
    if (rawWeb !== undefined && !isRecord(rawWeb)) {
      throw new ConfigServiceError(409, "easyresearch.web must contain an object", "CONFIG_INVALID");
    }
    easyresearch.web = {
      ...(rawWeb as Record<string, unknown> | undefined),
      showApiUsageDetails: patch.showApiUsageDetails,
    };
    return { settings: { ...settings, easyresearch }, result: undefined };
  });
}

export interface ApiUsageSettingsService {
  get(): Promise<ApiUsageSettingsDto>;
  patch(value: unknown): Promise<ApiUsageSettingsDto>;
}

export function createApiUsageSettingsService(
  config: ConfigFileService,
  live: Omit<Pick<LiveConfiguration, "apiUsageSettings" | "synchronize">, "synchronize"> & {
    synchronize(): Promise<unknown>;
  },
): ApiUsageSettingsService {
  const get = async (): Promise<ApiUsageSettingsDto> => {
    await live.synchronize();
    return { ...live.apiUsageSettings };
  };
  return {
    get,
    async patch(value) {
      await patchGlobalApiUsageSettings(config, value);
      return get();
    },
  };
}
