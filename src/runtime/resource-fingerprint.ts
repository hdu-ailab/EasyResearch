import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export const MAX_SKILL_DEPTH = 16;
export const MAX_SKILL_DESCRIPTORS = 4096;
export const MAX_SKILL_DESCRIPTOR_BYTES = 1_048_576;

export interface SkillScopeFingerprint {
  value: string;
  descriptors: readonly string[];
  skillDescriptors: readonly AcceptedSkillDescriptor[];
}

export interface AcceptedSkillDescriptor {
  name: string;
  relativePath: string;
}

export interface FingerprintResourceOptions {
  agentDir: string;
  homeDir: string;
  enableDotAgentsSkill: boolean;
}

export interface SkillDescriptor {
  name: string;
  relativePath: string;
  path: string;
  skillPath: string;
  canonicalPath: string;
  canonicalSkillPath: string;
}

export interface SelectedSkillDescriptor {
  descriptor: SkillDescriptor;
  rootIndex: number;
}

export function isSkillDescriptorRelativePath(relativePath: string): boolean {
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
    return filename.length > ".md".length && filename.endsWith(".md");
  }
  return components.at(-1) === "SKILL.md";
}

type LocatedEntry = { kind: "directory" | "file" | "other"; realPath: string } | { kind: "outside" };

export async function fingerprintSkillRoot(root: string, scope: string): Promise<SkillScopeFingerprint> {
  const hash = createHash("sha256");
  hash.update("easyresearch-skill-scope-v1\0");
  updateHashField(hash, Buffer.from(scope, "utf8"));

  const candidates = enumerateSkillDescriptors(root);
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

  for (const candidate of candidates) {
    const bytes = await readDescriptor(candidate.skillPath, candidate.skillPath, root, realRoot, realRootStats);
    updateHashField(hash, Buffer.from(candidate.relativePath, "utf8"));
    updateHashField(hash, bytes);
  }

  return {
    value: hash.digest("hex"),
    descriptors: candidates.map((candidate) => candidate.relativePath),
    skillDescriptors: candidates.map(({ name, relativePath }) => ({ name, relativePath })),
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
  const globalSkills = await fingerprintSkillRoot(join(options.agentDir, "skills"), "global");
  const homeSkills = options.enableDotAgentsSkill
    ? await fingerprintSkillRoot(join(options.homeDir, ".agents", "skills"), "home")
    : null;
  return { globalSkills, homeSkills };
}

export function enumerateSkillDescriptors(root: string): SkillDescriptor[] {
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

  const addDescriptor = (logicalPath: string): void => {
    const relativePath = normalizeRelativePath(relative(root, logicalPath));
    if (!isSkillDescriptorRelativePath(relativePath)) return;
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

    const names = readdirSync(realDirectory);
    names.sort(compareBytes);

    if (!isRoot && names.includes("SKILL.md")) {
      const descriptorPath = join(realDirectory, "SKILL.md");
      const descriptor = locateEntry(descriptorPath, realRoot);
      if (descriptor?.kind === "file") {
        addDescriptor(join(logicalDirectory, "SKILL.md"));
        return;
      }
      if (descriptor?.kind === "outside") return;
    }

    for (const name of names) {
      const entryPath = join(realDirectory, name);
      const entry = locateEntry(entryPath, realRoot);
      if (entry === null || entry.kind === "outside" || entry.kind === "other") continue;
      if (entry.kind === "file") {
        if (isRoot && name.endsWith(".md")) addDescriptor(join(logicalDirectory, name));
        continue;
      }
      walk(join(logicalDirectory, name), entry.realPath, depth + 1, false);
    }
  };

  walk(root, realRoot, 0, true);
  candidates.sort((left, right) => compareBytes(left.relativePath, right.relativePath));
  return candidates;
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
