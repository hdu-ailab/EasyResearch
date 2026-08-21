import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AgentRuntimeBinding } from "../runtime/agent-runtime-binding";
import type { LiveConfiguration } from "../runtime/live-configuration";
import { createPaperAssistantExtension } from "./paper-assistant";
import { createSubagentDispatchExtension } from "./subagent-dispatch";
import { createWelcomeBannerExtension } from "./welcome-banner";
import { createEventLoggerExtension } from "./event-logger";
import { createProjectTrustExtension } from "./project-trust";
import duckDuckGoSearchExtension from "./web-search";
import webFetchExtension from "./webfetch";
import { createWebTreeExtension } from "./web-tree";
import { createSessionNameExtension } from "./session-name";
import type { SubagentCoordinator } from "../subagent/coordinator";
import type { SubagentSupervisor } from "../subagent/supervisor";
import windowsPowerShellExtension from "./windows-powershell";

/**
 * Bundled extensions mounted as named inline factories in Paper Assistant
 * sessions.
 *
 * Mirrors upstream Pi's `extensionFactories` SDK channel. Bundled extensions
 * are never loaded from runtime filesystem paths (ADR-073).
 *
 * ADR-063: the former monolithic paper-assistant extension is atomized. Each
 * entry below owns exactly one responsibility (definition application, subagent
 * dispatch, welcome banner, event logger, project trust, or Web tools). Agent
 * status transport is owned by the runtime supervisor (ADR-087).
 *
 * Stage factories are assembled lazily by `subagent/stage-session.ts` to avoid
 * a static cycle through the dispatch tool.
 */
export interface BundledExtension {
  name: string;
  /** Pi SDK inline-extension channel. */
  factory: InlineExtension;
}

export interface AssistantExtensionRuntime {
  binding: AgentRuntimeBinding;
  liveConfiguration: Pick<
    LiveConfiguration,
    "generation" | "synchronize" | "isCurrent" | "resolveAgents" | "subscribe"
  >;
  coordinator: SubagentCoordinator;
  supervisor: SubagentSupervisor;
}

export function createAssistantExtensions(runtime: AssistantExtensionRuntime): BundledExtension[] {
  return [
    {
      name: "windows-powershell",
      factory: windowsPowerShellExtension,
    },
    {
      name: "paper-assistant",
      factory: createPaperAssistantExtension(runtime.binding),
    },
    {
      name: "subagent-dispatch",
      factory: createSubagentDispatchExtension(runtime),
    },
    {
      name: "welcome-banner",
      factory: createWelcomeBannerExtension(),
    },
    {
      name: "event-logger",
      factory: createEventLoggerExtension(),
    },
    {
      name: "project-trust",
      factory: createProjectTrustExtension(),
    },
    {
      name: "web-search",
      factory: duckDuckGoSearchExtension,
    },
    {
      name: "webfetch",
      factory: webFetchExtension,
    },
    {
      name: "web-tree",
      factory: createWebTreeExtension(),
    },
    {
      name: "session-name",
      factory: createSessionNameExtension(),
    },
  ];
}
