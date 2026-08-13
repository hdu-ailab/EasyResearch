import { fileURLToPath } from "node:url";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createPaperAssistantExtension } from "./paper-assistant";
import duckDuckGoSearchExtension from "./web-search";

/**
 * Bundled extensions mounted in the assistant (TUI + Web RPC) processes.
 *
 * Mirrors upstream Pi's `dist/extensions/index.js` (builtInExtensions merged
 * into `extensionFactories` in `main()`), extended with a `path` so spawned
 * children can load the same extension via the CLI `--extension` channel.
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
    name: "web-search",
    factory: duckDuckGoSearchExtension,
    path: fileURLToPath(new URL("./web-search/index.ts", import.meta.url)),
  },
];
