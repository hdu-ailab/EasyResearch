import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bundledSourceRoot } from "../runtime/bundled-assets";
import { normalizeLocalShellTools } from "../runtime/platform-tools";
import { getAgentDir, importPi } from "../runtime/pi-import";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { readGlobalAgentDefaults, type AgentRuntimeDefaults } from "./agent-defaults";
import {
  type AcceptedSkillDescriptors,
  isDotAgentsSkillEnabled,
  resolveSkillSelection,
} from "./skill-resolution";

export type AgentSource = "global" | "bundled";

export interface AgentDefinition {
  name: string;
  description: string;
  enabled: boolean;
  builtin: boolean;
  tools?: string[];
  subagents?: string[];
  skills?: string[];
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentDiagnostic {
  agent: string;
  source: AgentSource;
  message: string;
}

export interface AgentCatalogSnapshot {
  definitions: readonly AgentDefinition[];
  diagnostics: readonly AgentDiagnostic[];
  defaults?: Readonly<AgentRuntimeDefaults>;
}

export interface AgentConfig extends AgentDefinition {
  model?: string;
  thinking?: ThinkingLevel;
  effectiveTools: string[];
  effectiveSkills: string[];
  effectiveSkillPaths: string[];
  missingSkills: string[];
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
}

export const RESEARCH_ASSISTANT_AGENT = "research-assistant";

export const CONTROLLED_TOOL_INVENTORY = [
  "read",
  "bash",
  "edit",
  "write",
  "subagent",
  "web-search",
  "webfetch",
] as const;
const RESEARCH_ASSISTANT_TOOL_INVENTORY = [...CONTROLLED_TOOL_INVENTORY, "ssh-bash"] as const;
const EXPERIMENT_TOOL_INVENTORY = [...CONTROLLED_TOOL_INVENTORY, "ssh-bash"] as const;
const BUILTIN_ALIASES: Record<string, string> = {
  [RESEARCH_ASSISTANT_AGENT]: "Research Assistant",
};
const BUILTIN_ORDER = [RESEARCH_ASSISTANT_AGENT, "search", "experiment", "writing", "figures"];

export interface DiscoveryOptions {
  agentDir?: string;
  cwd?: string;
  bundledAgentsDir?: string;
  bundledSkillsDir?: string;
  homeDir?: string;
  enableDotAgentsSkill?: boolean;
  acceptedSkillDescriptors?: AcceptedSkillDescriptors;
  platform?: NodeJS.Platform;
}

function bundledAgentsDir(): string {
  return join(bundledSourceRoot(), "agents");
}

function sourceDirectory(options: DiscoveryOptions, source: AgentSource): string {
  if (source === "bundled") return options.bundledAgentsDir ? join(options.bundledAgentsDir, "agents") : bundledAgentsDir();
  return join(options.agentDir ?? getAgentDir(), "agents");
}

function sourcePriority(options: DiscoveryOptions): Array<{ source: AgentSource; directory: string }> {
  return [
    { source: "global", directory: sourceDirectory(options, "global") },
    { source: "bundled", directory: sourceDirectory(options, "bundled") },
  ];
}

type FrontmatterParser = <T extends Record<string, unknown>>(content: string) => { frontmatter: T; body: string };

function parseAgentFile(
  filePath: string,
  name: string,
  builtin: boolean,
  source: AgentSource,
  parseFrontmatter: FrontmatterParser,
): { definition?: AgentDefinition; diagnostic?: AgentDiagnostic } {
  try {
    const content = readFileSync(filePath, "utf8");
    const parsed = parseFrontmatter<Record<string, unknown>>(content);
    const frontmatter = parsed.frontmatter ?? {};
    if (typeof frontmatter.name !== "string" || !frontmatter.name.trim()) {
      return { diagnostic: invalidDefinitionDiagnostic(name, source) };
    }
    const tools = configuredCapabilityList(frontmatter.tools);
    const skills = configuredCapabilityList(frontmatter.skills);
    return {
      definition: {
        name,
        description: typeof frontmatter.description === "string" && frontmatter.description.trim() ? frontmatter.description : name,
        enabled: builtin && name === RESEARCH_ASSISTANT_AGENT ? true : frontmatter.enable !== false,
        builtin,
        tools,
        subagents: stringArray(frontmatter.subagents),
        skills,
        systemPrompt: parsed.body.trim(),
        source,
        filePath,
      },
    };
  } catch {
    return { diagnostic: invalidDefinitionDiagnostic(name, source) };
  }
}

function invalidDefinitionDiagnostic(agent: string, source: AgentSource): AgentDiagnostic {
  return { agent, source, message: "Invalid Agent definition." };
}

export function configuredCapabilityList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return names.length > 0 ? names : undefined;
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
  diagnostics: AgentDiagnostic[],
): AgentDefinition | undefined {
  for (const { source, directory } of sourcePriority(options)) {
    const path = pathForBuiltin(directory, name);
    if (!path) continue;
    const parsed = parseAgentFile(path, name, true, source, parseFrontmatter);
    if (parsed.definition) return parsed.definition;
    if (parsed.diagnostic) diagnostics.push(parsed.diagnostic);
  }
  return undefined;
}

