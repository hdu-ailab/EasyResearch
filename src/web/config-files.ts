import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { ConfigEntryDto, ConfigScope } from "./contracts";
import { getAgentDir, importPiAuthStorage } from "../runtime/pi-import";
import { parsePiSettingsJson } from "../runtime/pi-settings-json";
import { isSkillDescriptorRelativePath } from "../runtime/resource-fingerprint";

export class ConfigPathError extends Error {}

export class ConfigServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
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
  skillsChanged?: true;
  availabilityChanged?: true;
}

export interface ProjectConfigRegistration {
  readonly cwd: string;
  release(): Promise<void>;
}

export interface ConfigFileServiceOptions {
  onAuthoritativeWrite?: (change: AuthoritativeConfigChange) => void | Promise<unknown>;
  acquireProject?: (cwd: string) => Promise<ProjectConfigRegistration>;
  synchronizeProject?: (cwd: string) => Promise<unknown>;
}

export interface GlobalSettingsMutation<T> {
  settings: Record<string, unknown>;
  result: T;
  write?: boolean;
}

interface ProjectWriteContext {
  cwd: string;
  canonicalCwd: string;
}

type GlobalProviderFile = "models.json" | "auth.json" | "models-store.json";

class ConfigFileChangedError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  private readonly globalMutationTails = new Map<string, Promise<void>>();

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
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !input.path) return [];
      throw new ConfigServiceError(404, `does not exist: ${input.path ?? dirPath}`);
    }
    const relativeDir = input.path ? relative(fs.realpathSync(root), dirPath) : "";
    return dirents
      .map((dirent) => ({
        name: dirent.name,
        path: join(relativeDir, dirent.name),
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

  async write(input: ConfigWriteInput): Promise<unknown> {
    const storePath = this.nativeStorePath(input);
    if (input.scope === "global" && (
      isPiSettingsWrite(input) || normalize(input.path) === "models.json" || storePath
    )) {
      if (storePath) {
        try { JSON.parse(input.content); } catch { throw new ConfigServiceError(400, "Invalid JSON"); }
      }
      await this.enqueueGlobalMutation(storePath ? basename(storePath) : normalize(input.path), () => this.withNativeStoreLock(storePath,
        () => this.writeNow(input, undefined, { notify: false })));
      return this.notifyPersistedWrite(storePath ? { ...input, path: basename(storePath) } : input, false);
    }
    if (isProjectSkillDescriptorInput(input) && input.cwd && this.options.acquireProject) {
      const registration = await this.options.acquireProject(input.cwd);
      try {
        return await this.writeNow(input, this.projectWriteContext(input.cwd));
      } finally {
        await registration.release();
      }
    }
    return this.writeNow(input);
  }

  async mutateGlobalSettings<T>(
    mutate: (settings: Record<string, unknown>) => GlobalSettingsMutation<T>,
    options: { notify?: boolean } = {},
  ): Promise<T> {
    let wrote = false;
    const result = await this.enqueueGlobalMutation("settings.json", async () => {
      const settingsPath = join(this.agentDir, "settings.json");
      for (;;) {
        const sourceBytes = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath) : undefined;
        let settings: Record<string, unknown> = {};
        if (sourceBytes !== undefined) {
          let parsed: unknown;
          try {
            parsed = parsePiSettingsJson(sourceBytes.toString("utf8"));
          } catch {
            throw new ConfigServiceError(409, "Global settings.json is invalid", "CONFIG_INVALID");
          }
          if (!isRecord(parsed)) {
            throw new ConfigServiceError(409, "Global settings.json must contain an object", "CONFIG_INVALID");
          }
          settings = parsed;
        }

        const next = mutate(settings);
        if (next.write !== false) {
          try {
            await this.writeNow({
              scope: "global",
              path: "settings.json",
              content: `${JSON.stringify(next.settings, null, 2)}\n`,
            }, undefined, { notify: false, expectedPrevious: sourceBytes ?? null });
          } catch (error) {
            if (error instanceof ConfigFileChangedError) continue;
            throw error;
          }
          wrote = true;
        }
        return next.result;
      }
    });
    if (wrote && options.notify !== false) {
      await this.notifyPersistedWrite({ scope: "global", path: "settings.json", content: "" }, false);
    }
    return result;
  }

  async mutateGlobalProviderFile(
    path: GlobalProviderFile,
    mutate: (content: string | undefined) => string | undefined,
  ): Promise<{ changed: boolean; configuration: unknown }> {
    const mutateNow = async () => {
      for (;;) {
        const target = resolveAllowedConfigPath(this.agentDir, path, "write");
        let previous: Buffer | undefined;
        try {
          previous = fs.readFileSync(target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new ConfigServiceError(409, `${path} must be repaired before modifying it`);
          }
        }
        const content = mutate(previous?.toString("utf8"));
        if (content === undefined) return false;
        try {
          await this.writeNow({ scope: "global", path, content }, undefined, {
            notify: false, expectedPrevious: previous ?? null,
          });
          return true;
        } catch (error) {
          if (error instanceof ConfigFileChangedError) continue;
          throw error;
        }
      }
    };
    const changed = await this.enqueueGlobalMutation(path, () => {
      const storePath = path === "models.json" ? undefined : join(this.agentDir, path);
      return this.withNativeStoreLock(storePath && fs.existsSync(storePath) ? storePath : undefined, mutateNow);
    });
    // Acceptance can repair settings through this same queue, so notify only
    // after releasing mutation ownership.
    const configuration = changed
      ? await this.notifyPersistedWrite({ scope: "global", path, content: "" }, false)
      : undefined;
    return { changed, configuration };
  }

  private nativeStorePath(input: ConfigReadInput): string | undefined {
    if (input.scope !== "global") return undefined;
    const target = resolveAllowedConfigPath(this.agentDir, input.path, "write");
    for (const path of ["auth.json", "models-store.json"]) {
      if (target === canonicalizeNearestAncestor(join(this.agentDir, path))) return join(this.agentDir, path);
    }
    return undefined;
  }

  private async withNativeStoreLock<T>(path: string | undefined, operation: () => Promise<T>): Promise<T> {
    if (!path) return operation();
    const { FileAuthStorageBackend } = await importPiAuthStorage();
    return new FileAuthStorageBackend(path).withLockAsync(async () => ({ result: await operation() }));
  }

  private async writeNow(
    input: ConfigWriteInput,
    projectContext?: ProjectWriteContext,
    options: { notify?: boolean; expectedPrevious?: Buffer | null } = {},
  ): Promise<unknown> {
    const root = projectContext
      ? join(projectContext.canonicalCwd, ".easyresearch")
      : this.rootFor(input.scope, input.cwd);
    if (input.path.endsWith(".json")) {
      try {
        if (isPiSettingsWrite(input)) parsePiSettingsJson(input.content);
        else JSON.parse(input.content);
      } catch {
        throw new ConfigServiceError(400, "Invalid JSON");
      }
    }
    const target = resolveAllowedConfigPath(root, input.path, "write");
    const skillDescriptor = isSkillDescriptorTarget(root, target);
    const projectDescriptor = input.scope === "project" && skillDescriptor;
    const stableProject = projectDescriptor && input.cwd
      ? (projectContext ?? this.projectWriteContext(input.cwd))
      : undefined;
    if (stableProject) this.assertProjectUnchanged(stableProject);
    fs.mkdirSync(dirname(target), { recursive: true });
    const tempPath = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    const previous = fs.existsSync(target)
      ? { bytes: fs.readFileSync(target), mode: fs.statSync(target).mode }
      : undefined;
    if (options.expectedPrevious !== undefined) {
      const expected = options.expectedPrevious === null ? undefined : options.expectedPrevious;
      if (!sameOptionalBytes(previous?.bytes, expected)) throw new ConfigFileChangedError();
    }
    let persisted = false;
    try {
      fs.writeFileSync(tempPath, input.content, { mode: 0o600 });
      if (stableProject) this.assertProjectUnchanged(stableProject);
      fs.renameSync(tempPath, target);
      persisted = true;
      if (stableProject) {
        try {
          this.assertProjectUnchanged(stableProject);
        } catch (error) {
          this.restoreAfterRetarget(target, previous);
          persisted = false;
          throw error;
        }
      }
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
    if (!persisted || options.notify === false) return undefined;
    return this.notifyPersistedWrite(input, skillDescriptor);
  }

  private async notifyPersistedWrite(input: ConfigWriteInput, skillDescriptor: boolean): Promise<unknown> {
    const change = authoritativeChange(input, skillDescriptor);
    const authoritativeOutcome = change ? await this.options.onAuthoritativeWrite?.(change) : undefined;
    if (input.scope === "project" && skillDescriptor && input.cwd) {
      return await this.options.synchronizeProject?.(input.cwd) ?? authoritativeOutcome;
    }
    return authoritativeOutcome;
  }

  private projectWriteContext(cwd: string): ProjectWriteContext {
    let canonicalCwd: string;
    try {
      canonicalCwd = fs.realpathSync(cwd);
    } catch {
      throw new ConfigServiceError(404, `does not exist: ${cwd}`);
    }
    if (!fs.statSync(canonicalCwd).isDirectory()) throw new ConfigServiceError(400, `not a directory: ${cwd}`);
    return { cwd, canonicalCwd };
  }

  private assertProjectUnchanged(context: ProjectWriteContext): void {
    let current: string;
    try {
      current = fs.realpathSync(context.cwd);
    } catch {
      throw new ConfigServiceError(409, "Project changed during configuration write", "PROJECT_CHANGED");
    }
    if (current !== context.canonicalCwd) {
      throw new ConfigServiceError(409, "Project changed during configuration write", "PROJECT_CHANGED");
    }
  }

  private restoreAfterRetarget(
    target: string,
    previous: { bytes: Buffer; mode: number } | undefined,
  ): void {
    if (!previous) {
      fs.rmSync(target, { force: true });
      return;
    }
    const rollbackPath = join(dirname(target), `.${basename(target)}.${randomUUID()}.rollback`);
    try {
      fs.writeFileSync(rollbackPath, previous.bytes, { mode: previous.mode });
      fs.renameSync(rollbackPath, target);
    } finally {
      fs.rmSync(rollbackPath, { force: true });
    }
  }

  private enqueueGlobalMutation<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const current = (this.globalMutationTails.get(path) ?? Promise.resolve()).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.globalMutationTails.set(path, tail);
    void tail.then(() => {
      if (this.globalMutationTails.get(path) === tail) this.globalMutationTails.delete(path);
    });
    return current;
  }

  async createDirectory(input: ConfigListInput): Promise<void> {
    const root = this.rootFor(input.scope, input.cwd);
    const target = input.path
      ? resolveAllowedConfigPath(root, input.path, "write")
      : root;
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch {
      throw new ConfigServiceError(400, `Cannot create directory: ${input.path ?? target}`);
    }
  }

  private rootFor(scope: ConfigScope, cwd?: string): string {
    if (scope === "global") return this.agentDir;
    if (!cwd) throw new ConfigServiceError(400, "cwd is required for project scope");
    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      throw new ConfigServiceError(404, `does not exist: ${cwd}`);
    }
    if (!stat.isDirectory()) throw new ConfigServiceError(400, `not a directory: ${cwd}`);
    return join(fs.realpathSync(cwd), ".easyresearch");
  }
}

