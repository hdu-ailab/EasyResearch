import { AGENT_MODEL_ENTRY, extractAgentModels, resolveEffectiveModel } from "../subagent/model-resolution";
import { parseAgentRegistry } from "../subagent/registry";
import { importPi } from "../runtime/pi-import";
import type { AgentEffectiveModelDto, ConfigScope } from "./contracts";
import type { ConfigFileService } from "./config-files";
import { ConfigPathError, ConfigServiceError } from "./config-files";

export interface EntryRow {
  type: string;
  customType?: string;
  data?: unknown;
}

export class AgentModelError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function readOverrideForAgent(rows: EntryRow[], agentName: string): string | null | undefined {
  let found: string | null | undefined;
  for (const row of rows) {
    if (row.type !== "custom" || row.customType !== AGENT_MODEL_ENTRY) continue;
    const d = row.data as { agent?: string; model?: string | null } | undefined;
    if (d?.agent !== agentName) continue;
    found = typeof d.model === "string" ? d.model : null;
  }
  return found;
}

/**
 * Split a `"provider/id"` model string on the first slash. Anything without a
 * non-empty provider and model id is a client error, not something to forward
 * to the RPC child.
 */
export function splitModelRef(model: string): { provider: string; modelId: string } {
  const index = model.indexOf("/");
  if (index <= 0 || index === model.length - 1) {
    throw new AgentModelError(400, `Invalid model string (expected "provider/id"): ${model}`);
  }
  return { provider: model.slice(0, index), modelId: model.slice(index + 1) };
}

export async function readSessionOverrides(sessionPath: string | undefined): Promise<EntryRow[]> {
  if (!sessionPath) return [];
  const { SessionManager } = await importPi();
  const session = await SessionManager.open(sessionPath);
  return session.getEntries();
}

export async function writeAgentOverride(sessionPath: string | undefined, agentName: string, model: string | null): Promise<void> {
  if (!sessionPath) {
    throw new Error("Active session has no session file to persist model overrides");
  }
  const { SessionManager } = await importPi();
  const session = await SessionManager.open(sessionPath);
  await session.appendCustomEntry(AGENT_MODEL_ENTRY, { agent: agentName, model });
}

/**
 * Read `<root>/settings.json` via ConfigFileService and parse each agent's
 * `model` out of the `easyresearch.agents` registry. Absent settings files and
 * a registry with no models both mean "no config" (undefined); a malformed
 * file is a real error and propagates.
 */
export async function readAgentModels(
  config: ConfigFileService,
  input: { scope: ConfigScope; cwd?: string },
): Promise<Record<string, string> | undefined> {
  const settings = await readSettingsJson(config, input);
  return settings ? extractAgentModels(settings) : undefined;
}

function readAssistantRegistryModel(settings: Record<string, unknown> | undefined): string | undefined {
  if (!settings) return undefined;
  const model = parseAgentRegistry(settings)["assistant"]?.model;
  return typeof model === "string" && model !== "" ? model : undefined;
}

/**
 * Read the configured default model for the assistant reset: the project's
 * `easyresearch.agents.assistant.model` wins over the global one (per-field
 * merge, Pi-native semantics). Undefined when neither level configures a
 * `"provider/id"` model for the assistant.
 */
export async function readAssistantDefaults(
  config: ConfigFileService,
  cwd: string,
): Promise<{ provider: string; modelId: string } | undefined> {
  const global = await readSettingsJson(config, { scope: "global" });
  const project = await readSettingsJson(config, { scope: "project", cwd });
  const model = readAssistantRegistryModel(project) ?? readAssistantRegistryModel(global);
  if (model === undefined) return undefined;
  const index = model.indexOf("/");
  if (index <= 0 || index === model.length - 1) return undefined;
  return { provider: model.slice(0, index), modelId: model.slice(index + 1) };
}

async function readSettingsJson(
  config: ConfigFileService,
  input: { scope: ConfigScope; cwd?: string },
): Promise<Record<string, unknown> | undefined> {
  try {
    const content = await config.read({ ...input, path: "settings.json" });
    return JSON.parse(content) as Record<string, unknown>;
  } catch (error) {
    // Missing settings.json (ConfigPathError from read mode, ConfigServiceError
    // 404 from the missing-file check, and a raw ENOENT from root
    // canonicalization) all mean "no config", never a failure.
    if (error instanceof ConfigPathError) return undefined;
    if (error instanceof ConfigServiceError && error.status === 404) return undefined;
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Route a set-agent-model request: the assistant's model is the session
 * model itself (RPC `set_model`), stage agents get a custom entry on the
 * assistant session line. `null` resets the assistant to the configured
 * default model or fails with 409.
 */
export async function routeSetAgentModel(
  router: {
    isAssistant: (agentName: string) => boolean;
    isKnownAgent: (agentName: string) => boolean | Promise<boolean>;
    setAssistant: (provider: string, modelId: string) => Promise<void>;
    writeOverride: (agentName: string, model: string | null) => Promise<void>;
    assistantDefaults: () => Promise<{ provider: string; modelId: string } | undefined>;
  },
  agentName: string,
  model: string | null,
): Promise<void> {
  if (!(await router.isKnownAgent(agentName))) {
    throw new AgentModelError(404, `Unknown agent: ${agentName}`);
  }
  if (router.isAssistant(agentName)) {
    if (model === null) {
      const defaults = await router.assistantDefaults();
      if (!defaults) {
        throw new AgentModelError(
          409,
          "No default model configured: set easyresearch.agents.assistant.model in settings.json",
        );
      }
      await router.setAssistant(defaults.provider, defaults.modelId);
      return;
    }
    const { provider, modelId } = splitModelRef(model);
    await router.setAssistant(provider, modelId);
    return;
  }
  await router.writeOverride(agentName, model);
}

export function resolveAgentModelsService(deps: {
  listAgents: () => Promise<Array<{ name: string }>>;
  getSessionPath: (id: string) => Promise<string | undefined>;
  readEntries: (sessionPath: string | undefined) => Promise<EntryRow[]>;
  projectAgentModels: (cwd: string) => Promise<Record<string, string> | undefined>;
  globalAgentModels: () => Promise<Record<string, string> | undefined>;
  assistantModel: (id: string) => Promise<string | undefined>;
  getCwd: (id: string) => Promise<string>;
}) {
  return {
    async effective(id: string): Promise<AgentEffectiveModelDto[]> {
      const agents = await deps.listAgents();
      const sessionPath = await deps.getSessionPath(id);
      const rows = await deps.readEntries(sessionPath);
      const project = await deps.projectAgentModels(await deps.getCwd(id));
      const global = await deps.globalAgentModels();
      const orch = await deps.assistantModel(id);
      const out: AgentEffectiveModelDto[] = [];
      for (const agent of agents) {
        const override = readOverrideForAgent(rows, agent.name);
        const resolved = resolveEffectiveModel(override, project, global, orch, agent.name);
        out.push(
          resolved
            ? { name: agent.name, model: resolved.model, source: resolved.source }
            : { name: agent.name, model: null, source: "inherit" },
        );
      }
      return out;
    },
    async set(id: string, agentName: string, model: string | null): Promise<void> {
      const sessionPath = await deps.getSessionPath(id);
      await writeAgentOverride(sessionPath, agentName, model);
    },
  };
}
