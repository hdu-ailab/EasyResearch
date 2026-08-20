import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { importPi } from "../runtime/pi-import";
import { discoverGlobalAgents, type AgentConfig } from "../subagent/agents";
import type { AgentResourceDto, SkillResourceDto } from "./contracts";
import type { ConfigFileService } from "./config-files";
import { ConfigServiceError } from "./config-files";
import { starterAgentMarkdown } from "./agent-markdown";
import { isDotAgentsSkillEnabled } from "../subagent/skill-resolution";
import { isThinkingLevel } from "../thinking-levels";

/**
 * Resolve the writable user-layer Agent file. Bundled content is written
 * directly to this target by ConfigFileService's atomic replacement.
 */
function globalAgentPath(config: ConfigFileService, agent: Pick<AgentConfig, "name" | "source" | "filePath">): string {
  const target = join(config.globalRoot, "agents", `${agent.name}.md`);
  if (agent.source === "global") return agent.filePath;
  return target;
}

function invalidFrontmatter(field: string): never {
  throw new ConfigServiceError(400, `Invalid Agent Markdown ${field} frontmatter`);
}

function validateNameList(field: string, value: unknown, allowEmptyValue: boolean): void {
  if (value === undefined || (allowEmptyValue && value === null)) return;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    invalidFrontmatter(field);
  }
}

function validateKnownFrontmatter(frontmatter: Record<string, unknown>, filenameIdentity: string): void {
  if (frontmatter.name !== filenameIdentity) {
    throw new ConfigServiceError(400, "Agent frontmatter name must match its filename");
  }
  if (frontmatter.description !== undefined && typeof frontmatter.description !== "string") {
    invalidFrontmatter("description");
  }
  if (frontmatter.enable !== undefined && typeof frontmatter.enable !== "boolean") {
    invalidFrontmatter("enable");
  }
  validateNameList("tools", frontmatter.tools, true);
  validateNameList("skills", frontmatter.skills, true);
  validateNameList("subagents", frontmatter.subagents, false);
}

export async function validateAgentMarkdown(
  filenameIdentity: string,
  content: string,
): Promise<Record<string, unknown>> {
  let frontmatter: Record<string, unknown>;
  try {
    const { parseFrontmatter } = await importPi();
    frontmatter = parseFrontmatter<Record<string, unknown>>(content).frontmatter ?? {};
  } catch {
    throw new ConfigServiceError(400, "Invalid Agent Markdown frontmatter");
  }
  validateKnownFrontmatter(frontmatter, filenameIdentity);
  return frontmatter;
}

export async function listGlobalAgents(config: ConfigFileService): Promise<AgentResourceDto[]> {
  const result = await discoverGlobalAgents({ agentDir: config.globalRoot });
  return result.agents.map((agent) => ({
    name: agent.name,
    description: agent.description,
    enabled: agent.enabled,
    builtin: agent.builtin,
    source: agent.source,
    filePath: agent.filePath,
    model: agent.model,
    thinking: isThinkingLevel(agent.thinking) ? agent.thinking : undefined,
    tools: agent.tools,
    effectiveTools: agent.effectiveTools,
    subagents: agent.subagents,
    skills: agent.skills,
    effectiveSkills: agent.effectiveSkills,
    missingSkills: agent.missingSkills,
  }));
}

/**
 * Serve the effective agent content (bundled or global) without writing any
 * user-layer override. Opening an editor never materializes a copy (ADR-058).
 */
export async function readGlobalAgent(config: ConfigFileService, name: string): Promise<AgentResourceDto> {
  const agent = (await listGlobalAgents(config)).find((item) => item.name === name);
  if (!agent) throw new ConfigServiceError(404, `unknown agent: ${name}`);
  const content = readFileSync(agent.filePath, "utf8");
  return { ...agent, filePath: agent.filePath, content };
}

/**
 * Save materializes a bundled agent into the global agents directory when no
 * user-layer copy exists, then writes the edited content (ADR-058).
 */
