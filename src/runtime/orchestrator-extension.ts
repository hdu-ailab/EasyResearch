import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { importPi } from "./pi-import";
import { subagentTool } from "../subagent/tool";
import { webSearchTool } from "../tools/duckduckgo-search";
import { mountWelcomeBanner } from "../tui/welcome-banner";
import { createLogger } from "./logger";
import { mountPiEventLogger, type PiEventBus } from "./pi-event-logger";

export interface OrchestratorExtensionOptions {
  agentsDir?: string;
}

export function loadOrchestratorPrompt(agentsDir: string): string {
  const path = join(agentsDir, "orchestrator.md");
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    throw new Error("Missing global orchestrator definition: expected ~/.lazyresearch/agent/agents/orchestrator.md");
  }
  const frontmatter = parseFrontmatter(content);
  if (frontmatter == null || Object.keys(frontmatter.frontmatter ?? {}).length === 0) {
    throw new Error(`Invalid orchestrator definition: ${path} is missing frontmatter`);
  }
  return frontmatter.body.trim();
}

export function createOrchestratorExtension(options: OrchestratorExtensionOptions = {}): InlineExtension {
  return async (pi) => {
    const { getAgentDir } = await importPi();
    const prompt = loadOrchestratorPrompt(options.agentsDir ?? join(getAgentDir(), "agents"));
    pi.registerTool(subagentTool);
    pi.registerTool(webSearchTool);
    mountWelcomeBanner(pi);
    const isRpcChild = process.env.LAZYRESEARCH_RPC_CHILD === "1";
    if (!isRpcChild) {
      const logger = createLogger("orchestrator");
      mountPiEventLogger(pi as unknown as PiEventBus, logger);
      logger.info("orchestrator session started", { cwd: process.cwd() });
    }
    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n\n${prompt}`,
    }));
    // ADR-018: project config is always trusted; suppress Pi's trust prompt.
    pi.on("project_trust", () => ({ trusted: "yes" as const }));
  };
}

export default createOrchestratorExtension();