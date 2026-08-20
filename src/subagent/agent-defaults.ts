import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir, importPi } from "../runtime/pi-import";
import { isThinkingLevel } from "../thinking-levels";

export interface AgentRuntimeDefault {
  model?: string;
  thinking?: ThinkingLevel;
}

export type AgentRuntimeDefaults = Record<string, AgentRuntimeDefault>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidModelReference(value: unknown): value is string {
  if (typeof value !== "string" || /\s/.test(value)) return false;
  const segments = value.split("/");
  return segments.length > 1 && segments.every((segment) => segment.length > 0);
}

export function parseAgentDefaults(settings: unknown): AgentRuntimeDefaults {
  if (!isRecord(settings)) return {};
  const easyresearch = settings.easyresearch;
  if (easyresearch === undefined) return {};
  if (!isRecord(easyresearch)) throw new Error("Invalid easyresearch settings");
  const value = easyresearch.agentDefaults;
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("Invalid Agent defaults");

  const defaults: AgentRuntimeDefaults = {};
  for (const [name, rawEntry] of Object.entries(value)) {
    if (!name.trim() || !isRecord(rawEntry)) throw new Error("Invalid Agent default entry");
    if (Object.keys(rawEntry).some((key) => key !== "model" && key !== "thinking")) {
      throw new Error("Invalid Agent default field");
    }
    if (rawEntry.model !== undefined && !isValidModelReference(rawEntry.model)) {
      throw new Error("Invalid Agent default model");
    }
    if (rawEntry.thinking !== undefined && !isThinkingLevel(rawEntry.thinking)) {
      throw new Error("Invalid Agent default thinking");
    }
    defaults[name] = {
      ...(typeof rawEntry.model === "string" ? { model: rawEntry.model } : {}),
      ...(isThinkingLevel(rawEntry.thinking) ? { thinking: rawEntry.thinking } : {}),
    };
  }
  return defaults;
}

export async function readGlobalAgentDefaults(agentDir: string = getAgentDir()): Promise<AgentRuntimeDefaults> {
  const { SettingsManager } = await importPi();
  const settings = SettingsManager.create(agentDir, agentDir);
  const global = settings.getGlobalSettings() as unknown;
  if (settings.drainErrors().some((entry) => entry.scope === "global")) {
    throw new Error("Unable to load global Agent defaults");
  }
  return parseAgentDefaults(global);
}
