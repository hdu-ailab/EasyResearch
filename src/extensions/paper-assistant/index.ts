import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentRuntimeBinding } from "../../runtime/agent-runtime-binding";
import { createAgentDefinitionExtension } from "../agent-definition";

/**
 * Paper Assistant keeps its named bundled extension while sharing the common
 * live Agent-definition lifecycle with stage/custom runtimes.
 */
export function createPaperAssistantExtension(binding: AgentRuntimeBinding): ExtensionFactory {
  return createAgentDefinitionExtension(binding);
}
