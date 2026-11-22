import type { LiveConfiguration } from "../runtime/live-configuration";
import type { SessionTitleSettingsDto } from "./contracts";
import { ConfigServiceError, type ConfigFileService } from "./config-files";

export { parseGlobalSessionTitleSettings } from "../runtime/session-title";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function patchGlobalSessionTitleSettings(config: ConfigFileService, value: unknown): Promise<void> {
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.autoSessionTitle !== "boolean") {
    throw new ConfigServiceError(400, "Session title settings require only boolean autoSessionTitle");
  }
  await config.mutateGlobalSettings((settings) => {
    if (settings.easyresearch !== undefined && !isRecord(settings.easyresearch)) {
      throw new ConfigServiceError(409, "easyresearch must contain an object", "CONFIG_INVALID");
    }
    const easyresearch = { ...(settings.easyresearch as Record<string, unknown> | undefined) };
    if (easyresearch.web !== undefined && !isRecord(easyresearch.web)) {
      throw new ConfigServiceError(409, "easyresearch.web must contain an object", "CONFIG_INVALID");
    }
    easyresearch.web = { ...(easyresearch.web as Record<string, unknown> | undefined), autoSessionTitle: value.autoSessionTitle };
    return { settings: { ...settings, easyresearch }, result: undefined };
  });
}

export function createSessionTitleSettingsService(config: ConfigFileService, live: Pick<LiveConfiguration, "sessionTitleSettings" | "synchronize">) {
  const get = async (): Promise<SessionTitleSettingsDto> => {
    await live.synchronize();
    return { ...live.sessionTitleSettings };
  };
  return { get, async patch(value: unknown) { await patchGlobalSessionTitleSettings(config, value); return get(); } };
}
