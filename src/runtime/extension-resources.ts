import { createHash } from "node:crypto";
import { lstatSync, type Stats } from "node:fs";
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ConfigurationSourceError } from "./configuration-source-error";
import { parsePiSettingsJson } from "./pi-settings-json";

export const MAX_EXTENSION_DEPTH = 16;
export const MAX_EXTENSION_SOURCE_BYTES = 1_048_576;
const MAX_EXTENSION_BYTES = 16_777_216;
const MAX_EXTENSION_DIRECTORIES = 4096;
const MAX_EXTENSION_ENTRIES = 32_768;
const MAX_EXTENSION_SELECTIONS = 128;
const SOURCE_SUFFIXES = new Set([".ts", ".js", ".mjs", ".cjs", ".mts", ".cts", ".json"]);
const EXCLUDED_COMPONENTS = new Set(["node_modules", ".git", ".pi", ".lazypaper"]);

/**
 * Change evidence only: Pi still owns entrypoint discovery, loading and diagnostics.
 * Standard extension trees and explicit local sources include bounded code/JSON
 * helpers. Explicit files do not imply a scan of their sibling directory, and
 * imports outside a selected tree are not resolved. No extension is evaluated.
 *
 * External sources and linked targets are fingerprinted for manual/idle preflight,
 * not automatically watched. Broad roots (HOME/config ancestors), package specs,
 * dependency trees and foreign configuration are never traversed.
 */
export async function fingerprintExtensionResources(configRoot: string): Promise<{ value: string }> {
  const root = resolve(configRoot);
  const home = resolve(homedir());
  const physicalRoot = await optionalRealpath(root);
  const physicalHome = await optionalRealpath(home);
  const hash = createHash("sha256");
  hash.update("easyresearch-extension-resources-v1\0");
  const key = (path: string) => relative(root, path).split(sep).join("/");
  const selection = await readSelection(join(root, "settings.json"));
  hashField(hash, selection.value);
  const sources = new Set([join(root, "extensions")]);
  for (const entry of selection.entries) {
    const path = localExtensionPath(entry, root, home);
    if (path) sources.add(path);
  }
  const directories = new Set<string>();
  let entries = 0;
  let bytesRead = 0;

  const broadDirectory = (path: string) => path === home || path === physicalHome
    || within(path, root) || (physicalRoot !== undefined && within(path, physicalRoot));

  const visit = async (path: string, depth: number): Promise<void> => {
    if (excluded(path)) return;
    let stats: Stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (!missing(error)) throw sourceError(path);
      hashField(hash, `missing:${key(path)}`);
      return;
    }

    let physical = path;
    if (stats.isSymbolicLink()) {
      hashField(hash, `link:${key(path)}`);
      try {
        hashField(hash, await readlink(path));
        const target = await optionalRealpath(path);
        if (!target || excluded(target)) return;
        physical = target;
        hashField(hash, relative(physicalRoot ?? root, physical).split(sep).join("/"));
        stats = await lstat(physical);
      } catch {
        throw sourceError(path);
      }
    } else {
      physical = await optionalRealpath(path) ?? path;
      if (excluded(physical)) return;
    }

    if (stats.isFile()) {
      if (!SOURCE_SUFFIXES.has(extname(path).toLowerCase())) return;
      const bytes = await readBoundedFile(path, physical, stats);
      bytesRead += bytes.byteLength;
      if (bytesRead > MAX_EXTENSION_BYTES) throw sourceError(path);
      hashField(hash, `file:${key(path)}`);
      hashField(hash, bytes);
      return;
    }
    if (!stats.isDirectory() || broadDirectory(physical)) return;
    if (depth > MAX_EXTENSION_DEPTH) throw sourceError(path);
    hashField(hash, `directory:${key(path)}`);
    if (directories.has(physical)) return;
    if (directories.size >= MAX_EXTENSION_DIRECTORIES) throw sourceError(path);
    directories.add(physical);
    const names: string[] = [];
    try {
      const directory = await opendir(physical);
      for await (const entry of directory) {
        if (++entries > MAX_EXTENSION_ENTRIES) throw sourceError(path);
        if (!EXCLUDED_COMPONENTS.has(entry.name)) names.push(entry.name);
      }
      names.sort();
      for (const name of names) await visit(join(path, name), depth + 1);
      await assertCurrent(path, physical, stats);
    } catch (error) {
      if (error instanceof ConfigurationSourceError) throw error;
      throw sourceError(path);
    }
  };

  for (const path of [...sources].sort()) await visit(path, 0);
  return { value: hash.digest("hex") };
}

/**
 * Standard authored-root watch admission. Use with followSymlinks:false and a
 * stable parent anchor. Linked entries themselves remain observable; their
 * descendants/targets require fingerprint preflight. No HOME/project enumeration.
 */
