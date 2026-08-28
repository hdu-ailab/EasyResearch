import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AgentRuntimeBinding } from "../../runtime/agent-runtime-binding";
import type { SubagentCoordinator } from "../../subagent/coordinator";
import {
  AgentConfigurationChangedError,
  filterAgentsByAllowlist,
  withCurrentAgentCatalog,
} from "../../subagent/dispatch-authorization";
import {
  createSubagentTool,
  formatSubagentDescription,
} from "../../subagent/tool";
import type { SubagentSupervisor } from "../../subagent/supervisor";
import type { CreateSubagentToolOptions } from "../../subagent/tool";

/**
 * ADR-063: atomic extension registering the `subagent` dispatch tool for the
 * Research Assistant runtime. Each extension instance closes over the coordinator
 * and direct-child supervisor owned by one root AgentSession.
 */
export interface SubagentDispatchExtensionOptions {
  binding: AgentRuntimeBinding;
  liveConfiguration: CreateSubagentToolOptions["liveConfiguration"];
  coordinator: SubagentCoordinator;
  supervisor: SubagentSupervisor;
}

/** Research Assistant dispatch follows the accepted caller row and target catalog. */
export function createSubagentDispatchExtension(options: SubagentDispatchExtensionOptions): InlineExtension {
  return (pi) => {
    const callerAgent = options.binding.current().name;
    const makeTool = (available: readonly string[]) => createSubagentTool({
      coordinator: options.coordinator,
      supervisor: options.supervisor,
      liveConfiguration: options.liveConfiguration,
      callerAgent,
      description: formatSubagentDescription(available),
    });
    const setDispatchActive = (enabled: boolean) => {
      const active = pi.getActiveTools();
      const next = enabled
        ? [...new Set([...active, "subagent"])]
        : active.filter((name) => name !== "subagent");
      if (next.length !== active.length || next.some((name, index) => name !== active[index])) {
        pi.setActiveTools(next);
      }
    };
    pi.on("session_start", async (_event, ctx) => {
      setDispatchActive(false);
      try {
        await withCurrentAgentCatalog(options.liveConfiguration, ctx.cwd, ({ generation, agents }) => {
          if (options.binding.generation() !== generation) return;
          const caller = options.binding.current();
          const available = filterAgentsByAllowlist(agents, caller.subagents, callerAgent);
          const canDispatch = caller.enabled && caller.subagents?.length !== 0;
          if (
            options.binding.generation() !== generation ||
            options.liveConfiguration.generation !== generation
          ) return;
          if (canDispatch) pi.registerTool(makeTool(available.map((agent) => agent.name)));
          setDispatchActive(canDispatch && (caller.tools === undefined || caller.tools.includes("subagent")));
        }, { maxGenerationRetries: 0 });
      } catch (error) {
        if (error instanceof AgentConfigurationChangedError) return;
        throw error;
      }
    });
  };
}

export default createSubagentDispatchExtension;
