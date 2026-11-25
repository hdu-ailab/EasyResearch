import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
import { skillMarketplaceIdentity } from "./skill-marketplace-install";
import { isSkillResourceEnabled, removeSkillResourceOverrides, setSkillResourceEnabled, skillResourceEntries, type SkillPatternScope } from "../runtime/skill-resource-policy";

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
  skillPolicy: { enableDotAgentsSkill: boolean; resourceOverrides?: readonly string[] };
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
        description: await skillDescription(candidate.skillPath),
        enabled: isSkillResourceEnabled(candidate.skillPath, options.skillPolicy.resourceOverrides ?? [], skillScope(config, source, options)),
        canDelete: verifiedGlobalSkillDirectory(config, { ...candidate, source }) !== undefined,
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
    description: skill.description ?? "",
    enabled: skill.enabled ?? true,
    canDelete: skill.canDelete ?? false,
    source: skill.source,
    path: skill.path,
    skillPath: skill.skillPath,
    marketplaceId: skillMarketplaceIdentity(skill),
  };
}

async function skillDescription(path: string): Promise<string> {
  const { parseFrontmatter } = await importPi();
  try {
    const description = parseFrontmatter<Record<string, unknown>>(readFileSync(path, "utf8")).frontmatter.description;
    return typeof description === "string" ? description.trim().slice(0, 4000) : "";
  } catch { return ""; }
}

function skillScope(config: ConfigFileService, source: SkillResourceDto["source"], options: SkillResourceOptions): SkillPatternScope {
  return {
    baseDir: source === "home" ? join(options.homeDir ?? homedir(), ".agents") : config.globalRoot,
    homeDir: options.homeDir,
  };
}

/** A dedicated physical directory below the writable root, never an alias or root itself. */
function verifiedGlobalSkillDirectory(config: ConfigFileService, skill: Pick<SkillResourceDto, "source" | "path" | "skillPath">): string | undefined {
  if (skill.source !== "global" || skill.path === skill.skillPath || dirname(skill.skillPath) !== skill.path || basename(skill.skillPath) !== "SKILL.md") return;
  const child = relative(join(config.globalRoot, "skills"), skill.path);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return;
  try {
    let target = realpathSync(config.globalRoot);
    for (const part of ["skills", ...child.split(sep)]) {
      target = join(target, part);
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    }
    const descriptor = lstatSync(join(target, "SKILL.md"));
    if (descriptor.isSymbolicLink() || !descriptor.isFile()) return;
    return target;
  } catch { return; }
}

export async function patchGlobalSkill(config: ConfigFileService, name: string, enabled: boolean, options: SkillResourceOptions): Promise<SkillResourceDto> {
  return serializeSkillWrite(config, name, async () => {
    const skill = (await discoverGlobalSkills(config, options)).find((item) => item.name === name);
    if (!skill) throw new ConfigServiceError(404, `unknown skill: ${name}`);
    const snapshot = snapshotPath(skill.skillPath);
    const entries = await config.mutateGlobalSettings((settings) => {
      if (!samePathSnapshot(snapshot, snapshotPath(skill.skillPath))) throw new ConfigServiceError(409, "Skill changed before updating its state.", "SKILL_TARGET_CHANGED");
      let current: string[];
      try { current = skillResourceEntries(settings); }
      catch { throw new ConfigServiceError(409, "Repair the skills resource array in settings.json first.", "CONFIG_INVALID"); }
      const next = setSkillResourceEnabled(current, skill.skillPath, enabled, skillScope(config, skill.source, options));
      return { settings: { ...settings, skills: next }, result: next, write: JSON.stringify(current) !== JSON.stringify(next) };
    }, { notify: false });
    await config.notifySkillChange();
    return readGlobalSkill(config, name, { ...options, skillPolicy: { ...options.skillPolicy, resourceOverrides: entries } });
  });
}