export async function writeGlobalAgent(config: ConfigFileService, name: string, content: string): Promise<AgentResourceDto> {
  const agent = (await listGlobalAgents(config)).find((item) => item.name === name);
  if (!agent) throw new ConfigServiceError(404, `unknown agent: ${name}`);
  const path = globalAgentPath(config, agent);
  await validateAgentMarkdown(basename(path, ".md"), content);
  await config.write({ scope: "global", path: path.slice(config.globalRoot.length + 1), content });
  return readGlobalAgent(config, name);
}

export async function createGlobalAgent(config: ConfigFileService, name: string): Promise<AgentResourceDto> {
  const trimmed = name.trim().replace(/\.md$/i, "");
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") {
    throw new ConfigServiceError(400, "invalid agent name");
  }
  const path = join(config.globalRoot, "agents", `${trimmed}.md`);
  if (existsSync(path)) throw new ConfigServiceError(409, `agent already exists: ${trimmed}`);
  const content = starterAgentMarkdown(trimmed);
  await validateAgentMarkdown(trimmed, content);
  await config.write({ scope: "global", path: `agents/${trimmed}.md`, content });
  return readGlobalAgent(config, trimmed);
}

function skillDirectories(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function listGlobalSkills(config: ConfigFileService): Promise<SkillResourceDto[]> {
  const bundledRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
  const roots: Array<{ root: string; source: SkillResourceDto["source"] }> = [
    { root: join(config.globalRoot, "skills"), source: "global" as const },
    { root: bundledRoot, source: "bundled" as const },
  ];
  let enableDotAgentsSkill = false;
  try {
    const settings = JSON.parse(await config.read({ scope: "global", path: "settings.json" })) as unknown;
    enableDotAgentsSkill = isDotAgentsSkillEnabled(settings);
  } catch {
    enableDotAgentsSkill = false;
  }
  if (enableDotAgentsSkill) roots.splice(1, 0, { root: join(homedir(), ".agents", "skills"), source: "home" as const });
  const names = new Set(roots.flatMap(({ root }) => skillDirectories(root)));
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => {
    const chosen = roots.find(({ root }) => existsSync(join(root, name, "SKILL.md"))) ?? roots[0]!;
    return {
      name,
      source: chosen.source,
      path: join(chosen.root, name),
      skillPath: join(chosen.root, name, "SKILL.md"),
    };
  });
}

/**
 * Serve the effective skill content (bundled/global/home) without creating any
 * user-layer skill directory. Opening an editor never materializes a copy
 * (ADR-058).
 */
export async function readGlobalSkill(config: ConfigFileService, name: string): Promise<SkillResourceDto> {
  const skill = (await listGlobalSkills(config)).find((item) => item.name === name);
  if (!skill) throw new ConfigServiceError(404, `unknown skill: ${name}`);
  const content = readFileSync(skill.skillPath, "utf8");
  return { ...skill, content };
}

/**
 * Save materializes a bundled/home skill directory into the global skills
 * directory when no user-layer copy exists, then writes the edited SKILL.md
 * (ADR-058).
 */
export async function writeGlobalSkill(config: ConfigFileService, name: string, content: string): Promise<SkillResourceDto> {
  const skill = (await listGlobalSkills(config)).find((item) => item.name === name);
  if (!skill) throw new ConfigServiceError(404, `unknown skill: ${name}`);
  if (skill.source === "bundled" || skill.source === "home") {
    const target = join(config.globalRoot, "skills", name);
    if (!existsSync(target)) {
      mkdirSync(join(config.globalRoot, "skills"), { recursive: true });
      cpSync(skill.path, target, { recursive: true });
    }
    skill.path = target;
    skill.skillPath = join(target, "SKILL.md");
    skill.source = "global";
  }
  await config.write({ scope: "global", path: skill.skillPath.slice(config.globalRoot.length + 1), content });
  return readGlobalSkill(config, name);
}
