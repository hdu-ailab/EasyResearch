import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AgentRuntimeBinding } from "../../runtime/agent-runtime-binding";
import type { LiveConfiguration } from "../../runtime/live-configuration";
import { createLogger } from "../../runtime/logger";
import { mountPiEventLogger, type PiEventBus } from "../../runtime/pi-event-logger";
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

export interface SubagentExtensionOptions {
  binding: AgentRuntimeBinding;
  liveConfiguration: Pick<
    LiveConfiguration,
    "generation" | "synchronize" | "acquireProject" | "isCurrent" | "resolveAgents" | "subscribe"
  >;
  coordinator: SubagentCoordinator;
  supervisor: SubagentSupervisor;
}

/** Stage dispatch follows the accepted caller row and target catalog. */
export function createSubagentExtension(options: SubagentExtensionOptions): InlineExtension {
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
    const logger = createLogger("stage-agent");
    mountPiEventLogger(pi as unknown as PiEventBus, logger);
    logger.info("stage agent runtime started", { cwd: process.cwd() });
    pi.on("project_trust", () => ({ trusted: "yes" as const }));
  };
}

export default createSubagentExtension;