export async function deleteGlobalSkill(config: ConfigFileService, name: string, options: SkillResourceOptions): Promise<{ deleted: true; name: string }> {
  return serializeSkillWrite(config, name, async () => {
    const skill = (await discoverGlobalSkills(config, options)).find((item) => item.name === name);
    if (!skill) throw new ConfigServiceError(404, `unknown skill: ${name}`);
    const target = verifiedGlobalSkillDirectory(config, skill);
    if (!target) throw new ConfigServiceError(409, "Only a physical global Skill directory can be deleted.", "SKILL_NOT_DELETABLE");
    const initial = snapshotPath(target);
    const descriptor = snapshotPath(skill.skillPath);
    const ownedOverrides = await config.mutateGlobalSettings((settings) => {
      let entries: string[];
      try { entries = skillResourceEntries(settings); }
      catch { throw new ConfigServiceError(409, "Repair the skills resource array in settings.json first.", "CONFIG_INVALID"); }
      const remaining = new Set(removeSkillResourceOverrides(entries, skill.skillPath, skillScope(config, skill.source, options)));
      return { settings, result: entries.filter((entry) => !remaining.has(entry)), write: false };
    }, { notify: false });
    // Recheck the complete identity after asynchronous discovery and before moving custody.
    const latest = (await discoverGlobalSkills(config, options)).find((item) => item.name === name);
    if (!latest || resolve(latest.skillPath) !== resolve(skill.skillPath)
      || verifiedGlobalSkillDirectory(config, latest) !== target || !samePathSnapshot(initial, snapshotPath(target))
      || !samePathSnapshot(descriptor, snapshotPath(skill.skillPath))) {
      throw new ConfigServiceError(409, "Skill changed before deletion.", "SKILL_TARGET_CHANGED");
    }
    const retired = join(realpathSync(config.globalRoot), `.skill-delete-${randomUUID()}`);
    renameSync(target, retired);
    try {
      await config.mutateGlobalSettings((settings) => {
        let entries: string[];
        try { entries = skillResourceEntries(settings); }
        catch { throw new ConfigServiceError(409, "Repair the skills resource array in settings.json first.", "CONFIG_INVALID"); }
        const owned = [...ownedOverrides];
        const next = entries.filter((entry) => {
          const index = owned.indexOf(entry);
          if (index < 0) return true;
          owned.splice(index, 1);
          return false;
        });
        return { settings: { ...settings, skills: next }, result: undefined, write: next.length !== entries.length };
      }, { notify: false });
    } catch (error) {
      const custody = snapshotPath(retired);
      if (!existsSync(target) && custody?.dev === initial?.dev && custody?.ino === initial?.ino) renameSync(retired, target);
      else throw new ConfigServiceError(409, `Skill deletion could not finish; preserved files remain at ${retired}.`, "SKILL_DELETE_INCOMPLETE");
      throw error;
    }
    const custody = snapshotPath(retired);
    if (!custody || custody.dev !== initial?.dev || custody.ino !== initial?.ino) {
      throw new ConfigServiceError(409, "Skill deletion custody changed. Files were preserved for recovery.", "SKILL_DELETE_INCOMPLETE");
    }
    try { rmSync(retired, { recursive: true }); }
    catch { throw new ConfigServiceError(409, `Skill was removed from discovery, but retained files at ${retired} need cleanup.`, "SKILL_DELETE_INCOMPLETE"); }
    await config.notifySkillChange();
    return { deleted: true, name };
  });
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
    let copiedPolicy: { before: string[] | undefined; after: string[] } | undefined;
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
      if (skill.source !== "global" && skill.enabled === false) {
        copiedPolicy = await config.mutateGlobalSettings((settings) => {
          const before = skillResourceEntries(settings);
          const after = setSkillResourceEnabled(before, skillPath, false, { baseDir: config.globalRoot, homeDir: options.homeDir });
          return {
            settings: { ...settings, skills: after }, result: { before: settings.skills === undefined ? undefined : before, after },
            write: JSON.stringify(before) !== JSON.stringify(after),
          };
        }, { notify: false });
      }
      await config.write({ scope: "global", path: skillPath.slice(config.globalRoot.length + 1), content });
      materialization?.commit();
    } catch (error) {
      materialization?.rollback();
      if (copiedPolicy && !existsSync(skillPath)) {
        const policy = copiedPolicy;
        await config.mutateGlobalSettings((settings) => {
          if (JSON.stringify(settings.skills) !== JSON.stringify(policy.after)) return { settings, result: undefined, write: false };
          const restored = { ...settings };
          if (policy.before === undefined) delete restored.skills;
          else restored.skills = policy.before;
          return { settings: restored, result: undefined };
        }, { notify: false });
      }
      throw error;
    }
    return readGlobalSkill(config, name, copiedPolicy
      ? { ...options, skillPolicy: { ...options.skillPolicy, resourceOverrides: copiedPolicy.after } } : options);
  });
}

export function serializeSkillWrite<T>(
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
