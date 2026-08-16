import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedFiles, embeddedVersion } from "@easyresearch/embedded-assets";

export const EMBEDDED_VERSION = "0.0.0-dev";

export function isEmbeddedBuild(): boolean {
  return typeof Bun !== "undefined" && "embeddedFiles" in Bun && Bun.embeddedFiles.length > 0;
}

export function embeddedPackageVersion(): string {
  return (embeddedVersion as string) !== EMBEDDED_VERSION ? embeddedVersion : readDevPackageVersion();
}

function readDevPackageVersion(): string {
  try {
    const { version } = JSON.parse(readFileSync(join(devSourceRoot(), "package.json"), "utf8")) as {
      version?: string;
    };
    return version ?? EMBEDDED_VERSION;
  } catch {
    return EMBEDDED_VERSION;
  }
}

/**
 * Repo root when running from source. Compiled binaries never reach this:
 * embedded lookup wins and nothing here is readable from `/$bunfs`.
 */
export function devSourceRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Default EasyResearch agent dir, mirroring `getAgentDir()` from pi-import
 * without importing it (avoids an import cycle).
 */
export function defaultAgentDir(): string {
  return process.env.EASYRESEARCH_CODING_AGENT_DIR || join(homedir(), ".easyresearch", "agent");
}

/**
 * Root used by bundled-asset consumers (agents, skills, pi assets). In
 * compiled binaries this is the first-run materialized directory (contains
 * `agents/`, `skills/`, `pi/` directly); in source mode it is the `src/`
 * tree, where those resources actually live.
 */
export function bundledSourceRoot(): string {
  return process.env.EASYRESEARCH_BUNDLED_ROOT ?? join(devSourceRoot(), "src");
}

export function bundledMaterializeRoot(agentDir: string): string {
  return join(agentDir, "bundled");
}

export function bundledVersionMarker(root: string): string {
  return join(root, ".easyresearch-bundled-version");
}

/**
 * Resolve a bundled asset (keyed by repo-relative path, e.g. `webui/dist/index.html`
 * or `agents/paper-assistant.md`). Returns the embedded path for compiled
 * binaries, the on-disk path under `src/` when running from source, or
 * `undefined` when the asset does not exist in either place.
 */
export function bundledFilePath(rel: string): string | undefined {
  const embedded = embeddedFiles[rel];
  if (embedded !== undefined) return embedded;
  const disk = join(devSourceRoot(), "src", rel);
  return existsSync(disk) ? disk : undefined;
}

/**
 * List bundled asset keys under a repo-relative prefix. Embedded maps are
 * the source of truth for compiled binaries (directory listing is not
 * supported on the embedded filesystem); source mode lists the `src/` tree.
 */
export function listBundledAssets(prefix: string): string[] {
  const embeddedKeys = Object.keys(embeddedFiles).filter((key) => key.startsWith(prefix));
  if (embeddedKeys.length > 0) return embeddedKeys;
  const root = join(devSourceRoot(), "src", prefix);
  return listFilesRecursive(root, prefix);
}

function listFilesRecursive(root: string, prefix: string): string[] {
  const files: string[] = [];
  const normalized = root.replace(/[\\/]$/, "");
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) files.push(prefix + abs.slice(normalized.length + 1).split("\\").join("/"));
    }
  };
  visit(normalized);
  return files.sort();
}

/**
 * Write bundled assets into a sibling staging tree, then replace `root` with
 * rollback protection. A matching marker is accepted only when every expected
 * file exists, so interrupted or manually damaged extractions are repaired.
 */
export function writeBundledFiles(
  root: string,
  files: Record<string, string | Uint8Array>,
  version: string,
  log: (msg: string) => void,
): void {
  const expectedFiles = Object.keys(files).sort();
  for (const rel of expectedFiles) assertSafeBundledPath(rel);
  if (isCompleteBundledRoot(root, version, expectedFiles)) return;
  log(`Extracting bundled agents, skills, and assets to ${root}`);
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const staging = `${root}.staging-${suffix}`;
  const backup = `${root}.backup-${suffix}`;
  mkdirSync(dirname(root), { recursive: true });
  mkdirSync(staging, { recursive: true });
  let oldMoved = false;
  let promoted = false;
  try {
    for (const rel of expectedFiles) {
      const target = join(staging, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, files[rel]!);
      syncFile(target);
    }
    writeFileSync(bundledVersionMarker(staging), version);
    syncFile(bundledVersionMarker(staging));
    if (!isCompleteBundledRoot(staging, version, expectedFiles)) {
      throw new Error("Bundled resource staging validation failed");
    }
    if (existsSync(root)) {
      renameSync(root, backup);
      oldMoved = true;
    }
    renameSync(staging, root);
    promoted = true;
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (oldMoved && !promoted && !existsSync(root) && existsSync(backup)) renameSync(backup, root);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (promoted) rmSync(backup, { recursive: true, force: true });
  }
}

export function isCompleteBundledRoot(root: string, version: string, expectedFiles: readonly string[]): boolean {
  try {
    if (readFileSync(bundledVersionMarker(root), "utf8") !== version) return false;
    return expectedFiles.every((rel) => {
      assertSafeBundledPath(rel);
      return statSync(join(root, rel)).isFile();
    });
  } catch {
    return false;
  }
}

function assertSafeBundledPath(rel: string): void {
  const parts = rel.replaceAll("\\", "/").split("/");
  if (!rel || isAbsolute(rel) || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid bundled asset path: ${rel}`);
  }
}

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    try {
      fsyncSync(fd);
    } catch {
      // fsync is best-effort durability and is not supported on every
      // Windows handle; staged bytes stay durable via normal close semantics.
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * First-run materialization for compiled binaries: extract embedded agents,
 * skills, and pi assets (web UI stays on the embedded filesystem) under
 * `<agentDir>/bundled` (version-gated) and point `EASYRESEARCH_BUNDLED_ROOT`
 * at it. No-op when running from source.
 */
export function materializeBundledIfNeeded(
  agentDir: string,
  version: string,
  log: (msg: string) => void,
): void {
  if (!isEmbeddedBuild()) return;
  const root = bundledMaterializeRoot(agentDir);
  const assetKeys = Object.keys(embeddedFiles).filter((rel) => !rel.startsWith("webui/"));
  if (isCompleteBundledRoot(root, version, assetKeys)) {
    if (!process.env.EASYRESEARCH_BUNDLED_ROOT) process.env.EASYRESEARCH_BUNDLED_ROOT = root;
    return;
  }
  const content: Record<string, Uint8Array> = {};
  for (const rel of assetKeys) {
    content[rel] = readFileSync(embeddedFiles[rel]!);
  }
  writeBundledFiles(root, content, version, log);
  process.env.EASYRESEARCH_BUNDLED_ROOT = root;
}

/**
 * Resolve an already materialized compiled bundle without mutating disk. This
 * is the only resource action allowed when EASYRESEARCH_SKIP_SETUP is set.
 */
export function useExistingMaterializedBundle(agentDir: string, version: string): void {
  if (!isEmbeddedBuild()) return;
  const root = bundledMaterializeRoot(agentDir);
  const assetKeys = Object.keys(embeddedFiles).filter((rel) => !rel.startsWith("webui/"));
  if (!isCompleteBundledRoot(root, version, assetKeys)) {
    throw new Error("Setup required: run EasyResearch once without EASYRESEARCH_SKIP_SETUP");
  }
  process.env.EASYRESEARCH_BUNDLED_ROOT = root;
}
