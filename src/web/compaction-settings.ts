import { isValidCompactionTriggerPercent } from "../runtime/compaction-policy";
import type { LiveConfiguration } from "../runtime/live-configuration";
import type { CompactionSettingsDto, CompactionSettingsPatchDto } from "./contracts";
import { ConfigServiceError, type ConfigFileService } from "./config-files";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePatch(value: unknown): CompactionSettingsPatchDto {
  if (!isRecord(value)) throw new ConfigServiceError(400, "Compaction settings patch must be an object");
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "triggerPercent") {
    throw new ConfigServiceError(400, "Compaction settings patch must include only triggerPercent");
  }
  if (!isValidCompactionTriggerPercent(value.triggerPercent)) {
    throw new ConfigServiceError(400, "triggerPercent must be an integer from 10 through 90");
  }
  return { triggerPercent: value.triggerPercent };
}

export interface CompactionSettingsService {
  get(): Promise<CompactionSettingsDto>;
  patch(value: unknown): Promise<CompactionSettingsDto>;
}

export function createCompactionSettingsService(
  config: ConfigFileService,
  live: Omit<Pick<LiveConfiguration, "compactionPolicy" | "synchronize">, "synchronize"> & {
    synchronize(): Promise<unknown>;
  },
): CompactionSettingsService {
  const get = async (): Promise<CompactionSettingsDto> => {
    await live.synchronize();
    const policy = live.compactionPolicy;
    return {
      triggerPercent: policy.triggerPercent,
      globalEnabled: policy.globalEnabled,
    };
  };
  return {
    get,
    async patch(value) {
      await patchGlobalCompactionTrigger(config, value);
      return get();
    },
  };
}

export async function patchGlobalCompactionTrigger(
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
    const rawCompaction = easyresearch.compaction;
    if (rawCompaction !== undefined && !isRecord(rawCompaction)) {
      throw new ConfigServiceError(409, "easyresearch.compaction must contain an object", "CONFIG_INVALID");
    }
    easyresearch.compaction = {
      ...(rawCompaction as Record<string, unknown> | undefined),
      triggerPercent: patch.triggerPercent,
    };
    return {
      settings: { ...settings, easyresearch },
      result: undefined,
    };
  });
}
