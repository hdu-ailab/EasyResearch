import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentRuntimeBinding } from "../../runtime/agent-runtime-binding";
import { normalizeLocalShellTools } from "../../runtime/platform-tools";

/** Apply the binding through Pi's real reload lifecycle for any Agent role. */
export function createAgentDefinitionExtension(
  binding: AgentRuntimeBinding,
  platform: NodeJS.Platform = process.platform,
): ExtensionFactory {
  return (pi) => {
    pi.on("session_start", () => {
      const agent = binding.current();
      const activeTools = agent.tools === undefined
        ? pi.getAllTools().map(({ name }) => name)
        : normalizeLocalShellTools(agent.tools, platform);
      pi.setActiveTools(activeTools);
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
