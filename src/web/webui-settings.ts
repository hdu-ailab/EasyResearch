import type { WebuiSettingsDto, WebuiSettingsUpdate } from "./contracts";
import type { ConfigFileService } from "./config-files";
import { ConfigPathError, ConfigServiceError } from "./config-files";
import { importPi } from "../runtime/pi-import";
import { extractRegistryModels, parseAgentRegistry } from "../subagent/registry";

export class WebuiSettingsError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function parseModelRef(model: string): { provider: string; modelId: string } {
  const index = model.indexOf("/");
  if (index <= 0 || index === model.length - 1) {
    throw new WebuiSettingsError(400, `Invalid model string (expected "provider/id"): ${model}`);
  }
  return { provider: model.slice(0, index), modelId: model.slice(index + 1) };
}

function readAssistantFromRegistry(settings: Record<string, unknown> | undefined): string | null {
  const entry = settings ? parseAgentRegistry(settings)["assistant"] : undefined;
  const model = entry?.model;
  return typeof model === "string" && model !== "" ? model : null;
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
  return {
    agentModels: extractRegistryModels(parseAgentRegistry(settings)) ?? {},
    assistantModel: readAssistantFromRegistry(settings),
    effectiveAssistantModel: null,
  };
}

function validatePatch(patch: WebuiSettingsUpdate): void {
  const known = new Set(["agentModels", "assistantModel"]);
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
  if (patch.assistantModel !== undefined && patch.assistantModel !== null) {
    if (typeof patch.assistantModel !== "string") {
      throw new WebuiSettingsError(400, 'assistantModel must be a "provider/id" string or null');
    }
    parseModelRef(patch.assistantModel);
  }
}

export async function updateWebuiSettings(config: ConfigFileService, patch: WebuiSettingsUpdate): Promise<WebuiSettingsDto> {
  validatePatch(patch);
  const settings = (await readSettings(config)) ?? {};
  const lazy = (settings.easyresearch as Record<string, unknown> | undefined) ?? {};
  if (patch.agentModels !== undefined) {
    const agents = (lazy.agents as Record<string, unknown> | undefined) ?? {};
    const current = extractRegistryModels(parseAgentRegistry(settings)) ?? {};
    for (const name of Object.keys(current)) {
      if (name in patch.agentModels) continue;
      const entry = agents[name] as Record<string, unknown> | undefined;
      if (entry) delete entry.model;
    }
    for (const [name, model] of Object.entries(patch.agentModels)) {
      const entry = (agents[name] as Record<string, unknown> | undefined) ?? {};
      entry.model = model;
      agents[name] = entry;
    }
    lazy.agents = agents;
  }
  if (patch.assistantModel !== undefined) {
    const agents = (lazy.agents as Record<string, unknown> | undefined) ?? {};
    const entry = (agents["assistant"] as Record<string, unknown> | undefined) ?? {};
    if (patch.assistantModel === null) delete entry.model;
    else entry.model = patch.assistantModel;
    agents["assistant"] = entry;
    lazy.agents = agents;
  }
  (settings as Record<string, unknown>).easyresearch = lazy;
  await config.write({ scope: "global", path: "settings.json", content: JSON.stringify(settings, null, 2) });
  return readWebuiSettings(config);
}

/**
 * Pi's per-provider default model IDs, mirrored verbatim (key order included)
 * from `@earendil-works/pi-coding-agent@0.84.1` `dist/core/model-resolver.js`
 * `defaultModelPerProvider` — the package `exports` map blocks the deep import.
 * `findInitialModel` prefers the first provider whose default is available with
 * auth, so key order is part of the contract.
 */
const PI_DEFAULT_MODEL_PER_PROVIDER: Record<string, string> = {
  "amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
  "ant-ling": "Ring-2.6-1T",
  anthropic: "claude-opus-4-8",
  openai: "gpt-5.5",
  "azure-openai-responses": "gpt-5.4",
  "openai-codex": "gpt-5.5",
  radius: "auto",
  nvidia: "nvidia/nemotron-3-super-120b-a12b",
  deepseek: "deepseek-v4-pro",
  google: "gemini-3.1-pro-preview",
  "google-vertex": "gemini-3.1-pro-preview",
  "github-copilot": "gpt-5.4",
  openrouter: "moonshotai/kimi-k2.6",
  "vercel-ai-gateway": "zai/glm-5.1",
  xai: "grok-4.5",
  groq: "openai/gpt-oss-120b",
  cerebras: "zai-glm-4.7",
  zai: "glm-5.1",
  "zai-coding-cn": "glm-5.1",
  mistral: "devstral-medium-latest",
  minimax: "MiniMax-M2.7",
  "minimax-cn": "MiniMax-M2.7",
  moonshotai: "kimi-k2.6",
  "moonshotai-cn": "kimi-k2.6",
  huggingface: "moonshotai/Kimi-K2.6",
  fireworks: "accounts/fireworks/models/kimi-k2p6",
  together: "moonshotai/Kimi-K2.6",
  baseten: "zai-org/GLM-5.2",
  opencode: "kimi-k2.6",
  "opencode-go": "kimi-k2.6",
  "kimi-coding": "kimi-for-coding",
  "cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
  "cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
  "qwen-token-plan": "qwen3.7-max",
  "qwen-token-plan-cn": "qwen3.7-max",
  "qwen-token-plan-individual": "qwen3.8-max",
  xiaomi: "mimo-v2.5-pro",
  "xiaomi-token-plan-cn": "mimo-v2.5-pro",
  "xiaomi-token-plan-ams": "mimo-v2.5-pro",
  "xiaomi-token-plan-sgp": "mimo-v2.5-pro",
};

/**
 * The model a new assistant session would use, mirroring Pi's
 * `findInitialModel` fallback chain (model-resolver.js) for a fresh session
 * without CLI args or model scoping: the configured default pair if set, else
 * the first auth-available model matching Pi's per-provider default table, else
 * the first auth-available model, else null.
 */
export function pickEffectiveAssistantModel(
  configured: string | null,
  available: ReadonlyArray<{ provider: string; id: string }>,
): string | null {
  if (configured) return configured;
  for (const [provider, id] of Object.entries(PI_DEFAULT_MODEL_PER_PROVIDER)) {
    if (available.some((m) => m.provider === provider && m.id === id)) return `${provider}/${id}`;
  }
  const first = available[0];
  return first ? `${first.provider}/${first.id}` : null;
}

/**
 * `readWebuiSettings` plus the GET-only `effectiveAssistantModel` field: the
 * stored default when configured, otherwise the model Pi's `findInitialModel`
 * would pick for a fresh session over the auth-available models. Tests inject
 * `available`; the live server lets Pi resolve them via `ModelRuntime`.
 */
export async function readEffectiveWebuiSettings(
  config: ConfigFileService,
  available?: ReadonlyArray<{ provider: string; id: string }>,
): Promise<WebuiSettingsDto> {
  const settings = await readWebuiSettings(config);
  if (settings.assistantModel) return { ...settings, effectiveAssistantModel: settings.assistantModel };
  if (!available) {
    const { ModelRuntime } = await importPi();
    available = await (await ModelRuntime.create()).getAvailable();
  }
  return { ...settings, effectiveAssistantModel: pickEffectiveAssistantModel(null, available) };
}
