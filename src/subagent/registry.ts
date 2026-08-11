export interface AgentRegistryEntry {
  definition?: string;
  model?: string;
  tools?: string[];
  skills?: string[];
  subagents?: string[];
  /** true → remove the agent from discovery (ADR-034). Never applies to `assistant`. */
  disabled?: boolean;
}

export type AgentRegistry = Record<string, AgentRegistryEntry>;

const STRING_FIELD = ["definition", "model"] as const;
const STRING_ARRAY_FIELD = ["tools", "skills", "subagents"] as const;
const BOOLEAN_FIELD = ["disabled"] as const;

export function parseAgentRegistry(settings: unknown): AgentRegistry {
  const agents = (settings as { easyresearch?: { agents?: unknown } } | undefined)?.easyresearch?.agents;
  if (typeof agents !== "object" || agents === null || Array.isArray(agents)) return {};
  const out: AgentRegistry = {};
  for (const [name, value] of Object.entries(agents as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const entry: AgentRegistryEntry = {};
    for (const field of STRING_FIELD) {
      const v = (value as Record<string, unknown>)[field];
      if (typeof v === "string") entry[field] = v;
    }
    for (const field of STRING_ARRAY_FIELD) {
      const v = (value as Record<string, unknown>)[field];
      if (Array.isArray(v)) entry[field] = v.filter((x): x is string => typeof x === "string");
    }
    for (const field of BOOLEAN_FIELD) {
      const v = (value as Record<string, unknown>)[field];
      if (v === true || v === false) entry[field] = v;
    }
    out[name] = entry;
  }
  return out;
}

export function mergeAgentRegistry(project: AgentRegistry, global: AgentRegistry): AgentRegistry {
  const merged: AgentRegistry = { ...global };
  for (const [name, entry] of Object.entries(project)) {
    const current: AgentRegistryEntry = { ...(merged[name] ?? {}) };
    for (const field of STRING_FIELD) {
      const v = entry[field];
      if (v !== undefined) current[field] = v;
    }
    for (const field of STRING_ARRAY_FIELD) {
      const v = entry[field];
      if (v !== undefined) current[field] = v;
    }
    for (const field of BOOLEAN_FIELD) {
      const v = entry[field];
      if (v !== undefined) current[field] = v;
    }
    merged[name] = current;
  }
  return merged;
}

export function extractRegistryModels(registry: AgentRegistry): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(registry)) {
    if (typeof entry.model === "string" && entry.model !== "") out[name] = entry.model;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}