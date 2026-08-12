import type { MessageKey } from "./messages";
import { PAPER_ASSISTANT_AGENT } from "../agent-identity";

/** Roster agent ids mapped to their localized display-name keys (ADR-035). */
const AGENT_NAME_KEYS: Record<string, MessageKey> = {
  [PAPER_ASSISTANT_AGENT]: "agent.paperAssistant",
  search: "agent.search",
  experiment: "agent.experiment",
  writing: "agent.writing",
  figures: "agent.figures",
};

/** Roster agent ids mapped to their localized description keys (ADR-035). */
const AGENT_DESCRIPTION_KEYS: Record<string, MessageKey> = {
  [PAPER_ASSISTANT_AGENT]: "agentDesc.paperAssistant",
  search: "agentDesc.search",
  experiment: "agentDesc.experiment",
  writing: "agentDesc.writing",
  figures: "agentDesc.figures",
};

export type Translate = (key: MessageKey) => string;

/**
 * Localized display name for a roster agent id. Unknown or custom agent names
 * (dynamic data) fall back to the raw id untouched.
 */
export function agentDisplayName(t: Translate, rawName: string): string {
  const key = AGENT_NAME_KEYS[rawName.toLowerCase()];
  return key ? t(key) : rawName;
}

/**
 * Localized card description for a roster agent id. Unknown or custom agents
 * (dynamic data) fall back to the registry text untouched.
 */
export function agentDescription(t: Translate, rawName: string, rawDescription: string): string {
  const key = AGENT_DESCRIPTION_KEYS[rawName.toLowerCase()];
  return key ? t(key) : rawDescription;
}
