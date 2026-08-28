import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import createIgnore from "ignore";

export const MAX_SKILL_DEPTH = 16;
export const MAX_SKILL_DESCRIPTORS = 4096;
export const MAX_SKILL_DESCRIPTOR_BYTES = 1_048_576;
export const MAX_SKILL_IGNORE_BYTES = 1_048_576;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"] as const;
const SNAPSHOT_BASE_DIR_FILE = ".easyresearch-skill-base-dir";

export interface SkillScopeFingerprint {
  value: string;
  descriptors: readonly string[];
  skillDescriptors: readonly AcceptedSkillDescriptor[];
}

export interface AcceptedSkillDescriptor {
  name: string;
  relativePath: string;
  snapshotPath?: string;
  baseDir?: string;
}

export interface FingerprintResourceOptions {
  agentDir: string;
  homeDir: string;
  enableDotAgentsSkill: boolean;
  snapshotRoot?: string;
}

export interface SkillDescriptor {
  name: string;
  relativePath: string;
  path: string;
  skillPath: string;
  canonicalPath: string;
  canonicalSkillPath: string;
  originalPath?: string;
  originalSkillPath?: string;
  baseDir?: string;
}

export interface SelectedSkillDescriptor {
  descriptor: SkillDescriptor;
  rootIndex: number;
}

export type SkillDiscoveryMode = "pi" | "agents";

export function isSkillDescriptorRelativePath(
  relativePath: string,
  mode: SkillDiscoveryMode = "pi",
): boolean {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.startsWith("/") ||
    relativePath.startsWith("\\") ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    return false;
  }

  const components = relativePath.split(/[\\/]/);
  if (components.some((component) => component.length === 0 || component === "." || component === "..")) {
    return false;
  }
  if (components.length === 1) {
    const filename = components[0];
    if (filename === undefined) return false;
    return mode === "pi" && filename.length > ".md".length && filename.endsWith(".md");
  }
  return components.at(-1) === "SKILL.md"
    || (mode === "agents" && components.at(-1)?.endsWith(".md") === true);
}

type LocatedEntry = { kind: "directory" | "file" | "other"; realPath: string } | { kind: "outside" };

export async function fingerprintSkillRoot(
  root: string,
  scope: string,
  snapshotRoot?: string,
  mode: SkillDiscoveryMode = "pi",
): Promise<SkillScopeFingerprint> {
  const hash = createHash("sha256");
  hash.update("easyresearch-skill-scope-v1\0");
  updateHashField(hash, Buffer.from(scope, "utf8"));

  const candidates = enumerateSkillDescriptors(root, mode);
  if (candidates.length === 0) {
    return { value: hash.digest("hex"), descriptors: [], skillDescriptors: [] };
  }

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    if (isMissing(error)) throw new Error("Skill descriptor changed while fingerprinting.");
    throw error;
  }
  const realRootStats = await lstat(realRoot);
  if (!realRootStats.isDirectory()) throw new Error("Skill fingerprint root must be a directory.");
  const { importPi } = await import("./pi-import");
  const { parseFrontmatter } = await importPi();
  const skillDescriptors: AcceptedSkillDescriptor[] = [];

  for (const candidate of candidates) {
    const bytes = await readDescriptor(candidate.skillPath, candidate.skillPath, root, realRoot, realRootStats);
    updateHashField(hash, Buffer.from(candidate.relativePath, "utf8"));
    updateHashField(hash, bytes);
    try {
      const { frontmatter } = parseFrontmatter<Record<string, unknown>>(bytes.toString("utf8"));
      if (typeof frontmatter.description !== "string" || frontmatter.description.trim().length === 0) continue;
      const name = typeof frontmatter.name === "string" && frontmatter.name.trim().length > 0
        ? frontmatter.name
        : candidate.name;
      const baseDir = candidate.path === candidate.skillPath ? dirname(candidate.path) : candidate.path;
      const snapshotPath = snapshotRoot
        ? materializeSkillSnapshot(snapshotRoot, candidate, bytes, baseDir)
        : undefined;
      skillDescriptors.push({
        name,
        relativePath: candidate.relativePath,
        ...(snapshotPath ? { snapshotPath, baseDir } : {}),
      });
    } catch {
      // Structural bytes still participate in the generation; Pi owns the diagnostic.
    }
  }

  return {
    value: hash.digest("hex"),
    descriptors: candidates.map((candidate) => candidate.relativePath),
    skillDescriptors,
  };
}