function isPiSettingsWrite(input: ConfigWriteInput): boolean {
  return normalize(input.path) === "settings.json";
}

function sameOptionalBytes(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.equals(right);
}

function isProjectSkillDescriptorInput(input: ConfigWriteInput): boolean {
  if (input.scope !== "project" || !input.cwd) return false;
  const components = input.path.split(/[\\/]/);
  if (components[0] !== "skills") return false;
  return isSkillDescriptorRelativePath(components.slice(1).join("/"));
}

function authoritativeChange(
  input: ConfigWriteInput,
  skillDescriptor: boolean,
): AuthoritativeConfigChange | undefined {
  if (input.scope !== "global") return undefined;
  const path = normalize(input.path);
  if (path === "models.json") return { modelsChanged: true };
  if (path === "auth.json" || path === "models-store.json") return { availabilityChanged: true };
  if (path === "settings.json") return {};
  if (dirname(path) === "agents" && basename(path).endsWith(".md")) {
    return { agentsChanged: true };
  }
  if (skillDescriptor) return { skillsChanged: true };
  return undefined;
}

function isSkillDescriptorTarget(root: string, target: string): boolean {
  const skillRoot = canonicalizeNearestAncestor(join(root, "skills"));
  return isSkillDescriptorRelativePath(relative(skillRoot, target));
}
