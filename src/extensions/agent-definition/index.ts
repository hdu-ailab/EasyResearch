import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentRuntimeBinding } from "../../runtime/agent-runtime-binding";

/** Apply the binding through Pi's real reload lifecycle for any Agent role. */
export function createAgentDefinitionExtension(binding: AgentRuntimeBinding): ExtensionFactory {
  return (pi) => {
    pi.on("session_start", () => {
      const agent = binding.current();
      pi.setActiveTools(agent.tools ?? pi.getAllTools().map(({ name }) => name));
    });
    pi.on("resources_discover", () => ({ skillPaths: binding.skillPaths() }));
    pi.on("turn_end", async (_event, ctx) => {
      try {
        await binding.ensureCurrent({ activeBoundary: true });
      } catch (error) {
        ctx.abort();
        throw error;
      }
    });
  };
}

export default createAgentDefinitionExtension;
