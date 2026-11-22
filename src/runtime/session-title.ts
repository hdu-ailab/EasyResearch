import type { SessionTitleSettingsDto } from "../web/contracts";

export const AUTO_TITLE_ATTEMPT = "easyresearch:auto-title-attempt";
export const AUTO_TITLE_RESULT = "easyresearch:auto-title-result";

export function parseGlobalSessionTitleSettings(settings: unknown): SessionTitleSettingsDto {
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!record(settings)) throw new Error("Global settings must contain an object");
  const easyresearch = settings.easyresearch;
  if (easyresearch !== undefined && !record(easyresearch)) throw new Error("easyresearch must contain an object");
  const web = easyresearch?.web;
  if (web !== undefined && !record(web)) throw new Error("easyresearch.web must contain an object");
  const value = web?.autoSessionTitle;
  if (value !== undefined && typeof value !== "boolean") throw new Error("autoSessionTitle must be a boolean");
  return { autoSessionTitle: value ?? true };
}

export function normalizeSessionTitle(text: string): string {
  const line = text.split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? "";
  return Array.from(line.replace(/^[#\s"'“”‘’`]+|[\s"'“”‘’`]+$/gu, "").replace(/[\u0000-\u001f\u007f]/gu, " "))
    .slice(0, 80).join("").trim();
}