export function createExtensionWatchFilter(extensionRoot: string) {
  const root = resolve(extensionRoot);
  const entries = new Set<string>();
  const directories = new Set<string>();
  const links = new Set<string>();

  return Object.assign((candidate: string): boolean => {
    const path = resolve(candidate);
    if (!within(root, path)) return false;
    const child = relative(root, path);
    if (!child) return true;
    const components = child.split(sep);
    if (components.length > MAX_EXTENSION_DEPTH + 1 || components.some((name) => EXCLUDED_COMPONENTS.has(name))) return false;
    let cursor = root;
    // A selected root itself can be linked, but Chokidar must never descend it.
    for (let index = 0; index <= components.length; index += 1) {
      const leaf = index === components.length;
      let stats: Stats | undefined;
      try {
        stats = lstatSync(cursor);
      } catch (error) {
        if (!missing(error)) throw sourceError(cursor);
      }
      if (!leaf && stats && !stats.isDirectory()) return false;
      if (leaf) {
        const directory = stats?.isDirectory() ?? directories.has(path);
        const link = stats?.isSymbolicLink() ?? links.has(path);
        if (directory && components.length > MAX_EXTENSION_DEPTH) return false;
        if (!directory && !link && !SOURCE_SUFFIXES.has(extname(path).toLowerCase())) return false;
        if (!entries.has(path) && entries.size >= MAX_EXTENSION_ENTRIES) throw sourceError(path);
        entries.add(path);
        if (directory) {
          if (!directories.has(path) && directories.size >= MAX_EXTENSION_DIRECTORIES) throw sourceError(path);
          directories.add(path);
        }
        if (link) links.add(path);
        return directory || link || !stats || stats.isFile();
      }
      cursor = join(cursor, components[index]!);
    }
    return false;
  }, {
    affectsDiscovery(path: string): boolean {
      return path === root || directories.has(path) || links.has(path);
    },
  });
}

/** Web writes share automatic source eligibility; linked/external targets stay preflight-only. */
export function isStandardExtensionSource(configRoot: string, candidate: string): boolean {
  const path = resolve(candidate);
  if (!SOURCE_SUFFIXES.has(extname(path).toLowerCase())
    || !createExtensionWatchFilter(join(configRoot, "extensions"))(path)) return false;
  try {
    return lstatSync(path).isFile();
  } catch (error) {
    if (missing(error)) return true;
    throw sourceError(path);
  }
}

/**
 * Notification-only parent anchors for authored directory replacement. A native
 * name watch is necessary: Chokidar can miss a replaced directory when its child
 * names stay identical. The caller owns these anchors with its resource watcher.
 */
export async function extensionWatchAnchors(extensionRoot: string): Promise<string[]> {
  const root = resolve(extensionRoot);
  const anchors = [root];
  const allowed = createExtensionWatchFilter(root);
  let entries = 0;
  const visit = async (path: string): Promise<void> => {
    try {
      const stats = await lstat(path);
      if (!stats.isDirectory()) return;
      const children: string[] = [];
      const directory = await opendir(path);
      for await (const entry of directory) {
        if (++entries > MAX_EXTENSION_ENTRIES) throw sourceError(path);
        if (entry.isDirectory() && allowed(join(path, entry.name))) children.push(join(path, entry.name));
      }
      for (const child of children.sort()) {
        anchors.push(child);
        await visit(child);
      }
    } catch (error) {
      if (missing(error)) return;
      if (error instanceof ConfigurationSourceError) throw error;
      throw sourceError(path);
    }
  };
  await visit(root);
  return anchors;
}

async function readSelection(path: string): Promise<{ value: string; entries: string[] }> {
  const physical = await optionalRealpath(path);
  if (!physical || excluded(physical)) return { value: "[]", entries: [] };
  let bytes: Buffer;
  try {
    bytes = await readBoundedFile(path, physical, await lstat(physical));
  } catch {
    throw sourceError(path);
  }
  let parsed: unknown;
  try {
    parsed = parsePiSettingsJson(bytes.toString("utf8"));
  } catch {
    // Settings validation remains host-owned; preserve opaque evidence for repair.
    return { value: `invalid:${createHash("sha256").update(bytes).digest("hex")}`, entries: [] };
  }
  const selection = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).extensions ?? []
    : [];
  if (Array.isArray(selection) && selection.length > MAX_EXTENSION_SELECTIONS) throw sourceError(path);
  return {
    value: JSON.stringify(selection),
    entries: Array.isArray(selection) ? selection.filter((entry): entry is string => typeof entry === "string") : [],
  };
}

function localExtensionPath(entry: string, root: string, home: string): string | undefined {
  // These are Pi override patterns, not discovery paths. Do not expand globs.
  if (!entry || entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-")
    || entry.includes("*") || entry.includes("?") || entry.includes("\0")) return undefined;
  const value = entry.trim();
  if (!value || (!isAbsolute(value) && /^[a-z][a-z\d+.-]*:/i.test(value))) return undefined;
  return value === "~" ? home : value.startsWith("~/") || value.startsWith("~\\")
    ? resolve(home, value.slice(2)) : resolve(root, value);
}

async function readBoundedFile(path: string, physical: string, expected: Stats): Promise<Buffer> {
  if (!expected.isFile() || expected.size > MAX_EXTENSION_SOURCE_BYTES) throw sourceError(path);
  const handle = await open(physical, "r").catch(() => { throw sourceError(path); });
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameSnapshot(expected, before)) throw sourceError(path);
    const bytes = Buffer.allocUnsafe(Math.max(1, before.size + 1));
    let length = 0;
    while (length < bytes.byteLength) {
      const read = await handle.read(bytes, length, bytes.byteLength - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length !== before.size || !sameSnapshot(before, await handle.stat())) throw sourceError(path);
    await assertCurrent(path, physical, before);
    return bytes.subarray(0, length);
  } catch {
    throw sourceError(path);
  } finally {
    await handle.close();
  }
}

async function assertCurrent(path: string, physical: string, before: Stats): Promise<void> {
  if (await optionalRealpath(path) !== physical || !sameSnapshot(before, await lstat(physical))) throw sourceError(path);
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function optionalRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw sourceError(path);
  }
}

function excluded(path: string): boolean {
  return path.split(sep).some((name) => EXCLUDED_COMPONENTS.has(name));
}

function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function sourceError(path: string): ConfigurationSourceError {
  return new ConfigurationSourceError(path, "read");
}

function hashField(hash: ReturnType<typeof createHash>, content: string | Buffer): void {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}
