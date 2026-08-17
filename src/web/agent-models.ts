import { AGENT_MODEL_ENTRY, extractAgentModels, resolveEffectiveModel } from "../subagent/model-resolution";
import { importPi } from "../runtime/pi-import";
import type { AgentEffectiveModelDto, ConfigScope } from "./contracts";
import type { ConfigFileService } from "./config-files";
import { ConfigPathError, ConfigServiceError } from "./config-files";
import { PAPER_ASSISTANT_AGENT } from "../subagent/agents";
import { readFollowGlobalFlag } from "./agent-follow-global";

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
 * to the in-process session runtime.
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

/** Read agent model frontmatter from the requested Markdown configuration layer. */
export async function readAgentModels(
  config: ConfigFileService,
  input: { scope: ConfigScope; cwd?: string },
): Promise<Record<string, string> | undefined> {
  return extractAgentModels(input.cwd ?? process.cwd(), config.globalRoot, input.scope === "project", input.scope);
}

/** Read the configured Paper Assistant model, preferring the project Markdown layer. */
export async function readPaperAssistantDefaults(
  config: ConfigFileService,
  cwd: string,
): Promise<{ provider: string; modelId: string } | undefined> {
  const project = await extractAgentModels(cwd, config.globalRoot, true, "project");
  const global = await extractAgentModels(cwd, config.globalRoot, false, "global");
  const model = project?.[PAPER_ASSISTANT_AGENT] ?? global?.[PAPER_ASSISTANT_AGENT];
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
 * Route a set-agent-model request: the Paper Assistant's model is the session
 * model itself (RPC `set_model`), stage agents get a custom entry on the
 * Paper Assistant session line. `null` resets the Paper Assistant to the configured
 * default model or fails with 409.
 */
export async function routeSetAgentModel(
  router: {
    isPaperAssistant: (agentName: string) => boolean;
    isKnownAgent: (agentName: string) => boolean | Promise<boolean>;
    setPaperAssistant: (provider: string, modelId: string) => Promise<void>;
    writeOverride: (agentName: string, model: string | null) => Promise<void>;
    paperAssistantDefaults: () => Promise<{ provider: string; modelId: string } | undefined>;
  },
  agentName: string,
  model: string | null,
): Promise<void> {
  if (!(await router.isKnownAgent(agentName))) {
    throw new AgentModelError(404, `Unknown agent: ${agentName}`);
  }
  if (router.isPaperAssistant(agentName)) {
    if (model === null) {
      const defaults = await router.paperAssistantDefaults();
      if (!defaults) {
        throw new AgentModelError(
          409,
          "No default model configured: set model in the Paper Assistant Markdown definition",
        );
      }
      await router.setPaperAssistant(defaults.provider, defaults.modelId);
      return;
    }
    const { provider, modelId } = splitModelRef(model);
    await router.setPaperAssistant(provider, modelId);
    return;
  }
  await router.writeOverride(agentName, model);
}

export function resolveAgentModelsService(deps: {
  listAgents: (cwd?: string) => Promise<Array<{ name: string }>>;
  getSessionPath: (id: string) => Promise<string | undefined>;
  readEntries: (sessionPath: string | undefined) => Promise<EntryRow[]>;
  projectAgentModels: (cwd: string) => Promise<Record<string, string> | undefined>;
  globalAgentModels: () => Promise<Record<string, string> | undefined>;
  paperAssistantModel: (id: string) => Promise<string | undefined>;
  getCwd: (id: string) => Promise<string>;
}) {
  return {
    async effective(id: string): Promise<AgentEffectiveModelDto[]> {
      const cwd = await deps.getCwd(id);
      const agents = await deps.listAgents(cwd);
      const sessionPath = await deps.getSessionPath(id);
      const rows = await deps.readEntries(sessionPath);
      const project = await deps.projectAgentModels(cwd);
      const global = await deps.globalAgentModels();
      const paperAssistantModel = await deps.paperAssistantModel(id);
      const out: AgentEffectiveModelDto[] = [];
      const followGlobal = readFollowGlobalFlag(rows);
      for (const agent of agents) {
        if (agent.name === PAPER_ASSISTANT_AGENT && followGlobal) {
          const paProject = project?.[PAPER_ASSISTANT_AGENT];
          const paGlobal = global?.[PAPER_ASSISTANT_AGENT];
          if (paProject !== undefined || paGlobal !== undefined) {
            out.push({
              name: agent.name,
              model: paProject ?? paGlobal!,
              source: paProject !== undefined ? "project" : "global",
            });
            continue;
          }
          out.push({ name: agent.name, model: paperAssistantModel ?? null, source: "inherit" });
          continue;
        }
        const override = readOverrideForAgent(rows, agent.name);
        const resolved = resolveEffectiveModel(override, project, global, paperAssistantModel, agent.name);
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
