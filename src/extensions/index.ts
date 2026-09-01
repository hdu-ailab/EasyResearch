import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AgentRuntimeBinding } from "../runtime/agent-runtime-binding";
import { createResearchAssistantExtension } from "./research-assistant";
import { createSubagentDispatchExtension } from "./subagent-dispatch";
import { createWelcomeBannerExtension } from "./welcome-banner";
import { createEventLoggerExtension } from "./event-logger";
import { createProjectTrustExtension } from "./project-trust";
import webSearchExtension from "./web-search";
import webFetchExtension from "./webfetch";
import { createWebTreeExtension } from "./web-tree";
import { createSessionNameExtension } from "./session-name";
import { createSessionTimelineExtension } from "./session-timeline";
import { createSessionStatsExtension } from "./session-stats";
import type { SubagentCoordinator } from "../subagent/coordinator";
import type { SubagentSupervisor } from "../subagent/supervisor";
import type { CreateSubagentToolOptions } from "../subagent/tool";
import { createSshBashExtension } from "./ssh-bash";
import {
  createManualCompactionExtension,
  type ManualCompactionController,
} from "../web/manual-compaction";
import type { SessionStatsNotifier } from "../web/session-stats";

/**
 * Bundled extensions mounted as named inline factories in Research Assistant
 * sessions.
 *
 * Mirrors upstream Pi's `extensionFactories` SDK channel. Bundled extensions
 * are never loaded from runtime filesystem paths (ADR-073).
 *
 * ADR-063: the former monolithic research-assistant extension is atomized. Each
 * entry below owns exactly one responsibility (definition application,
 * subagent dispatch, timeline publication, welcome banner, event logger,
 * project trust, or Web tools). Agent status transport is owned by the runtime
 * supervisor (ADR-087).
 *
 * Stage factories are assembled lazily by `subagent/stage-session.ts` to avoid
 * a static cycle through the dispatch tool.
 */
export interface BundledExtension {
  name: string;
  /** Pi SDK inline-extension channel. */
  factory: ExtensionFactory;
}

function requireExtensionFactory(extension: InlineExtension): ExtensionFactory {
  if (typeof extension !== "function") {
    throw new TypeError("Bundled extension must be an inline factory.");
  }
  return extension;
}

export interface ResearchAssistantExtensionRuntime {
  binding: AgentRuntimeBinding;
  liveConfiguration: CreateSubagentToolOptions["liveConfiguration"];
  coordinator: SubagentCoordinator;
  supervisor: SubagentSupervisor;
  compaction: ManualCompactionController;
  stats: SessionStatsNotifier;
  publishTimelineEntry: (entry: unknown) => void;
}

export function createResearchAssistantExtensions(runtime: ResearchAssistantExtensionRuntime): BundledExtension[] {
  return [
    {
      name: "ssh-bash",
      factory: createSshBashExtension({ allowConfigure: true }),
    },
    {
      name: "research-assistant",
      factory: createResearchAssistantExtension(runtime.binding),
    },
    {
      name: "manual-compaction",
      factory: createManualCompactionExtension(runtime.compaction),
    },
    {
      name: "session-stats",
      factory: createSessionStatsExtension(runtime.stats),
    },
    {
      name: "session-timeline",
      factory: createSessionTimelineExtension(runtime.publishTimelineEntry),
    },
    {
      name: "subagent-dispatch",
      factory: requireExtensionFactory(createSubagentDispatchExtension(runtime)),
    },
    {
      name: "welcome-banner",
      factory: requireExtensionFactory(createWelcomeBannerExtension()),
    },
    {
      name: "event-logger",
      factory: requireExtensionFactory(createEventLoggerExtension()),
    },
    {
      name: "project-trust",
      factory: requireExtensionFactory(createProjectTrustExtension()),
    },
    {
      name: "web-search",
      factory: webSearchExtension,
    },
    {
      name: "webfetch",
      factory: webFetchExtension,
    },
    {
      name: "web-tree",
      factory: requireExtensionFactory(createWebTreeExtension()),
    },
    {
      name: "session-name",
      factory: requireExtensionFactory(createSessionNameExtension()),
    },
  ];
}
