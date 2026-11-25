import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { bundledSourceRoot } from "../runtime/bundled-assets";
import { isSkillResourceEnabled, readSkillResourceOverrides } from "../runtime/skill-resource-policy";
import {
  type AcceptedSkillDescriptor,
  selectSkillDescriptors,
  type SkillDescriptor,
} from "../runtime/resource-fingerprint";

export interface SkillResolverDeps {
  cwd: string;
  agentDir: string;
  homeDir?: string;
  bundledSkillsDir?: string;
  enableDotAgentsSkill?: boolean;
  includeProject?: boolean;
  acceptedSkillDescriptors?: AcceptedSkillDescriptors;
  resourceOverrides?: readonly string[];
}

export interface AcceptedSkillDescriptors {
  global: readonly AcceptedSkillDescriptor[];
  home: readonly AcceptedSkillDescriptor[] | null;
  project?: readonly AcceptedSkillDescriptor[];
}

export interface ResolvedSkillSelection {
  effectiveSkills: string[];
  effectiveSkillPaths: string[];
  missingSkills: string[];
}

function expandHome(path: string, home?: string): string {
  return path.startsWith("~") ? join(home ?? homedir(), path.slice(1)) : path;
}

function isPathRef(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~/") || value.startsWith(".") || value.includes("/");
}

function skillSites(deps: SkillResolverDeps): string[] {
  return [
    ...(deps.includeProject === false ? [] : [join(deps.cwd, ".easyresearch", "skills")]),
    join(deps.agentDir, "skills"),
    ...(deps.enableDotAgentsSkill === true ? [join(deps.homeDir ?? homedir(), ".agents", "skills")] : []),
    deps.bundledSkillsDir ?? dirnameFromModule(),
  ];
}

export function isDotAgentsSkillEnabled(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return false;
  const easyresearch = (settings as { easyresearch?: unknown }).easyresearch;
  if (typeof easyresearch !== "object" || easyresearch === null || Array.isArray(easyresearch)) return false;
  return (easyresearch as { enable_dot_agents_skill?: unknown }).enable_dot_agents_skill === true;
}

export function defaultSkillDirectories(deps: SkillResolverDeps): string[] {
  return skillSites(deps).filter((site, index, sites) => sites.indexOf(site) === index && existsSync(site));
}

function controlledSkillDescriptors(deps: SkillResolverDeps): SkillDescriptor[] {
  const accepted = deps.acceptedSkillDescriptors;
  if (accepted) {
    const projectRoot = join(deps.cwd, ".easyresearch", "skills");
    const bundledRoot = deps.bundledSkillsDir ?? dirnameFromModule();
    const groups: readonly (readonly SkillDescriptor[])[] = [
      ...(deps.includeProject === false
        ? []
        : [accepted.project === undefined
          ? selectSkillDescriptors([projectRoot]).map(({ descriptor }) => descriptor)
          : materializeAcceptedDescriptors(projectRoot, accepted.project)]),
      materializeAcceptedDescriptors(join(deps.agentDir, "skills"), accepted.global),
      ...(deps.enableDotAgentsSkill === true
        ? [materializeAcceptedDescriptors(join(deps.homeDir ?? homedir(), ".agents", "skills"), accepted.home ?? [])]
        : []),
      selectSkillDescriptors([bundledRoot]).map(({ descriptor }) => descriptor),
    ];
    const selected = new Map<string, SkillDescriptor>();
    for (const descriptors of groups) {
      for (const descriptor of descriptors) {
        if (!selected.has(descriptor.name)) selected.set(descriptor.name, descriptor);
      }
    }
    return [...selected.values()].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
  }
  return selectSkillDescriptors(skillSites(deps)).map(({ descriptor }) => descriptor);
}

function materializeAcceptedDescriptors(
  root: string,
  descriptors: readonly AcceptedSkillDescriptor[],
): SkillDescriptor[] {
  return descriptors.map((accepted) => {
    const { name, relativePath } = accepted;
    const originalSkillPath = join(root, ...relativePath.split("/"));
    const directFile = !relativePath.includes("/");
    const originalPath = directFile ? originalSkillPath : join(originalSkillPath, "..");
    const skillPath = accepted.snapshotPath ?? originalSkillPath;
    const path = directFile ? skillPath : join(skillPath, "..");
    return {
      name,
      relativePath,
      path,
      skillPath,
      canonicalPath: path,
      canonicalSkillPath: skillPath,
      originalPath,
      originalSkillPath,
      ...(accepted.baseDir ? { baseDir: accepted.baseDir } : {}),
      ...(accepted.enabled === undefined ? {} : { enabled: accepted.enabled }),
    };
  });
}

function acceptedControlledPath(target: string, deps: SkillResolverDeps): string | undefined | null {
  const accepted = deps.acceptedSkillDescriptors;
  if (!accepted) return null;
  const roots: Array<{ root: string; descriptors: readonly AcceptedSkillDescriptor[] | undefined }> = [
    ...(deps.includeProject === false
      ? []
      : [{ root: join(deps.cwd, ".easyresearch", "skills"), descriptors: accepted.project }]),
    { root: join(deps.agentDir, "skills"), descriptors: accepted.global },
    ...(deps.enableDotAgentsSkill === true
      ? [{ root: join(deps.homeDir ?? homedir(), ".agents", "skills"), descriptors: accepted.home ?? [] }]
      : []),
  ];
  for (const { root, descriptors } of roots) {
    if (!isWithin(root, target)) continue;
    if (descriptors === undefined) return null;
    const descriptor = materializeAcceptedDescriptors(root, descriptors).find((candidate) =>
      resolve(candidate.originalPath ?? candidate.path) === target
      || resolve(candidate.originalSkillPath ?? candidate.skillPath) === target
    );
    return descriptor === undefined ? undefined : target;
  }
  return null;
}

