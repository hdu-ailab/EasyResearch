import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentRuntimeBinding } from "../../runtime/agent-runtime-binding";
import { normalizeLocalShellTools } from "../../runtime/platform-tools";

/** Apply the binding through Pi's real reload lifecycle for any Agent role. */
export function createAgentDefinitionExtension(
  binding: AgentRuntimeBinding,
  platform: NodeJS.Platform = process.platform,
): ExtensionFactory {
  return (pi) => {
    const applyAtActiveBoundary = async (_event: unknown, ctx: { abort(): void }) => {
      try {
        await binding.ensureCurrent({ activeBoundary: true });
      } catch (error) {
        ctx.abort();
        throw error;
      }
    };
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
    pi.on("turn_end", applyAtActiveBoundary);
    pi.on("agent_end", applyAtActiveBoundary);
  };
}

export default createAgentDefinitionExtension;
