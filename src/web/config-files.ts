import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { ConfigEntryDto, ConfigScope } from "./contracts";
import { getAgentDir } from "../runtime/pi-import";

export class ConfigPathError extends Error {}

export class ConfigServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ConfigReadInput {
  scope: ConfigScope;
  cwd?: string;
  path: string;
}

export interface ConfigWriteInput {
  scope: ConfigScope;
  cwd?: string;
  path: string;
  content: string;
}

export interface ConfigListInput {
  scope: ConfigScope;
  cwd?: string;
  path?: string;
}

export interface AuthoritativeConfigChange {
  agentsChanged?: true;
  modelsChanged?: true;
}

export interface ConfigFileServiceOptions {
  onAuthoritativeWrite?: (change: AuthoritativeConfigChange) => void | Promise<void>;
}

/**
 * Resolve a user-supplied relative path against an allowed root, returning the
 * canonical target. Every segment is checked: no empty path, no absolute path,
 * no NUL bytes, no `..` escape, and the canonicalized target (following
 * symlinks, and re-joining the missing tail for not-yet-created files) must
 * remain inside the canonical root. `read` additionally requires the target to
 * exist; `write` allows creation of the final component.
 */
export function resolveAllowedConfigPath(
  root: string,
  relativePath: string,
  mode: "read" | "write",
): string {
  if (!relativePath) throw new ConfigPathError("Empty relative path");
  if (isAbsolute(relativePath)) throw new ConfigPathError(`Absolute path is not allowed: ${relativePath}`);
  if (relativePath.includes("\0")) throw new ConfigPathError("NUL byte is not allowed in path");
  const normalized = normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new ConfigPathError(`Path escapes the allowed root: ${relativePath}`);
  }
  const canonicalRoot =
    mode === "read" ? fs.realpathSync(root) : canonicalizeNearestAncestor(root);
  const target = canonicalizeNearestAncestor(join(canonicalRoot, normalized));
  const rel = relative(canonicalRoot, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ConfigPathError(`Path escapes the allowed root: ${relativePath}`);
  }
  if (mode === "read" && !fs.existsSync(target)) {
    throw new ConfigServiceError(404, `does not exist: ${relativePath}`);
  }
  return target;
}

function canonicalizeNearestAncestor(target: string): string {
  const missingTail: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return missingTail.length === 0 ? real : join(real, ...missingTail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new ConfigPathError(`cannot resolve: ${target}`);
      missingTail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Bounded local config editor. Global scope is the agent root; project scope is
 * the selected cwd's `.easyresearch` directory. JSON files are validated before
 * any write; writes are atomic same-directory temp files with mode 0o600.
 * File contents are never logged or embedded in errors.
 */
export class ConfigFileService {
  constructor(
    private readonly agentDir: string = getAgentDir(),
    private readonly options: ConfigFileServiceOptions = {},
  ) {}

  get globalRoot(): string {
    return this.agentDir;
  }

  async list(input: ConfigListInput): Promise<ConfigEntryDto[]> {
    const root = this.rootFor(input.scope, input.cwd);
    const dirPath = input.path
      ? resolveAllowedConfigPath(root, input.path, "read")
      : root;
    let dirents;
    try {
      dirents = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !input.path) return [];
      throw new ConfigServiceError(404, `does not exist: ${input.path ?? dirPath}`);
    }
    return dirents
      .map((dirent) => ({
        name: dirent.name,
        path: relative(root, join(dirPath, dirent.name)),
        type: dirent.isDirectory() ? ("directory" as const) : ("file" as const),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(input: ConfigReadInput): Promise<string> {
    const root = this.rootFor(input.scope, input.cwd);
    let target: string;
    try {
      target = resolveAllowedConfigPath(root, input.path, "read");
    } catch (error) {
      // Read-mode root resolution realpaths the root, which throws a raw ENOENT
      // when the project `.easyresearch` directory itself is absent yet.
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        throw new ConfigServiceError(404, `does not exist: ${input.path}`);
      }
      throw error;
    }
    try {
      return fs.readFileSync(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ConfigServiceError(404, `does not exist: ${input.path}`);
      }
      throw new ConfigServiceError(400, `Cannot read ${input.path}`);
    }
  }

  async write(input: ConfigWriteInput): Promise<void> {
    const root = this.rootFor(input.scope, input.cwd);
    if (input.path.endsWith(".json")) {
      try {
        JSON.parse(input.content);
      } catch {
        throw new ConfigServiceError(400, "Invalid JSON");
      }
    }
    const target = resolveAllowedConfigPath(root, input.path, "write");
    fs.mkdirSync(dirname(target), { recursive: true });
    const tempPath = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tempPath, input.content, { mode: 0o600 });
      fs.renameSync(tempPath, target);
      const change = authoritativeChange(input);
      if (change) await this.options.onAuthoritativeWrite?.(change);
    } catch (error) {
      throw error;
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }

  async createDirectory(input: ConfigListInput): Promise<void> {
    const root = this.rootFor(input.scope, input.cwd);
    const target = input.path
      ? resolveAllowedConfigPath(root, input.path, "write")
      : root;
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch (error) {
      throw new ConfigServiceError(400, `Cannot create directory: ${input.path ?? target}`);
    }
  }

  private rootFor(scope: ConfigScope, cwd?: string): string {
    if (scope === "global") return this.agentDir;
    if (!cwd) throw new ConfigServiceError(400, "cwd is required for project scope");
    let stat;
    try {
      stat = fs.statSync(cwd);
    } catch {
      throw new ConfigServiceError(404, `does not exist: ${cwd}`);
    }
    if (!stat.isDirectory()) throw new ConfigServiceError(400, `not a directory: ${cwd}`);
    return join(fs.realpathSync(cwd), ".easyresearch");
  }
}

function authoritativeChange(input: ConfigWriteInput): AuthoritativeConfigChange | undefined {
  if (input.scope !== "global") return undefined;
  const path = normalize(input.path);
  if (path === "models.json") return { modelsChanged: true };
  if (path === "settings.json") return { agentsChanged: true };
  if (dirname(path) === "agents" && basename(path).endsWith(".md")) {
    return { agentsChanged: true };
  }
  return undefined;
}