function configuredSkillResolver(deps: SkillResolverDeps): (value: string) => string | null | undefined {
  let named: Map<string, SkillDescriptor> | undefined;
  return (value) => {
    if (isPathRef(value)) {
      const expanded = expandHome(value, deps.homeDir);
      const target = resolve(deps.cwd, expanded);
      const descriptor = controlledSkillDescriptors(deps).find((item) => target === resolve(item.originalPath ?? item.path)
        || target === resolve(item.originalSkillPath ?? item.skillPath));
      if (descriptor) return skillEnabled(descriptor, deps) ? descriptor.path : null;
      const accepted = acceptedControlledPath(target, deps);
      const path = accepted === null ? validSkillPath(target) : accepted;
      if (!path) return undefined;
      return skillEnabled({ skillPath: path.endsWith(".md") ? path : join(path, "SKILL.md") }, deps) ? path : null;
    }
    named ??= new Map(controlledSkillDescriptors(deps).map((descriptor) => [descriptor.name, descriptor]));
    const descriptor = named.get(value);
    return descriptor ? skillEnabled(descriptor, deps) ? descriptor.path : null : undefined;
  };
}

function skillEnabled(descriptor: Pick<SkillDescriptor, "skillPath" | "originalSkillPath" | "enabled">, deps: SkillResolverDeps): boolean {
  if (descriptor.enabled !== undefined) return descriptor.enabled;
  const path = descriptor.originalSkillPath ?? descriptor.skillPath;
  const projectBase = join(deps.cwd, ".easyresearch");
  if (deps.includeProject !== false && isWithin(join(projectBase, "skills"), path)) {
    return isSkillResourceEnabled(path, unboundOverrides(join(projectBase, "settings.json")), { baseDir: projectBase, homeDir: deps.homeDir });
  }
  const homeBase = join(deps.homeDir ?? homedir(), ".agents");
  const baseDir = isWithin(join(homeBase, "skills"), path) ? homeBase : deps.agentDir;
  const entries = deps.resourceOverrides ?? unboundOverrides(join(deps.agentDir, "settings.json"));
  return isSkillResourceEnabled(path, entries, { baseDir, homeDir: deps.homeDir });
}

function unboundOverrides(path: string): string[] {
  try { return readSkillResourceOverrides(path); }
  catch {
    // Recovery metadata remains readable; managed runtimes always supply accepted policy.
    return [];
  }
}

function isWithin(root: string, target: string): boolean {
  const child = relative(resolve(root), target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export function resolveEffectiveSkillNames(skills: string[] | undefined, deps: SkillResolverDeps): string[] {
  return resolveSkillSelection(skills, deps).effectiveSkills;
}

export function resolveSkillSelection(
  skills: string[] | undefined,
  deps: SkillResolverDeps,
): ResolvedSkillSelection {
  deps = { ...deps, resourceOverrides: deps.resourceOverrides ?? unboundOverrides(join(deps.agentDir, "settings.json")) };
  if (skills !== undefined) {
    const resolveConfigured = configuredSkillResolver(deps);
    const effectiveSkills: string[] = [];
    const effectiveSkillPaths: string[] = [];
    const missingSkills: string[] = [];
    for (const skill of skills) {
      const path = resolveConfigured(skill);
      if (path === undefined) {
        missingSkills.push(skill);
      } else if (path !== null) {
        effectiveSkills.push(skill);
        effectiveSkillPaths.push(path);
      }
    }
    return { effectiveSkills, effectiveSkillPaths, missingSkills };
  }
  const descriptors = controlledSkillDescriptors(deps).filter((descriptor) => skillEnabled(descriptor, deps));
  return {
    effectiveSkills: descriptors.map(({ name }) => name),
    effectiveSkillPaths: descriptors.map(({ path }) => path),
    missingSkills: [],
  };
}

export function buildDefaultSkillArgs(deps: SkillResolverDeps): string[] {
  return ["--no-skills", ...defaultSkillDirectories(deps).flatMap((directory) => ["--skill", directory])];
}

export async function readGlobalDotAgentsSkillSetting(cwd: string, agentDir: string): Promise<boolean> {
  const { importPi } = await import("../runtime/pi-import");
  const { SettingsManager } = await importPi();
  if (!SettingsManager) return false;
  return isDotAgentsSkillEnabled(SettingsManager.create(cwd, agentDir).getGlobalSettings());
}

function dirnameFromModule(): string {
  return join(bundledSourceRoot(), "skills");
}

function validSkillPath(target: string): string | undefined {
  if (!existsSync(target)) return undefined;
  try {
    const stats = statSync(target);
    if (stats.isDirectory()) {
      try {
        return statSync(join(target, "SKILL.md")).isFile() ? target : undefined;
      } catch {
        return undefined;
      }
    }
    return stats.isFile() && target.endsWith(".md") ? target : undefined;
  } catch {
    return undefined;
  }
}

export function resolveSkillDirectories(skills: string[] | undefined, deps: SkillResolverDeps): string[] | undefined {
  if (skills === undefined) return undefined;
  return resolveSkillSelection(skills, deps).effectiveSkillPaths;
}

/**
 * Skill paths for an agent session: an explicit allowlist resolves against the
 * skill sites, an omitted allowlist loads every available site.
 */
export function resolveAgentSkillDirectories(
  agent: { skills?: string[] } | undefined,
  deps: SkillResolverDeps,
): string[] {
  if (!agent) return [];
  return agent.skills && agent.skills.length > 0
    ? resolveSkillSelection(agent.skills, deps).effectiveSkillPaths
    : resolveSkillSelection(undefined, deps).effectiveSkillPaths;
}
