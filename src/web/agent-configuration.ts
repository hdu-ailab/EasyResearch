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

export async function patchGlobalAgent(
  config: ConfigFileService,
  name: string,
  patch: AgentConfigurationPatch,
  modelExists: ModelExists,
  options: { repairUnknownModels?: boolean } = {},
): Promise<AgentResourceDto> {
  validatePatch(patch);
  const current = await readGlobalAgent(config, name);
  if (
    typeof patch.model === "string"
    && !(await modelExists(patch.model))
    && options.repairUnknownModels !== true
  ) {
    invalidPatch(`Configured model is not available: ${patch.model}`);
  }

  await config.mutateGlobalSettings((settings) => {
    try {
      parseAgentDefaults(settings);
    } catch {
      invalidPatch("Global Agent defaults are invalid");
    }
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
    return { settings: next, result: undefined };
  });
  return readGlobalAgent(config, current.name);
}

export function createAgentPatchService(
  config: ConfigFileService,
  listModels: ListModels,
  options: { repairUnknownModels?: boolean } = {},
): (name: string, patch: AgentConfigurationPatch) => Promise<AgentResourceDto> {
  return async (name, patch) => {
    let modelReferences: Promise<Set<string>> | undefined;
    let requestedModelKnown = true;
    const saved = await patchGlobalAgent(config, name, patch, async (reference) => {
      modelReferences ??= listModels().then(
        (models) => new Set(models.map((model) => `${model.provider}/${model.id}`)),
      );
      requestedModelKnown = (await modelReferences).has(reference);
      return requestedModelKnown;
    }, options);
    if (
      options.repairUnknownModels === true
      && typeof patch.model === "string"
      && saved.model !== patch.model
    ) {
      return {
        ...saved,
        modelRepair: {
          requested: patch.model,
          ...(saved.model === undefined ? { inherited: true } : { applied: saved.model, inherited: false }),
        },
      };
    }
    return saved;
  };
}
