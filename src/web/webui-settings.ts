import type { WebuiSettingsDto, WebuiSettingsUpdate } from "./contracts";
import type { ConfigFileService } from "./config-files";
import { ConfigPathError, ConfigServiceError } from "./config-files";

export class WebuiSettingsError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const DEFAULT_CHAT_FONT_SIZE = 13;
export const DEFAULT_FILES_FONT_SIZE = 12;
export const CHAT_FONT_MIN = 11;
export const CHAT_FONT_MAX = 18;
export const FILES_FONT_MIN = 10;
export const FILES_FONT_MAX = 16;

const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

function pickFontSize(value: unknown, fallback: number, min: number, max: number): number {
  return isInt(value) && value >= min && value <= max ? value : fallback;
}

function parseAgentModels(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [agent, model] of Object.entries(value as Record<string, unknown>)) {
    if (typeof model === "string") out[agent] = model;
  }
  return out;
}

async function readSettings(config: ConfigFileService): Promise<Record<string, unknown> | undefined> {
  try {
    const content = await config.read({ scope: "global", path: "settings.json" });
    return JSON.parse(content) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ConfigPathError) return undefined;
    if (error instanceof ConfigServiceError && error.status === 404) return undefined;
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) {
      throw new WebuiSettingsError(400, "settings.json is not valid JSON");
    }
    throw error;
  }
}

function extract(settings: Record<string, unknown> | undefined) {
  const lazy = (settings?.lazyresearch ?? {}) as { webui?: unknown; agentModels?: unknown };
  const webui = (lazy.webui ?? {}) as { chatFontSize?: unknown; filesFontSize?: unknown };
  return {
    webui,
    agentModels: lazy.agentModels,
  };
}

export async function readWebuiSettings(config: ConfigFileService): Promise<WebuiSettingsDto> {
  const settings = await readSettings(config);
  const { webui, agentModels } = extract(settings);
  return {
    chatFontSize: pickFontSize(webui.chatFontSize, DEFAULT_CHAT_FONT_SIZE, CHAT_FONT_MIN, CHAT_FONT_MAX),
    filesFontSize: pickFontSize(webui.filesFontSize, DEFAULT_FILES_FONT_SIZE, FILES_FONT_MIN, FILES_FONT_MAX),
    agentModels: parseAgentModels(agentModels),
  };
}

function validatePatch(patch: WebuiSettingsUpdate): void {
  const known = new Set(["chatFontSize", "filesFontSize", "agentModels"]);
  for (const key of Object.keys(patch)) {
    if (!known.has(key)) throw new WebuiSettingsError(400, `Unknown webui setting: ${key}`);
  }
  if (patch.chatFontSize !== undefined) {
    if (!isInt(patch.chatFontSize) || patch.chatFontSize < CHAT_FONT_MIN || patch.chatFontSize > CHAT_FONT_MAX) {
      throw new WebuiSettingsError(400, `chatFontSize must be an integer between ${CHAT_FONT_MIN} and ${CHAT_FONT_MAX}`);
    }
  }
  if (patch.filesFontSize !== undefined) {
    if (!isInt(patch.filesFontSize) || patch.filesFontSize < FILES_FONT_MIN || patch.filesFontSize > FILES_FONT_MAX) {
      throw new WebuiSettingsError(400, `filesFontSize must be an integer between ${FILES_FONT_MIN} and ${FILES_FONT_MAX}`);
    }
  }
  if (patch.agentModels !== undefined) {
    if (typeof patch.agentModels !== "object" || patch.agentModels === null || Array.isArray(patch.agentModels)) {
      throw new WebuiSettingsError(400, "agentModels must be an object of agent name to model string");
    }
    for (const [agent, model] of Object.entries(patch.agentModels)) {
      if (typeof model !== "string" || model === "") {
        throw new WebuiSettingsError(400, `agentModels entry ${agent} must be a non-empty "provider/id" string`);
      }
    }
  }
}

export async function updateWebuiSettings(config: ConfigFileService, patch: WebuiSettingsUpdate): Promise<WebuiSettingsDto> {
  validatePatch(patch);
  const settings = (await readSettings(config)) ?? {};
  const lazy = (settings.lazyresearch as Record<string, unknown> | undefined) ?? {};
  const webui = (lazy.webui as Record<string, unknown> | undefined) ?? {};
  if (patch.chatFontSize !== undefined) webui.chatFontSize = patch.chatFontSize;
  if (patch.filesFontSize !== undefined) webui.filesFontSize = patch.filesFontSize;
  if (patch.agentModels !== undefined) lazy.agentModels = patch.agentModels;
  lazy.webui = webui;
  (settings as Record<string, unknown>).lazyresearch = lazy;
  await config.write({ scope: "global", path: "settings.json", content: JSON.stringify(settings, null, 2) });
  return readWebuiSettings(config);
}
