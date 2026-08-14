import { fileURLToPath } from "node:url";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createPaperAssistantExtension } from "./paper-assistant";
import { createSubagentDispatchExtension } from "./subagent-dispatch";
import { createWelcomeBannerExtension } from "./welcome-banner";
import { createEventLoggerExtension } from "./event-logger";
import { createProjectTrustExtension } from "./project-trust";
import duckDuckGoSearchExtension from "./web-search";
import webFetchExtension from "./webfetch";
import { createWebTreeExtension } from "./web-tree";

/**
 * Bundled extensions mounted in the assistant (TUI + Web RPC) processes.
 *
 * Mirrors upstream Pi's `dist/extensions/index.js` (builtInExtensions merged
 * into `extensionFactories` in `main()`), extended with a `path` so spawned
 * children can load the same extension via the CLI `--extension` channel.
 *
 * ADR-063: the former monolithic paper-assistant extension is atomized — each
 * entry below owns exactly one responsibility (definition application, subagent
 * dispatch, welcome banner, event logger, project trust, web search).
 *
 * The subagent (stage) extension is intentionally absent: it is only mounted in
 * stage-agent child processes, and its path lives in `src/subagent/tool.ts`
 * (kept there to avoid a static import cycle with `./paper-assistant`).
 */
export interface BundledExtension {
  name: string;
  /** In-process channel (TUI extensionFactories). */
  factory: InlineExtension;
  /** CLI channel (Web RPC child `--extension`). */
  path: string;
}

export const assistantExtensions: BundledExtension[] = [
  {
    name: "paper-assistant",
    factory: createPaperAssistantExtension(),
    path: fileURLToPath(new URL("./paper-assistant/index.ts", import.meta.url)),
  },
  {
    name: "subagent-dispatch",
    factory: createSubagentDispatchExtension(),
    path: fileURLToPath(new URL("./subagent-dispatch/index.ts", import.meta.url)),
  },
  {
    name: "welcome-banner",
    factory: createWelcomeBannerExtension(),
    path: fileURLToPath(new URL("./welcome-banner/index.ts", import.meta.url)),
  },
  {
    name: "event-logger",
    factory: createEventLoggerExtension(),
    path: fileURLToPath(new URL("./event-logger/index.ts", import.meta.url)),
  },
  {
    name: "project-trust",
    factory: createProjectTrustExtension(),
    path: fileURLToPath(new URL("./project-trust/index.ts", import.meta.url)),
  },
  {
    name: "web-search",
    factory: duckDuckGoSearchExtension,
    path: fileURLToPath(new URL("./web-search/index.ts", import.meta.url)),
  },
  {
    name: "webfetch",
    factory: webFetchExtension,
    path: fileURLToPath(new URL("./webfetch/index.ts", import.meta.url)),
  },
  {
    name: "web-tree",
    factory: createWebTreeExtension(),
    path: fileURLToPath(new URL("./web-tree/index.ts", import.meta.url)),
  },
];
