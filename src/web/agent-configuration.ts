import { isThinkingLevel } from "../thinking-levels";
import { isValidModelReference, parseAgentDefaults } from "../subagent/agent-defaults";
import { readGlobalAgent } from "./agent-resources";
import type { AgentConfigurationPatch, AgentResourceDto, ModelOptionDto } from "./contracts";
import type { ConfigFileService } from "./config-files";
import { ConfigServiceError } from "./config-files";

type ModelExists = (model: string) => boolean | Promise<boolean>;
type ListModels = () => Promise<readonly Pick<ModelOptionDto, "provider" | "id">[]>;

function invalidPatch(message: string): never {
  throw new ConfigServiceError(400, message);
}

function validatePatch(patch: AgentConfigurationPatch): void {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    invalidPatch("Agent patch must be an object");
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) invalidPatch("Agent patch must include model or thinking");
  for (const key of keys) {
    if (key !== "model" && key !== "thinking") invalidPatch(`Unknown Agent patch field: ${key}`);
  }
  if (Object.hasOwn(patch, "model")) {
    if (patch.model !== null && typeof patch.model !== "string") {
      invalidPatch('model must be a "provider/id" string or null');
    }
    if (typeof patch.model === "string" && !isValidModelReference(patch.model)) {
      invalidPatch('model must be a non-empty "provider/id" string or null');
    }
  }
  if (Object.hasOwn(patch, "thinking") && patch.thinking !== null && !isThinkingLevel(patch.thinking)) {
    invalidPatch("thinking must be a valid thinking level or null");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readGlobalSettings(config: ConfigFileService): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await config.read({ scope: "global", path: "settings.json" });
  } catch (error) {
    if (error instanceof ConfigServiceError && error.status === 404) return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    invalidPatch("Global settings.json is invalid");
  }
  if (!isRecord(parsed)) invalidPatch("Global settings.json must contain an object");
  try {
    parseAgentDefaults(parsed);
  } catch {
    invalidPatch("Global Agent defaults are invalid");
  }
  return parsed;
}

export async function patchGlobalAgent(
  config: ConfigFileService,
  name: string,
  patch: AgentConfigurationPatch,
  modelExists: ModelExists,
): Promise<AgentResourceDto> {
  validatePatch(patch);
  const current = await readGlobalAgent(config, name);
  if (typeof patch.model === "string" && !(await modelExists(patch.model))) {
    invalidPatch(`Configured model is not available: ${patch.model}`);
  }

  const settings = await readGlobalSettings(config);
  const easyresearch = isRecord(settings.easyresearch) ? { ...settings.easyresearch } : {};
  const defaults = isRecord(easyresearch.agentDefaults) ? { ...easyresearch.agentDefaults } : {};
  const existing = isRecord(defaults[name]) ? defaults[name] : {};
  const entry = { ...existing };
  if (Object.hasOwn(patch, "model")) {
    if (patch.model === null) delete entry.model;
    else entry.model = patch.model;
  }
  if (Object.hasOwn(patch, "thinking")) {
    if (patch.thinking === null) delete entry.thinking;
    else entry.thinking = patch.thinking;
  }
  if (Object.keys(entry).length === 0) delete defaults[name];
  else defaults[name] = entry;
  if (Object.keys(defaults).length === 0) delete easyresearch.agentDefaults;
  else easyresearch.agentDefaults = defaults;
  const next = { ...settings };
  if (Object.keys(easyresearch).length === 0) delete next.easyresearch;
  else next.easyresearch = easyresearch;
  await config.write({
    scope: "global",
    path: "settings.json",
    content: `${JSON.stringify(next, null, 2)}\n`,
  });
  return readGlobalAgent(config, current.name);
}

export function createAgentPatchService(
  config: ConfigFileService,
  listModels: ListModels,
): (name: string, patch: AgentConfigurationPatch) => Promise<AgentResourceDto> {
  let pending = Promise.resolve();
  return (name, patch) => {
    const operation = pending.then(() => {
      let modelReferences: Promise<Set<string>> | undefined;
      return patchGlobalAgent(config, name, patch, async (reference) => {
        modelReferences ??= listModels().then(
          (models) => new Set(models.map((model) => `${model.provider}/${model.id}`)),
        );
        return (await modelReferences).has(reference);
      });
    });
    pending = operation.then(() => undefined, () => undefined);
    return operation;
  };
}
