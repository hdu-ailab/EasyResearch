import { AGENT_THINKING_ENTRY, extractAgentThinking, resolveEffectiveThinking, DEFAULT_THINKING_LEVEL } from "../subagent/thinking-resolution";
import { importPi } from "../runtime/pi-import";
import type { AgentEffectiveThinkingDto, ConfigScope } from "./contracts";
import type { ConfigFileService } from "./config-files";
import { PAPER_ASSISTANT_AGENT } from "../subagent/agents";
import { readFollowGlobalFlag } from "./agent-follow-global";
import { readSessionOverrides, type EntryRow } from "./agent-models";

export type { EntryRow } from "./agent-models";

export class AgentThinkingError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function readThinkingOverrideForAgent(rows: EntryRow[], agentName: string): string | null | undefined {
  let found: string | null | undefined;
  for (const row of rows) {
    if (row.type !== "custom" || row.customType !== AGENT_THINKING_ENTRY) continue;
    const d = row.data as { agent?: string; thinking?: string | null } | undefined;
    if (d?.agent !== agentName) continue;
    found = typeof d.thinking === "string" ? d.thinking : null;
  }
  return found;
}

export async function writeThinkingOverride(sessionPath: string | undefined, agentName: string, thinking: string | null): Promise<void> {
  if (!sessionPath) {
    throw new Error("Active session has no session file to persist thinking overrides");
  }
  const { SessionManager } = await importPi();
  const session = await SessionManager.open(sessionPath);
  await session.appendCustomEntry(AGENT_THINKING_ENTRY, { agent: agentName, thinking });
}

/** Read agent thinking frontmatter from the requested Markdown configuration layer. */
export async function readAgentThinking(
  config: ConfigFileService,
  input: { scope: ConfigScope; cwd?: string },
): Promise<Record<string, string> | undefined> {
  return extractAgentThinking(input.cwd ?? process.cwd(), config.globalRoot, input.scope === "project", input.scope);
}

/** Read the configured Paper Assistant thinking default, preferring the project Markdown layer. */
export async function readPaperAssistantThinkingDefault(
  config: ConfigFileService,
  cwd: string,
): Promise<string | undefined> {
  const project = await extractAgentThinking(cwd, config.globalRoot, true, "project");
  const global = await extractAgentThinking(cwd, config.globalRoot, false, "global");
  return project?.[PAPER_ASSISTANT_AGENT] ?? global?.[PAPER_ASSISTANT_AGENT];
}

/**
 * Route a set-agent-thinking request: the Paper Assistant's thinking level is
 * applied live through RPC `set_thinking_level`, stage agents get a custom
 * entry on the Paper Assistant session line. `null` resets the Paper Assistant
 * to its Markdown default (or off when unset) and clears stage agent overrides.
 */
export async function routeSetAgentThinking(
  router: {
    isPaperAssistant: (agentName: string) => boolean;
    isKnownAgent: (agentName: string) => boolean | Promise<boolean>;
    setPaperAssistant: (level: string) => Promise<void>;
    writeOverride: (agentName: string, thinking: string | null) => Promise<void>;
    paperAssistantDefault: () => Promise<string | undefined>;
  },
  agentName: string,
  thinking: string | null,
): Promise<void> {
  if (!(await router.isKnownAgent(agentName))) {
    throw new AgentThinkingError(404, `Unknown agent: ${agentName}`);
  }
  if (router.isPaperAssistant(agentName)) {
    const level = thinking === null ? (await router.paperAssistantDefault()) ?? DEFAULT_THINKING_LEVEL : thinking;
    await router.setPaperAssistant(level);
    return;
  }
  await router.writeOverride(agentName, thinking);
}

export function resolveAgentThinkingService(deps: {
  listAgents: (cwd?: string) => Promise<Array<{ name: string }>>;
  getSessionPath: (id: string) => Promise<string | undefined>;
  readEntries: (sessionPath: string | undefined) => Promise<EntryRow[]>;
  projectAgentThinking: (cwd: string) => Promise<Record<string, string> | undefined>;
  globalAgentThinking: () => Promise<Record<string, string> | undefined>;
  paperAssistantThinking: (id: string) => Promise<string | undefined>;
  getCwd: (id: string) => Promise<string>;
}) {
  return {
    async effective(id: string): Promise<AgentEffectiveThinkingDto[]> {
      const cwd = await deps.getCwd(id);
      const agents = await deps.listAgents(cwd);
      const sessionPath = await deps.getSessionPath(id);
      const rows = await deps.readEntries(sessionPath);
      const project = await deps.projectAgentThinking(cwd);
      const global = await deps.globalAgentThinking();
      const paperAssistantThinking = await deps.paperAssistantThinking(id);
      const out: AgentEffectiveThinkingDto[] = [];
      const followGlobal = readFollowGlobalFlag(rows);
      for (const agent of agents) {
        if (agent.name === PAPER_ASSISTANT_AGENT && followGlobal) {
          const paDefault = project?.[PAPER_ASSISTANT_AGENT] ?? global?.[PAPER_ASSISTANT_AGENT];
          if (paDefault !== undefined) {
            out.push({ name: agent.name, thinking: paDefault, source: "default" });
            continue;
          }
          out.push({ name: agent.name, thinking: paperAssistantThinking ?? null, source: "inherit" });
          continue;
        }
        // The Paper Assistant's live session level is its own session override.
        const override =
          agent.name === PAPER_ASSISTANT_AGENT ? paperAssistantThinking : readThinkingOverrideForAgent(rows, agent.name);
        const resolved = resolveEffectiveThinking(override, project, global, paperAssistantThinking, agent.name);
        out.push(
          resolved
            ? { name: agent.name, thinking: resolved.thinking, source: resolved.source }
            : { name: agent.name, thinking: null, source: "inherit" },
        );
      }
      return out;
    },
    async set(id: string, agentName: string, thinking: string | null): Promise<void> {
      const sessionPath = await deps.getSessionPath(id);
      await writeThinkingOverride(sessionPath, agentName, thinking);
    },
  };
}
