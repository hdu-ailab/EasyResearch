import type { AgentCatalogSnapshot } from "../subagent/agents";
import { RESEARCH_ASSISTANT_AGENT } from "../subagent/agents";

export interface DanglingAgentModelRepair {
  agentName: string;
  danglingModel: string;
  replacementModel?: string;
}

export interface AgentDefaultRepairResult {
  status: "repaired" | "unchanged";
  repairedAgents: string[];
}

export function planDanglingAgentDefaultRepairs(
  snapshot: AgentCatalogSnapshot,
  registeredModels: readonly { provider: string; id: string }[],
  fallbackModel?: { provider: string; id: string },
): DanglingAgentModelRepair[] {
  const registered = new Set(registeredModels.map((model) => `${model.provider}/${model.id}`));
  const fallback = fallbackModel ? `${fallbackModel.provider}/${fallbackModel.id}` : undefined;
  const repairs: DanglingAgentModelRepair[] = [];
  for (const definition of snapshot.definitions) {
    const model = snapshot.defaults?.[definition.name]?.model;
    if (model === undefined || registered.has(model)) continue;
    repairs.push({
      agentName: definition.name,
      danglingModel: model,
      ...(definition.name === RESEARCH_ASSISTANT_AGENT && fallback !== undefined
        ? { replacementModel: fallback }
        : {}),
    });
  }
  return repairs;
}

interface SettingsMutator {
  mutateGlobalSettings<T>(
    mutate: (settings: Record<string, unknown>) => {
      settings: Record<string, unknown>;
      result: T;
      write?: boolean;
    },
    options?: { notify?: boolean },
  ): Promise<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compare-and-set only model fields that still contain the rejected reference. */
export function repairDanglingAgentDefaults(
  mutator: SettingsMutator,
  repairs: readonly DanglingAgentModelRepair[],
): Promise<AgentDefaultRepairResult> {
  return mutator.mutateGlobalSettings<AgentDefaultRepairResult>((settings) => {
    const easyresearchValue = settings.easyresearch;
    if (!isRecord(easyresearchValue)) {
      return {
        settings,
        result: { status: "unchanged", repairedAgents: [] },
        write: false,
      };
    }
    const defaultsValue = easyresearchValue.agentDefaults;
    if (!isRecord(defaultsValue)) {
      return {
        settings,
        result: { status: "unchanged", repairedAgents: [] },
        write: false,
      };
    }

    const defaults = { ...defaultsValue };
    const repairedAgents: string[] = [];
    for (const repair of repairs) {
      const current = defaults[repair.agentName];
      if (!isRecord(current) || current.model !== repair.danglingModel) continue;
      const entry = { ...current };
      if (repair.replacementModel === undefined) delete entry.model;
      else entry.model = repair.replacementModel;
      if (Object.keys(entry).length === 0) delete defaults[repair.agentName];
      else defaults[repair.agentName] = entry;
      repairedAgents.push(repair.agentName);
    }
    if (repairedAgents.length === 0) {
      return {
        settings,
        result: { status: "unchanged", repairedAgents },
        write: false,
      };
    }

    const easyresearch = { ...easyresearchValue };
    if (Object.keys(defaults).length === 0) delete easyresearch.agentDefaults;
    else easyresearch.agentDefaults = defaults;
    const next = { ...settings };
    if (Object.keys(easyresearch).length === 0) delete next.easyresearch;
    else next.easyresearch = easyresearch;
    return {
      settings: next,
      result: { status: "repaired", repairedAgents },
    };
  }, { notify: false });
}
