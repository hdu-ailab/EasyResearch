import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createPaperAssistantExtension } from "./paper-assistant";
import { createSubagentDispatchExtension } from "./subagent-dispatch";
import { createWelcomeBannerExtension } from "./welcome-banner";
import { createEventLoggerExtension } from "./event-logger";
import { createProjectTrustExtension } from "./project-trust";
import duckDuckGoSearchExtension from "./web-search";
import webFetchExtension from "./webfetch";
import { createWebTreeExtension } from "./web-tree";
import { createSessionNameExtension } from "./session-name";
import { createAgentStatusExtension } from "./agent-status";

/**
 * Bundled extensions mounted as named inline factories in Paper Assistant
 * sessions.
 *
 * Mirrors upstream Pi's `extensionFactories` SDK channel. Bundled extensions
 * are never loaded from runtime filesystem paths (ADR-073).
 *
 * ADR-063: the former monolithic paper-assistant extension is atomized — each
 * entry below owns exactly one responsibility (definition application, subagent
 * dispatch, welcome banner, event logger, project trust, web search, agent
 * status per ADR-082).
 *
 * Stage factories are assembled lazily by `subagent/stage-session.ts` to avoid
 * a static cycle through the dispatch tool.
 */
export interface BundledExtension {
  name: string;
  /** Pi SDK inline-extension channel. */
  factory: InlineExtension;
}

export const assistantExtensions: BundledExtension[] = [
  {
    name: "paper-assistant",
    factory: createPaperAssistantExtension(),
  },
  {
    name: "subagent-dispatch",
    factory: createSubagentDispatchExtension(),
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
  {
    name: "agent-status",
    factory: createAgentStatusExtension(),
  },
];
