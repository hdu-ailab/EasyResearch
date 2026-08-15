import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { embeddedFiles, embeddedVersion } from "../generated/embedded-assets";

export const EMBEDDED_VERSION = "0.0.0-dev";

export function isEmbeddedBuild(): boolean {
  return typeof Bun !== "undefined" && "embeddedFiles" in Bun && Bun.embeddedFiles.length > 0;
}

export function embeddedPackageVersion(): string {
  return embeddedVersion !== EMBEDDED_VERSION ? embeddedVersion : readDevPackageVersion();
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
 * compiled binaries this is the first-run materialized directory; in source
 * mode it is the repo root, so nothing is ever copied.
 */
export function bundledSourceRoot(): string {
  return process.env.EASYRESEARCH_BUNDLED_ROOT ?? devSourceRoot();
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
 * Write bundled assets (map of repo-relative path to file content) into
 * `root` with a version marker. Idempotent: same version leaves the tree as-is.
 */
export function writeBundledFiles(
  root: string,
  files: Record<string, string>,
  version: string,
  log: (msg: string) => void,
): void {
  const marker = bundledVersionMarker(root);
  if (existsSync(marker) && readFileSync(marker, "utf8") === version) return;
  log(`Extracting bundled agents, skills, and assets to ${root}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const rel of Object.keys(files)) {
    const target = join(root, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, files[rel]!);
  }
  writeFileSync(marker, version);
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
  const marker = bundledVersionMarker(root);
  if (existsSync(marker) && readFileSync(marker, "utf8") === version) {
    if (!process.env.EASYRESEARCH_BUNDLED_ROOT) process.env.EASYRESEARCH_BUNDLED_ROOT = root;
    return;
  }
  const content: Record<string, string> = {};
  for (const rel of Object.keys(embeddedFiles)) {
    if (rel.startsWith("webui/")) continue;
    content[rel] = readFileSync(embeddedFiles[rel]!, "utf8");
  }
  writeBundledFiles(root, content, version, log);
  process.env.EASYRESEARCH_BUNDLED_ROOT = root;
}
