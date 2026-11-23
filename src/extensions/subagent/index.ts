import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AgentRuntimeBinding } from "../../runtime/agent-runtime-binding";
import { createLogger } from "../../runtime/logger";
import { mountPiEventLogger, type PiEventBus } from "../../runtime/pi-event-logger";
import type { SubagentCoordinator } from "../../subagent/coordinator";
import { createSubagentDispatchExtension } from "../subagent-dispatch";
import type { SubagentSupervisor } from "../../subagent/supervisor";
import type { CreateSubagentToolOptions } from "../../subagent/tool";

export interface SubagentExtensionOptions {
  binding: AgentRuntimeBinding;
  liveConfiguration: CreateSubagentToolOptions["liveConfiguration"];
  coordinator: SubagentCoordinator;
  supervisor: SubagentSupervisor;
}

/** Stage dispatch follows the accepted caller row and target catalog. */
export function createSubagentExtension(options: SubagentExtensionOptions): InlineExtension {
  return async (pi) => {
    await (createSubagentDispatchExtension(options) as ExtensionFactory)(pi);
    const logger = createLogger("stage-agent");
    mountPiEventLogger(pi as unknown as PiEventBus, logger);
    logger.info("stage agent runtime started", { cwd: process.cwd() });
    pi.on("project_trust", () => ({ trusted: "yes" as const }));
  };
}

export default createSubagentExtension;
