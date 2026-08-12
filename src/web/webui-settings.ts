import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WebuiSettingsDto, WebuiSettingsUpdate } from "./contracts";
import type { ConfigFileService } from "./config-files";
import { getAgentDir } from "../runtime/pi-import";
import { discoverGlobalAgents, PAPER_ASSISTANT_AGENT, type AgentConfig } from "../subagent/agents";
import { readTextFile, updateFrontmatter, writeTextFile } from "./agent-markdown";

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

function globalAgentPath(agent: AgentConfig, agentDir: string): string {
  const target = join(agentDir, "agents", `${agent.name}.md`);
  if (agent.source === "global") return agent.filePath;
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  if (!existsSync(target)) cpSync(agent.filePath, target);
  return target;
}

async function globalAgents(config: ConfigFileService): Promise<AgentConfig[]> {
  return (await discoverGlobalAgents({ agentDir: config.globalRoot })).agents;
}

export async function readWebuiSettings(config: ConfigFileService): Promise<WebuiSettingsDto> {
  const agents = await globalAgents(config);
  const agentModels = Object.fromEntries(agents.flatMap((agent) => (agent.model ? [[agent.name, agent.model]] : [])));
  return {
    agentModels,
    paperAssistantModel: agents.find((agent) => agent.name === PAPER_ASSISTANT_AGENT)?.model ?? null,
    effectivePaperAssistantModel: null,
  };
}

function validatePatch(patch: WebuiSettingsUpdate): void {
  const known = new Set(["agentModels", "paperAssistantModel"]);
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
      parseModelRef(model);
    }
  }
  if (patch.paperAssistantModel !== undefined && patch.paperAssistantModel !== null) {
    if (typeof patch.paperAssistantModel !== "string") {
      throw new WebuiSettingsError(400, 'paperAssistantModel must be a "provider/id" string or null');
    }
    parseModelRef(patch.paperAssistantModel);
  }
}

async function updateAgentModel(config: ConfigFileService, agent: AgentConfig, model: string | null): Promise<void> {
  const path = globalAgentPath(agent, config.globalRoot);
  const content = readTextFile(path);
  writeTextFile(path, updateFrontmatter(content, { model }));
}

export async function updateWebuiSettings(config: ConfigFileService, patch: WebuiSettingsUpdate): Promise<WebuiSettingsDto> {
  validatePatch(patch);
  const agents = await globalAgents(config);
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  if (patch.agentModels !== undefined) {
    for (const agent of agents) {
      await updateAgentModel(config, agent, patch.agentModels[agent.name] ?? null);
    }
    for (const [name, model] of Object.entries(patch.agentModels)) {
      const agent = byName.get(name);
      if (!agent) throw new WebuiSettingsError(404, `Unknown agent: ${name}`);
      await updateAgentModel(config, agent, model);
    }
  }
  if (patch.paperAssistantModel !== undefined) {
    const paperAssistant = byName.get(PAPER_ASSISTANT_AGENT);
    if (!paperAssistant) throw new WebuiSettingsError(404, `Unknown agent: ${PAPER_ASSISTANT_AGENT}`);
    await updateAgentModel(config, paperAssistant, patch.paperAssistantModel);
  }
  return readWebuiSettings(config);
}

const PI_DEFAULT_MODEL_PER_PROVIDER: Record<string, string> = {
  "amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
  anthropic: "claude-opus-4-8",
  openai: "gpt-5.5",
  "openai-codex": "gpt-5.5",
  google: "gemini-3.1-pro-preview",
  "google-vertex": "gemini-3.1-pro-preview",
  openrouter: "moonshotai/kimi-k2.6",
  deepseek: "deepseek-v4-pro",
};

export function pickEffectivePaperAssistantModel(
  configured: string | null,
  available: ReadonlyArray<{ provider: string; id: string }>,
): string | null {
  if (configured) return configured;
  for (const [provider, id] of Object.entries(PI_DEFAULT_MODEL_PER_PROVIDER)) {
    if (available.some((model) => model.provider === provider && model.id === id)) return `${provider}/${id}`;
  }
  const first = available[0];
  return first ? `${first.provider}/${first.id}` : null;
}

export async function readEffectiveWebuiSettings(
  config: ConfigFileService,
  available?: ReadonlyArray<{ provider: string; id: string }>,
): Promise<WebuiSettingsDto> {
  const settings = await readWebuiSettings(config);
  if (settings.paperAssistantModel) {
    return { ...settings, effectivePaperAssistantModel: settings.paperAssistantModel };
  }
  if (!available) {
    const { ModelRuntime } = await import("../runtime/pi-import").then(({ importPi }) => importPi());
    available = await (await ModelRuntime.create()).getAvailable();
  }
  return { ...settings, effectivePaperAssistantModel: pickEffectivePaperAssistantModel(null, available) };
}