export function selectSkillDescriptors(roots: readonly string[]): SelectedSkillDescriptor[] {
  const selected = new Map<string, SelectedSkillDescriptor>();
  const visitedRoots = new Set<string>();
  roots.forEach((root, rootIndex) => {
    if (visitedRoots.has(root)) return;
    visitedRoots.add(root);
    for (const descriptor of enumerateSkillDescriptors(root)) {
      if (!selected.has(descriptor.name)) selected.set(descriptor.name, { descriptor, rootIndex });
    }
  });
  return [...selected.values()].sort((left, right) => compareBytes(left.descriptor.name, right.descriptor.name));
}

export async function fingerprintGlobalSkillResources(options: FingerprintResourceOptions): Promise<{
  globalSkills: SkillScopeFingerprint;
  homeSkills: SkillScopeFingerprint | null;
}> {
  const globalSkills = await fingerprintSkillRoot(
    join(options.agentDir, "skills"),
    "global",
    options.snapshotRoot,
  );
  const homeSkills = options.enableDotAgentsSkill
    ? await fingerprintSkillRoot(
        join(options.homeDir, ".agents", "skills"),
        "home",
        options.snapshotRoot,
        "agents",
      )
    : null;
  return { globalSkills, homeSkills };
}

function materializeSkillSnapshot(
  snapshotRoot: string,
  descriptor: SkillDescriptor,
  bytes: Buffer,
  baseDir: string,
): string {
  const digest = createHash("sha256")
    .update("easyresearch-skill-snapshot-v1\0")
    .update(baseDir)
    .update("\0")
    .update(bytes)
    .digest("hex");
  const directory = join(snapshotRoot, digest);
  const filename = descriptor.relativePath.endsWith("/SKILL.md")
    ? "SKILL.md"
    : descriptor.relativePath.split("/").at(-1)!;
  const snapshotPath = join(directory, filename);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeSnapshotFile(snapshotPath, bytes);
  writeSnapshotFile(join(directory, SNAPSHOT_BASE_DIR_FILE), Buffer.from(baseDir, "utf8"));
  return snapshotPath;
}

function writeSnapshotFile(path: string, bytes: Buffer): void {
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw error;
    if (!readFileSync(path).equals(bytes)) throw new Error("Skill snapshot content collision.");
  }
}

export function applySkillSnapshotBaseDirs<T extends {
  skills: Array<{ filePath: string; baseDir: string }>;
  diagnostics: unknown;
}>(current: T): T {
  return {
    ...current,
    skills: current.skills.map((skill) => {
      try {
        const baseDir = readFileSync(join(dirname(skill.filePath), SNAPSHOT_BASE_DIR_FILE), "utf8");
        return { ...skill, baseDir };
      } catch {
        return skill;
      }
    }),
  };
}

