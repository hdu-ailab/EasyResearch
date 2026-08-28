import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { bundledSourceRoot } from "../runtime/bundled-assets";
import { importPi } from "../runtime/pi-import";
import {
  enumerateSkillDescriptors,
  fingerprintSkillRoot,
} from "../runtime/resource-fingerprint";
import { discoverGlobalAgents, type AgentConfig } from "../subagent/agents";
import type { AgentResourceDto, SkillResourceDto } from "./contracts";
import type { ConfigFileService } from "./config-files";
import { ConfigServiceError } from "./config-files";
import { starterAgentMarkdown } from "./agent-markdown";
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

export interface SkillResourceOptions {
  skillPolicy: { enableDotAgentsSkill: boolean };
  homeDir?: string;
  bundledSkillsDir?: string;
}

interface SkillResourceRoot {
  root: string;
  source: SkillResourceDto["source"];
  mode?: "pi" | "agents";
}

interface DiscoveredSkillResource extends SkillResourceDto {
  canonicalPath: string;
  canonicalSkillPath: string;
}

interface SkillAssetMaterialization {
  commit(): void;
  rollback(): void;
}

interface PathSnapshot {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

const skillWriteQueues = new WeakMap<ConfigFileService, Map<string, Promise<void>>>();

async function discoverGlobalSkills(
  config: ConfigFileService,
  options: SkillResourceOptions,
): Promise<DiscoveredSkillResource[]> {
  const roots: SkillResourceRoot[] = [
    { root: join(config.globalRoot, "skills"), source: "global" },
    ...(options.skillPolicy.enableDotAgentsSkill
      ? [{
          root: join(options.homeDir ?? homedir(), ".agents", "skills"),
          source: "home" as const,
          mode: "agents" as const,
        }]
      : []),
    { root: options.bundledSkillsDir ?? join(bundledSourceRoot(), "skills"), source: "bundled" },
  ];
  const selected = new Map<string, DiscoveredSkillResource>();
  for (const { root, source, mode = "pi" } of roots) {
    const structural = new Map(
      enumerateSkillDescriptors(root, mode).map((descriptor) => [descriptor.relativePath, descriptor]),
    );
    const accepted = await fingerprintSkillRoot(root, `web:${source}`, undefined, mode);
    const effectiveNames = new Map(
      accepted.skillDescriptors.map((descriptor) => [descriptor.relativePath, descriptor.name]),
    );
    for (const candidate of structural.values()) {
      const name = effectiveNames.get(candidate.relativePath) ?? candidate.name;
      if (selected.has(name)) continue;
      selected.set(name, {
        name,
        source,
        path: candidate.path,
        skillPath: candidate.skillPath,
        canonicalPath: candidate.canonicalPath,
        canonicalSkillPath: candidate.canonicalSkillPath,
      });
    }
  }
  return [...selected.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function publicSkillResource(skill: DiscoveredSkillResource): SkillResourceDto {
  return {
    name: skill.name,
    source: skill.source,
    path: skill.path,
    skillPath: skill.skillPath,
  };
}

export async function listGlobalSkills(
  config: ConfigFileService,
  options: SkillResourceOptions,
): Promise<SkillResourceDto[]> {
  return (await discoverGlobalSkills(config, options)).map(publicSkillResource);
}

/**
 * Serve the effective skill content (bundled/global/home) without creating any
 * user-layer skill directory. Opening an editor never materializes a copy
 * (ADR-058).
 */
export async function readGlobalSkill(
  config: ConfigFileService,
  name: string,
  options: SkillResourceOptions,
): Promise<SkillResourceDto> {
  const skill = (await discoverGlobalSkills(config, options)).find((item) => item.name === name);
  if (!skill) throw new ConfigServiceError(404, `unknown skill: ${name}`);
  const content = readFileSync(skill.skillPath, "utf8");
  return { ...publicSkillResource(skill), content };
}

/**
 * Save materializes a bundled/home skill directory into the global skills
 * directory when no user-layer copy exists, then writes the edited SKILL.md
 * (ADR-058).
 */
export async function writeGlobalSkill(
  config: ConfigFileService,
  name: string,
  content: string,
  options: SkillResourceOptions,
): Promise<SkillResourceDto> {
  return serializeSkillWrite(config, name, async () => {
    const skill = (await discoverGlobalSkills(config, options)).find((item) => item.name === name);
    if (!skill) throw new ConfigServiceError(404, `unknown skill: ${name}`);
    let skillPath = skill.skillPath;
    let materialization: SkillAssetMaterialization | undefined;
    if (skill.source === "bundled" || skill.source === "home") {
      if (skill.path === skill.skillPath) {
        skillPath = join(config.globalRoot, "skills", `${name}.md`);
      } else {
        const target = join(config.globalRoot, "skills", name);
        materialization = materializeSkillAssets(
          config.globalRoot,
          skill.canonicalPath,
          skill.canonicalSkillPath,
          target,
        );
        skillPath = join(target, "SKILL.md");
      }
    }
    try {
      await config.write({ scope: "global", path: skillPath.slice(config.globalRoot.length + 1), content });
      materialization?.commit();
    } catch (error) {
      materialization?.rollback();
      throw error;
    }
    return readGlobalSkill(config, name, options);
  });
}

function serializeSkillWrite<T>(
  config: ConfigFileService,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queues = skillWriteQueues.get(config);
  if (!queues) {
    queues = new Map();
    skillWriteQueues.set(config, queues);
  }
  const previous = queues.get(name) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(name, tail);
  void tail.then(() => {
    if (queues?.get(name) !== tail) return;
    queues.delete(name);
    if (queues.size === 0) skillWriteQueues.delete(config);
  });
  return result;
}

function materializeSkillAssets(
  globalRoot: string,
  source: string,
  sourceDescriptor: string,
  target: string,
): SkillAssetMaterialization {
  const suffix = randomUUID();
  const staging = join(globalRoot, `.skill-copy-${suffix}.staging`);
  const backup = join(globalRoot, `.skill-copy-${suffix}.backup`);
  const initialTarget = snapshotPath(target);
  let targetMoved = false;
  let promoted = false;
  mkdirSync(globalRoot, { recursive: true });
  mkdirSync(join(globalRoot, "skills"), { recursive: true });
  const sourceDescriptorEntry = join(source, "SKILL.md");
  try {
    cpSync(source, staging, {
      recursive: true,
      filter: (candidate) => candidate !== sourceDescriptorEntry && candidate !== sourceDescriptor,
    });
    if (!samePathSnapshot(initialTarget, snapshotPath(target))) {
      throw new ConfigServiceError(409, "Skill target changed during materialization", "SKILL_TARGET_CHANGED");
    }
    if (existsSync(target)) {
      renameSync(target, backup);
      targetMoved = true;
    }
    renameSync(staging, target);
    promoted = true;
  } catch (error) {
    if (targetMoved && !promoted && !existsSync(target) && existsSync(backup)) {
      renameSync(backup, target);
    }
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  let settled = false;
  return {
    commit() {
      if (settled) return;
      settled = true;
      try {
        rmSync(backup, { recursive: true, force: true });
      } catch {
        // The promoted Skill is complete; a hidden backup is safer than rolling it back after notification.
      }
    },
    rollback() {
      if (settled) return;
      rmSync(target, { recursive: true, force: true });
      if (targetMoved && existsSync(backup)) renameSync(backup, target);
      settled = true;
      rmSync(staging, { recursive: true, force: true });
      rmSync(backup, { recursive: true, force: true });
    },
  };
}

function snapshotPath(path: string): PathSnapshot | undefined {
  if (!existsSync(path)) return undefined;
  const stats = lstatSync(path);
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function samePathSnapshot(left: PathSnapshot | undefined, right: PathSnapshot | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}
