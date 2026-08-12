import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../runtime/pi-import";
import { importPi } from "../runtime/pi-import";
import { isDotAgentsSkillEnabled, resolveEffectiveSkillNames } from "./skill-resolution";

export type AgentSource = "bundled" | "global" | "project";

export interface AgentConfig {
  name: string;
  description: string;
  enabled: boolean;
  builtin: boolean;
  tools?: string[];
  effectiveTools: string[];
  subagents?: string[];
  skills?: string[];
  effectiveSkills: string[];
  model?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
}

export const ASSISTANT_AGENT = "assistant";

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const BUILTIN_ALIASES: Record<string, string> = {
  assistant: "Paper Assistant",
  search: "检索",
  experiment: "实验",
  writing: "写作",
  figures: "图表",
};
const BUILTIN_ORDER = ["assistant", "search", "experiment", "writing", "figures"];

interface DiscoveryOptions {
  agentDir?: string;
  cwd?: string;
  bundledAgentsDir?: string;
  bundledSkillsDir?: string;
  homeDir?: string;
  includeProject?: boolean;
  includeGlobal?: boolean;
  includeBundled?: boolean;
  enableDotAgentsSkill?: boolean;
}

function bundledAgentsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "agents");
}

function sourceDirectory(options: DiscoveryOptions, source: AgentSource): string {
  if (source === "bundled") return options.bundledAgentsDir ? join(options.bundledAgentsDir, "agents") : bundledAgentsDir();
  if (source === "global") return join(options.agentDir ?? getAgentDir(), "agents");
  return join(options.cwd ?? process.cwd(), ".easyresearch", "agents");
}

function sourcePriority(options: DiscoveryOptions): Array<{ source: AgentSource; directory: string }> {
  return [
    ...(options.includeProject === false ? [] : [{ source: "project" as const, directory: sourceDirectory(options, "project") }]),
    ...(options.includeGlobal === false ? [] : [{ source: "global" as const, directory: sourceDirectory(options, "global") }]),
    ...(options.includeBundled === false ? [] : [{ source: "bundled" as const, directory: sourceDirectory(options, "bundled") }]),
  ];
}

function readMd(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (process.env.DEBUG_AGENT_DISCOVERY === "1") console.log("parse error", error);
    return undefined;
  }
}

type FrontmatterParser = <T extends Record<string, unknown>>(content: string) => { frontmatter: T; body: string };

function parseAgentFile(
  filePath: string,
  name: string,
  builtin: boolean,
  source: AgentSource,
  options: DiscoveryOptions,
  parseFrontmatter: FrontmatterParser,
  enableDotAgentsSkill: boolean,
): AgentConfig | undefined {
  const content = readMd(filePath);
  if (content === undefined) return undefined;
  try {
    const parsed = parseFrontmatter<Record<string, unknown>>(content);
    const frontmatter = parsed.frontmatter ?? {};
    if (typeof frontmatter.name !== "string" || !frontmatter.name.trim()) return undefined;
    const tools = stringArray(frontmatter.tools);
    const skills = stringArray(frontmatter.skills);
    const effectiveTools = tools ?? DEFAULT_TOOLS;
    const effectiveSkills = resolveEffectiveSkillNames(skills, {
      cwd: options.cwd ?? process.cwd(),
      agentDir: options.agentDir ?? getAgentDir(),
      homeDir: options.homeDir ?? homedir(),
      bundledSkillsDir: options.bundledSkillsDir,
      enableDotAgentsSkill,
    }) ?? [];
    return {
      name,
      description: typeof frontmatter.description === "string" && frontmatter.description.trim() ? frontmatter.description : name,
      enabled: frontmatter.enable !== false,
      builtin,
      tools,
      effectiveTools,
      skills,
      effectiveSkills,
      subagents: stringArray(frontmatter.subagents),
      model: typeof frontmatter.model === "string" && frontmatter.model ? frontmatter.model : undefined,
      systemPrompt: parsed.body.trim(),
      source,
      filePath,
    };
  } catch (error) {
    if (process.env.DEBUG_AGENT_DISCOVERY === "1") console.log("agent parse error", error);
    return undefined;
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function mdNames(directory: string): string[] {
  try {
    return readdirSync(directory).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
}

function pathForBuiltin(directory: string, name: string): string | undefined {
  const primary = join(directory, `${name}.md`);
  if (existsSync(primary)) return primary;
  const alias = BUILTIN_ALIASES[name];
  if (!alias) return undefined;
  const aliasPath = join(directory, `${alias}.md`);
  return existsSync(aliasPath) ? aliasPath : undefined;
}

function pathForCustom(directory: string, name: string): string {
  return join(directory, `${name}.md`);
}

function loadBuiltin(
  options: DiscoveryOptions,
  name: string,
  parseFrontmatter: FrontmatterParser,
  enableDotAgentsSkill: boolean,
): AgentConfig | undefined {
  for (const { source, directory } of sourcePriority(options)) {
    const path = pathForBuiltin(directory, name);
    if (!path) continue;
    const parsed = parseAgentFile(path, name, true, source, options, parseFrontmatter, enableDotAgentsSkill);
    if (parsed) return parsed;
  }
  return undefined;
}

function loadCustom(
  options: DiscoveryOptions,
  name: string,
  parseFrontmatter: FrontmatterParser,
  enableDotAgentsSkill: boolean,
): AgentConfig | undefined {
  for (const { source, directory } of sourcePriority(options).slice(0, 2)) {
    const path = pathForCustom(directory, name);
    if (!existsSync(path)) continue;
    const parsed = parseAgentFile(path, name, false, source, options, parseFrontmatter, enableDotAgentsSkill);
    if (parsed) return parsed;
  }
  return undefined;
}

export async function discoverAgents(options: DiscoveryOptions = {}): Promise<AgentDiscoveryResult> {
  const pi = await importPi();
  const settings = pi.SettingsManager
    ? pi.SettingsManager.create(options.cwd ?? process.cwd(), options.agentDir ?? getAgentDir()).getGlobalSettings()
    : undefined;
  const enableDotAgentsSkill = options.enableDotAgentsSkill ?? isDotAgentsSkillEnabled(settings);
  const agents: AgentConfig[] = [];
  for (const name of BUILTIN_ORDER) {
    const agent = loadBuiltin(options, name, pi.parseFrontmatter, enableDotAgentsSkill);
    if (agent) agents.push(agent);
  }
  const builtinNames = new Set(BUILTIN_ORDER);
  const customNames = new Set<string>();
  for (const directory of sourcePriority(options).slice(0, 2).map(({ directory }) => directory)) {
    for (const file of mdNames(directory)) {
      const stem = file.slice(0, -3);
      if (!builtinNames.has(stem) && !Object.values(BUILTIN_ALIASES).includes(stem)) customNames.add(stem);
    }
  }
  for (const name of [...customNames].sort((a, b) => a.localeCompare(b))) {
    const agent = loadCustom(options, name, pi.parseFrontmatter, enableDotAgentsSkill);
    if (agent) agents.push(agent);
  }
  return { agents };
}

export function filterEnabledAgents(agents: AgentConfig[]): AgentConfig[] {
  return agents.filter((agent) => agent.enabled);
}
