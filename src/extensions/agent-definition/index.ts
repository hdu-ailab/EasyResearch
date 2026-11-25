import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentRuntimeBinding } from "../../runtime/agent-runtime-binding";
import { selectAgentTools } from "../../subagent/agents";

/** Apply the binding through Pi's real reload lifecycle for any Agent role. */
export function createAgentDefinitionExtension(
  binding: AgentRuntimeBinding,
  platform: NodeJS.Platform = process.platform,
): ExtensionFactory {
  return (pi) => {
    pi.on("session_start", () => {
      const agent = binding.current();
      const activeTools = selectAgentTools(agent, pi.getAllTools(), platform);
      pi.setActiveTools(activeTools);
      binding.refreshTools?.();
    });
    pi.on("before_agent_start", (event) => {
      // File extensions run before this host inline extension. Pi applies this
      // loadout directly, so filtering runtime.setActiveTools alone is insufficient.
      const allowed = new Set(selectAgentTools(binding.current(), pi.getAllTools(), platform));
      event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter(name => allowed.has(name));
    });
    pi.on("resources_discover", () => ({ skillPaths: binding.skillPaths() }));
    pi.on("model_select", async (_event, ctx) => {
      try {
        await binding.reapplyCompaction();
      } catch (error) {
        ctx.abort();
        throw error;
      }
    });
    // Pi 1.6 permits reload only after the entire run, including recovery, ends.
    pi.on("agent_settled", async () => binding.ensureCurrent());
  };
}

export default createAgentDefinitionExtension;
