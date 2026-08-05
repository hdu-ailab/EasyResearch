import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { importPi } from "./pi-import";
import { subagentTool } from "../subagent/tool";

export interface OrchestratorExtensionOptions {
  agentsDir?: string;
}

export function loadOrchestratorPrompt(agentsDir: string): string {
  const path = join(agentsDir, "orchestrator.md");
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    throw new Error("Missing global orchestrator definition: expected ~/.lazypaper/agent/agents/orchestrator.md");
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
    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n\n${prompt}`,
    }));
  };
}

export default createOrchestratorExtension();