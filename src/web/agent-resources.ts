import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverGlobalAgents, type AgentConfig } from "../subagent/agents";
import type { AgentResourceDto, SkillResourceDto } from "./contracts";
import type { ConfigFileService } from "./config-files";
import { ConfigServiceError } from "./config-files";
import { starterAgentMarkdown } from "./agent-markdown";
import { isDotAgentsSkillEnabled } from "../subagent/skill-resolution";

function globalAgentPath(config: ConfigFileService, agent: Pick<AgentConfig, "name" | "source" | "filePath">): string {
  const target = join(config.globalRoot, "agents", `${agent.name}.md`);
  if (agent.source === "global") return agent.filePath;
  mkdirSync(join(config.globalRoot, "agents"), { recursive: true });
  if (!existsSync(target)) cpSync(agent.filePath, target);
  return target;
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
    tools: agent.tools,
    effectiveTools: agent.effectiveTools,
    subagents: agent.subagents,
    skills: agent.skills,
    effectiveSkills: agent.effectiveSkills,
    missingSkills: agent.missingSkills,
  }));
}

export async function readGlobalAgent(config: ConfigFileService, name: string): Promise<AgentResourceDto> {
  const agent = (await listGlobalAgents(config)).find((item) => item.name === name);
  if (!agent) throw new ConfigServiceError(404, `unknown agent: ${name}`);
  const path = globalAgentPath(config, agent);
  const content = await config.read({ scope: "global", path: path.slice(config.globalRoot.length + 1) });
  return { ...agent, filePath: path, content };
}

export async function writeGlobalAgent(config: ConfigFileService, name: string, content: string): Promise<AgentResourceDto> {
  const agent = (await listGlobalAgents(config)).find((item) => item.name === name);
  if (!agent) throw new ConfigServiceError(404, `unknown agent: ${name}`);
  const path = globalAgentPath(config, agent);
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
  await config.write({ scope: "global", path: `agents/${trimmed}.md`, content: starterAgentMarkdown(trimmed) });
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

export async function readGlobalSkill(config: ConfigFileService, name: string): Promise<SkillResourceDto> {
  const skill = (await listGlobalSkills(config)).find((item) => item.name === name);
  if (!skill) throw new ConfigServiceError(404, `unknown skill: ${name}`);
  if (skill.source === "bundled") {
    const target = join(config.globalRoot, "skills", name);
    if (!existsSync(target)) {
      mkdirSync(join(config.globalRoot, "skills"), { recursive: true });
      cpSync(skill.path, target, { recursive: true });
    }
    skill.path = target;
    skill.skillPath = join(target, "SKILL.md");
    skill.source = "global";
  }
  const content = await config.read({ scope: "global", path: skill.skillPath.slice(config.globalRoot.length + 1) });
  return { ...skill, content };
}

export async function writeGlobalSkill(config: ConfigFileService, name: string, content: string): Promise<SkillResourceDto> {
  const skill = await readGlobalSkill(config, name);
  await config.write({ scope: "global", path: skill.skillPath.slice(config.globalRoot.length + 1), content });
  return readGlobalSkill(config, name);
}
