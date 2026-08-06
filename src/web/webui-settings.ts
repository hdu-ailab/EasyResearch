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

export async function readWebuiSettings(config: ConfigFileService): Promise<WebuiSettingsDto> {
  const settings = await readSettings(config);
  const lazy = ((settings?.lazyresearch ?? {}) as { agentModels?: unknown }).agentModels;
  return { agentModels: parseAgentModels(lazy) };
}

function validatePatch(patch: WebuiSettingsUpdate): void {
  const known = new Set(["agentModels"]);
  for (const key of Object.keys(patch)) {
    if (!known.has(key)) throw new WebuiSettingsError(400, `Unknown webui setting: ${key}`);
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
  if (patch.agentModels !== undefined) lazy.agentModels = patch.agentModels;
  (settings as Record<string, unknown>).lazyresearch = lazy;
  await config.write({ scope: "global", path: "settings.json", content: JSON.stringify(settings, null, 2) });
  return readWebuiSettings(config);
}