export function enumerateSkillDescriptors(
  root: string,
  mode: SkillDiscoveryMode = "pi",
): SkillDescriptor[] {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const rootStats = lstatSync(realRoot);
  if (!rootStats.isDirectory()) throw new Error("Skill fingerprint root must be a directory.");

  const candidates: SkillDescriptor[] = [];
  const visitedDirectories = new Set<string>();
  const ignoreMatcher = createIgnore();
  const ignoreBudget = { bytes: 0 };

  const addDescriptor = (logicalPath: string): void => {
    const relativePath = normalizeRelativePath(relative(root, logicalPath));
    if (!isSkillDescriptorRelativePath(relativePath, mode)) return;
    if (candidates.length >= MAX_SKILL_DESCRIPTORS) {
      throw new Error(`Skill fingerprint descriptor limit is ${MAX_SKILL_DESCRIPTORS}.`);
    }
    const resolved = realpathSync(logicalPath);
    if (!isInside(realRoot, resolved)) throw new Error("Skill descriptor changed while enumerating.");
    const stats = lstatSync(resolved);
    if (!stats.isFile()) throw new Error("Skill descriptor changed while enumerating.");
    if (stats.size > MAX_SKILL_DESCRIPTOR_BYTES) {
      throw new Error(`Skill descriptors may not exceed ${MAX_SKILL_DESCRIPTOR_BYTES} bytes.`);
    }
    const components = relativePath.split("/");
    const directFile = components.length === 1;
    const filename = directFile ? components[0] : components.at(-2);
    if (filename === undefined) return;
    let canonicalPath = resolved;
    if (!directFile) {
      canonicalPath = realpathSync(dirname(logicalPath));
      if (!isInside(realRoot, canonicalPath) || !lstatSync(canonicalPath).isDirectory()) {
        throw new Error("Skill directory changed while enumerating.");
      }
    }
    candidates.push({
      name: directFile ? filename.slice(0, -".md".length) : filename,
      relativePath,
      path: directFile ? logicalPath : dirname(logicalPath),
      skillPath: logicalPath,
      canonicalPath,
      canonicalSkillPath: resolved,
    });
  };

  const walk = (
    logicalDirectory: string,
    realDirectory: string,
    depth: number,
    isRoot: boolean,
  ): void => {
    if (depth > MAX_SKILL_DEPTH) {
      throw new Error(`Skill fingerprint traversal depth exceeds ${MAX_SKILL_DEPTH}.`);
    }
    if (visitedDirectories.has(realDirectory)) return;
    visitedDirectories.add(realDirectory);
    addIgnoreRules(ignoreMatcher, logicalDirectory, root, realRoot, ignoreBudget);

    const names = readdirSync(realDirectory);
    names.sort(compareBytes);

    if (!isRoot && names.includes("SKILL.md")) {
      const descriptorPath = join(realDirectory, "SKILL.md");
      const descriptor = locateEntry(descriptorPath, realRoot);
      const relativeDescriptor = normalizeRelativePath(relative(root, join(logicalDirectory, "SKILL.md")));
      if (descriptor?.kind === "file" && !ignoreMatcher.ignores(relativeDescriptor)) {
        addDescriptor(join(logicalDirectory, "SKILL.md"));
        return;
      }
      if (descriptor?.kind === "outside") return;
    }

    for (const name of names) {
      if (name.startsWith(".") || name === "node_modules" || (isRoot && name.endsWith(".bak"))) continue;
      const entryPath = join(realDirectory, name);
      const entry = locateEntry(entryPath, realRoot);
      if (entry === null || entry.kind === "outside" || entry.kind === "other") continue;
      const relativeEntry = normalizeRelativePath(relative(root, join(logicalDirectory, name)));
      const ignorePath = entry.kind === "directory" ? `${relativeEntry}/` : relativeEntry;
      if (ignoreMatcher.ignores(ignorePath)) continue;
      if (entry.kind === "file") {
        if (
          (mode === "pi" && isRoot && name.endsWith(".md"))
          || (mode === "agents" && !isRoot && name.endsWith(".md"))
        ) addDescriptor(join(logicalDirectory, name));
        continue;
      }
      walk(join(logicalDirectory, name), entry.realPath, depth + 1, false);
    }
  };

  walk(root, realRoot, 0, true);
  candidates.sort((left, right) => compareBytes(left.relativePath, right.relativePath));
  return candidates;
}

function addIgnoreRules(
  ignoreMatcher: ReturnType<typeof createIgnore>,
  directory: string,
  root: string,
  realRoot: string,
  budget: { bytes: number },
): void {
  const relativeDirectory = normalizeRelativePath(relative(root, directory));
  const prefix = relativeDirectory ? `${relativeDirectory}/` : "";
  for (const filename of IGNORE_FILE_NAMES) {
    const path = join(directory, filename);
    if (!existsSync(path)) continue;
    let content: string;
    try {
      const resolved = realpathSync(path);
      if (!isInside(realRoot, resolved)) continue;
      const stats = lstatSync(resolved);
      if (!stats.isFile()) continue;
      if (stats.size > MAX_SKILL_IGNORE_BYTES || budget.bytes + stats.size > MAX_SKILL_IGNORE_BYTES) {
        throw new Error(`Skill ignore controls may not exceed ${MAX_SKILL_IGNORE_BYTES} bytes.`);
      }
      content = readFileSync(resolved, "utf8");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Skill ignore controls")) throw error;
      // Match Pi: an unreadable ignore file does not make Skill discovery fail.
      continue;
    }
    budget.bytes += Buffer.byteLength(content);
    const patterns = content
      .split(/\r?\n/u)
      .map((line) => prefixIgnorePattern(line, prefix))
      .filter((line): line is string => line !== null);
    if (patterns.length > 0) ignoreMatcher.add(patterns);
  }
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) return null;
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}