function loadCustom(
  options: DiscoveryOptions,
  name: string,
  parseFrontmatter: FrontmatterParser,
  diagnostics: AgentDiagnostic[],
): AgentDefinition | undefined {
  for (const { source, directory } of sourcePriority(options)) {
    const path = pathForCustom(directory, name);
    if (!existsSync(path)) continue;
    const parsed = parseAgentFile(path, name, false, source, parseFrontmatter);
    if (parsed.definition) return parsed.definition;
    if (parsed.diagnostic) diagnostics.push(parsed.diagnostic);
  }
  return undefined;
}

export async function loadAgentCatalog(options: DiscoveryOptions = {}): Promise<AgentCatalogSnapshot> {
  const { parseFrontmatter } = await importPi();
  const definitions: AgentDefinition[] = [];
  const diagnostics: AgentDiagnostic[] = [];
  for (const name of BUILTIN_ORDER) {
    const definition = loadBuiltin(options, name, parseFrontmatter, diagnostics);
    if (definition) definitions.push(definition);
  }
  const builtinNames = new Set(BUILTIN_ORDER);
  const customNames = new Set<string>();
  for (const directory of sourcePriority(options).map(({ directory }) => directory)) {
    for (const file of mdNames(directory)) {
      const stem = file.slice(0, -3);
      if (!builtinNames.has(stem) && !Object.values(BUILTIN_ALIASES).includes(stem)) customNames.add(stem);
    }
  }
  for (const name of [...customNames].sort((a, b) => a.localeCompare(b))) {
    const definition = loadCustom(options, name, parseFrontmatter, diagnostics);
    if (definition) definitions.push(definition);
  }
  const defaults = await readGlobalAgentDefaults(options.agentDir ?? getAgentDir());
  return { definitions, diagnostics, defaults };
}

export function resolveAgentCatalog(
  snapshot: AgentCatalogSnapshot,
  options: DiscoveryOptions = {},
): AgentDiscoveryResult {
  const agentDir = options.agentDir ?? getAgentDir();
  const includeProject = options.cwd !== undefined;
  const cwd = options.cwd ?? agentDir;
  const platform = options.platform ?? process.platform;
  const agents = snapshot.definitions.map((definition): AgentConfig => {
    const runtimeDefault = snapshot.defaults?.[definition.name];
    const tools = definition.tools ? [...definition.tools] : undefined;
    const skills = definition.skills ? [...definition.skills] : undefined;
    const inventory = tools ?? [
      ...(definition.name === RESEARCH_ASSISTANT_AGENT
        ? RESEARCH_ASSISTANT_TOOL_INVENTORY
        : definition.name === "experiment"
          ? EXPERIMENT_TOOL_INVENTORY
          : CONTROLLED_TOOL_INVENTORY),
    ];
    const { effectiveSkills, effectiveSkillPaths, missingSkills } = resolveSkillSelection(skills, {
      cwd,
      agentDir,
      homeDir: options.homeDir ?? homedir(),
      bundledSkillsDir: options.bundledSkillsDir,
      enableDotAgentsSkill: options.enableDotAgentsSkill,
      acceptedSkillDescriptors: options.acceptedSkillDescriptors,
      includeProject,
    });
    return {
      ...definition,
      model: runtimeDefault?.model,
      thinking: runtimeDefault?.thinking,
      tools,
      effectiveTools: normalizeLocalShellTools(inventory, platform),
      subagents: definition.subagents ? [...definition.subagents] : definition.subagents,
      skills,
      effectiveSkills,
      effectiveSkillPaths,
      missingSkills,
    };
  });
  return { agents };
}

async function resolveDotAgentsSkillSetting(options: DiscoveryOptions): Promise<boolean> {
  if (options.enableDotAgentsSkill !== undefined) return options.enableDotAgentsSkill;
  const { SettingsManager } = await importPi();
  if (!SettingsManager) return false;
  const agentDir = options.agentDir ?? getAgentDir();
  const settings = SettingsManager.create(options.cwd ?? agentDir, agentDir).getGlobalSettings();
  return isDotAgentsSkillEnabled(settings);
}

export async function discoverAgents(options: DiscoveryOptions = {}): Promise<AgentDiscoveryResult> {
  const snapshot = await loadAgentCatalog(options);
  const enableDotAgentsSkill = await resolveDotAgentsSkillSetting(options);
  return resolveAgentCatalog(snapshot, { ...options, enableDotAgentsSkill });
}

export async function discoverGlobalAgents(options: DiscoveryOptions = {}): Promise<AgentDiscoveryResult> {
  const globalOptions = { ...options, cwd: undefined };
  const snapshot = await loadAgentCatalog(globalOptions);
  const enableDotAgentsSkill = await resolveDotAgentsSkillSetting(globalOptions);
  return resolveAgentCatalog(snapshot, { ...globalOptions, enableDotAgentsSkill });
}

export function filterEnabledAgents(agents: AgentConfig[]): AgentConfig[] {
  return agents.filter((agent) => agent.enabled);
}
