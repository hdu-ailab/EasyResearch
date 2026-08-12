import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { importPi } from "./pi-import";
import { createSubagentTool } from "../subagent/tool";
import { SUBAGENT_SESSION_LINK_ENTRY } from "../subagent/session-links";
import { webSearchTool } from "../tools/duckduckgo-search";
import { mountWelcomeBanner } from "../tui/welcome-banner";
import { createLogger } from "./logger";
import { mountPiEventLogger, type PiEventBus } from "./pi-event-logger";

export interface AssistantExtensionOptions {
  agentsDir?: string;
}

export async function loadAssistantPrompt(
  agentsDir: string,
  parseFrontmatter?: <T extends Record<string, unknown>>(content: string) => { frontmatter: T; body: string },
): Promise<string> {
  const path = join(agentsDir, "assistant.md");
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    throw new Error("Missing global assistant definition: expected ~/.easyresearch/agent/agents/assistant.md");
  }
  const parser = parseFrontmatter ?? (await importPi()).parseFrontmatter;
  const frontmatter = parser(content);
  if (frontmatter == null || Object.keys(frontmatter.frontmatter ?? {}).length === 0) {
    throw new Error(`Invalid assistant definition: ${path} is missing frontmatter`);
  }
  return frontmatter.body.trim();
}

export function createAssistantExtension(options: AssistantExtensionOptions = {}): InlineExtension {
  return async (pi) => {
    const { getAgentDir, parseFrontmatter } = await importPi();
    const prompt = await loadAssistantPrompt(options.agentsDir ?? join(getAgentDir(), "agents"), parseFrontmatter);
    pi.registerTool(createSubagentTool({
      persistSessionLink: (link) => pi.appendEntry(SUBAGENT_SESSION_LINK_ENTRY, link),
    }));
    pi.registerTool(webSearchTool);
    mountWelcomeBanner(pi);
    const isRpcChild = process.env.EASYRESEARCH_RPC_CHILD === "1";
    if (!isRpcChild) {
      const logger = createLogger("assistant");
      mountPiEventLogger(pi as unknown as PiEventBus, logger);
      logger.info("assistant session started", { cwd: process.cwd() });
    }
    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n\n${prompt}`,
    }));
    // ADR-018: project config is always trusted; suppress Pi's trust prompt.
    pi.on("project_trust", () => ({ trusted: "yes" as const }));
  };
}

export default createAssistantExtension();