function locateEntry(path: string, realRoot: string): LocatedEntry | null {
  try {
    lstatSync(path);
    const resolved = realpathSync(path);
    if (!isInside(realRoot, resolved)) return { kind: "outside" };
    const stats = lstatSync(resolved);
    if (stats.isFile()) return { kind: "file", realPath: resolved };
    if (stats.isDirectory()) return { kind: "directory", realPath: resolved };
    return { kind: "other", realPath: resolved };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readDescriptor(
  path: string,
  logicalPath: string,
  root: string,
  realRoot: string,
  rootStats: Awaited<ReturnType<typeof lstat>>,
): Promise<Buffer> {
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch (error) {
    if (isMissing(error)) throw new Error("Skill descriptor changed while fingerprinting.");
    throw error;
  }
  if (!isInside(realRoot, resolved)) throw new Error("Skill descriptor changed while fingerprinting.");

  const pathStats = await lstat(resolved);
  if (!pathStats.isFile()) throw new Error("Skill descriptor changed while fingerprinting.");
  const handle = await open(resolved, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFileSnapshot(pathStats, before)) {
      throw new Error("Skill descriptor changed while fingerprinting.");
    }
    if (before.size > MAX_SKILL_DESCRIPTOR_BYTES) {
      throw new Error(`Skill descriptors may not exceed ${MAX_SKILL_DESCRIPTOR_BYTES} bytes.`);
    }

    const capacity = Math.min(MAX_SKILL_DESCRIPTOR_BYTES + 1, Math.max(1, before.size + 1));
    const bytes = Buffer.allocUnsafe(capacity);
    let length = 0;
    while (length < bytes.byteLength) {
      const result = await handle.read(bytes, length, bytes.byteLength - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }

    const after = await handle.stat();
    if (length > MAX_SKILL_DESCRIPTOR_BYTES) {
      throw new Error(`Skill descriptors may not exceed ${MAX_SKILL_DESCRIPTOR_BYTES} bytes.`);
    }
    if (length !== before.size || !sameFileSnapshot(before, after)) {
      throw new Error("Skill descriptor changed while fingerprinting.");
    }
    await assertDescriptorStillCurrent(logicalPath, root, realRoot, rootStats, after);
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function assertDescriptorStillCurrent(
  logicalPath: string,
  root: string,
  realRoot: string,
  rootStats: Awaited<ReturnType<typeof lstat>>,
  descriptorStats: Awaited<ReturnType<typeof lstat>>,
): Promise<void> {
  let confirmedRoot: string;
  let confirmedDescriptor: string;
  try {
    confirmedRoot = await realpath(root);
    confirmedDescriptor = await realpath(logicalPath);
  } catch (error) {
    if (isMissing(error)) throw new Error("Skill descriptor changed while fingerprinting.");
    throw error;
  }
  if (confirmedRoot !== realRoot || !isInside(confirmedRoot, confirmedDescriptor)) {
    throw new Error("Skill descriptor changed while fingerprinting.");
  }

  const currentRootStats = await lstat(confirmedRoot);
  const currentDescriptorStats = await lstat(confirmedDescriptor);
  if (
    !currentRootStats.isDirectory() ||
    !sameFileIdentity(rootStats, currentRootStats) ||
    !currentDescriptorStats.isFile() ||
    !sameFileSnapshot(descriptorStats, currentDescriptorStats)
  ) {
    throw new Error("Skill descriptor changed while fingerprinting.");
  }
}

function sameFileSnapshot(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameFileIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function normalizeRelativePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function updateHashField(hash: ReturnType<typeof createHash>, bytes: Uint8Array): void {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
