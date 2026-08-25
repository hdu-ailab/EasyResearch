import type { ApiUsageSettingsDto } from "../web/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ApiUsageSettingsError extends Error {
  override readonly name = "ApiUsageSettingsError";
}

export function parseGlobalApiUsageSettings(settings: unknown): ApiUsageSettingsDto {
  if (!isRecord(settings)) throw new ApiUsageSettingsError("Global settings must contain an object");
  const rawEasyResearch = settings.easyresearch;
  if (rawEasyResearch !== undefined && !isRecord(rawEasyResearch)) {
    throw new ApiUsageSettingsError("easyresearch settings must contain an object");
  }
  const rawWeb = (rawEasyResearch as Record<string, unknown> | undefined)?.web;
  if (rawWeb !== undefined && !isRecord(rawWeb)) {
    throw new ApiUsageSettingsError("easyresearch.web must contain an object");
  }
  const configured = (rawWeb as Record<string, unknown> | undefined)?.showApiUsageDetails;
  if (configured !== undefined && typeof configured !== "boolean") {
    throw new ApiUsageSettingsError("showApiUsageDetails must be a boolean");
  }
  return { showApiUsageDetails: configured ?? false };
}
