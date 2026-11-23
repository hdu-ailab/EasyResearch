import { constants } from "node:fs";
import { access, lstat, opendir, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { setImmediate } from "node:timers/promises";
import { DirectoryServiceError, fileServiceError } from "./directories";
import type { FileReferencesResolvedDto } from "./file-reference-contracts";

export function validateFileReferences(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "references")) {
    throw new DirectoryServiceError(400, "Expected references array");
  }
  const references = (body as { references?: unknown }).references;
  if (!Array.isArray(references) || references.length < 1 || references.length > 64
    || !references.every((value) => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\p{Cc}]/u.test(value))) {
    throw new DirectoryServiceError(400, "Expected 1–64 file references of at most 4096 characters");
  }
  return [...new Set<string>(references)];
}

const networkPath = (path: string) => /^[\\/]{2}/u.test(path);
const foreignDrive = (path: string) => process.platform !== "win32" && /^[a-z]:[\\/]/iu.test(path);
const comparable = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;

function referenceError(error: unknown, path: string): DirectoryServiceError | undefined {
  if (error instanceof DirectoryServiceError) return error;
  if (error && typeof error === "object" && "code" in error && error.code === "ENAMETOOLONG") {
    return new DirectoryServiceError(400, "File reference path is too long");
  }
  return fileServiceError(error, path);
}

/** Resolve links explicitly so a metadata probe cannot follow a link to a network share. */
async function localPhysicalPath(path: string, signal?: AbortSignal, boundary?: string, links = 0): Promise<string | null> {
  if (links > 40 || networkPath(path)) return null;
  const root = parse(path).root;
  let current = root;
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    signal?.throwIfAborted();
    current = join(current, parts[i]!);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      const target = await readlink(current);
      if (networkPath(target)) return null;
      const destination = resolve(dirname(current), target);
      if (boundary && i < parts.length - 1 && !contained(boundary, destination)) return null;
      return localPhysicalPath(join(destination, ...parts.slice(i + 1)), signal, boundary, links + 1);
    }
    if (i < parts.length - 1 && !stat.isDirectory()) return null;
  }
  signal?.throwIfAborted();
  return current;
}

function contained(root: string, path: string): boolean {
  const tail = relative(root, path);
  return tail === "" || (!tail.startsWith(`..${sep}`) && tail !== ".." && !isAbsolute(tail));
}

/** null means unprobed/non-file, never evidence authorizing a suffix replacement. */
async function regularFile(path: string, signal?: AbortSignal, boundary?: string): Promise<boolean | null> {
  try {
    const physical = await localPhysicalPath(path, signal, boundary);
    if (!physical || !(await lstat(physical)).isFile()) return null;
    await access(physical, constants.R_OK);
    signal?.throwIfAborted();
    return true;
  } catch (error) {
    const failure = referenceError(error, path);
    if (failure?.status === 404) return false;
    throw failure ?? error;
  }
}

/** On-demand, metadata-only suffix traversal. No index, watchers, startup work, or Agent access. */
export async function resolveFileReferences(
  cwd: string,
  references: readonly string[],
  signal?: AbortSignal,
  limits: { maxEntries?: number; maxDirectories?: number; maxDepth?: number; maxMatches?: number; maxMs?: number } = {},
): Promise<FileReferencesResolvedDto> {
  signal?.throwIfAborted();
  const results = [...new Set(references)].map((reference) => ({ reference, paths: [] as string[], truncated: false }));
  if (networkPath(cwd)) return { references: results };
  let physicalCwd: string | null;
  try {
    physicalCwd = await localPhysicalPath(resolve(cwd), signal);
    if (physicalCwd) {
      if (!(await lstat(physicalCwd)).isDirectory()) throw new DirectoryServiceError(400, `not a directory: ${cwd}`);
      await access(physicalCwd, constants.R_OK | constants.X_OK);
    }
  }
  catch (error) { throw referenceError(error, cwd) ?? error; }
  if (!physicalCwd) return { references: results };
  const pending: Array<{ result: typeof results[number]; suffix: string }> = [];
  for (const result of results) {
    signal?.throwIfAborted();
    if (networkPath(result.reference) || foreignDrive(result.reference)) continue;
    const exact = resolve(cwd, result.reference);
    const inside = contained(resolve(cwd), exact);
    const physical = inside ? resolve(physicalCwd, relative(cwd, exact)) : exact;
    const exactFile = await regularFile(physical, signal, inside ? physicalCwd : undefined);
    if (exactFile === true) { result.paths.push(exact); continue; }
    if (exactFile === null) continue;
    if (isAbsolute(result.reference)) continue;
    const suffix = relative(cwd, exact).split(sep).join("/").replace(/^(?:\.\.\/)+/u, "");
    if (suffix && suffix !== "..") pending.push({ result, suffix: comparable(suffix) });
  }
  if (pending.length === 0) return { references: results };
  const maxEntries = limits.maxEntries ?? 12_000;
  const maxDirectories = limits.maxDirectories ?? 1024;
  const maxDepth = limits.maxDepth ?? 32;
  const maxMatches = limits.maxMatches ?? 128;
  const deadline = performance.now() + (limits.maxMs ?? 1500);
  const directories = [{ path: physicalCwd, depth: 0 }];
  let count = 0;
  let visited = 0;
  let incomplete = false;
  scan: while (directories.length > 0) {
    signal?.throwIfAborted();
    if (++visited > maxDirectories || performance.now() >= deadline) { incomplete = true; break; }
    const directory = directories.pop()!;
    try {
      // Recheck immediately before enumeration; never deliberately descend through a replaced symlink.
      if (!(await lstat(directory.path)).isDirectory()
        || await localPhysicalPath(directory.path, signal, physicalCwd) !== directory.path) { incomplete = true; continue; }
      const handle = await opendir(directory.path);
      for await (const entry of handle) {
        signal?.throwIfAborted();
        if (++count > maxEntries || performance.now() >= deadline) { incomplete = true; break scan; }
        const path = join(directory.path, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === ".git") continue;
          if (directory.depth >= maxDepth || directories.length >= maxDirectories) incomplete = true;
          else directories.push({ path, depth: directory.depth + 1 });
        } else if (entry.isFile()) {
          const candidate = comparable(relative(physicalCwd, path).split(sep).join("/"));
          const matches = pending.filter(({ suffix }) => candidate === suffix || candidate.endsWith(`/${suffix}`));
          if (matches.length && await regularFile(path, signal, physicalCwd)) {
            for (const { result } of matches) {
              if (result.paths.length >= maxMatches) result.truncated = true;
              else result.paths.push(resolve(cwd, relative(physicalCwd, path)));
            }
          }
        }
        if (count % 64 === 0) await setImmediate();
      }
    } catch (error) {
      signal?.throwIfAborted();
      const failure = referenceError(error, directory.path);
      if (!failure) throw error;
      // An unreadable/disappeared subtree cannot prove uniqueness.
      incomplete = true;
    }
  }
  for (const { result } of pending) {
    result.paths.sort();
    result.truncated ||= incomplete;
  }
  signal?.throwIfAborted();
  return { references: results };
}
