import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { ConfigEntryDto, ConfigScope } from "./contracts";
import { getAgentDir } from "../runtime/pi-import";
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

class GlobalSettingsChangedError extends Error {}

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
  private settingsMutationTail: Promise<void> = Promise.resolve();

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

  async write(input: ConfigWriteInput): Promise<unknown> {
    if (isGlobalSettingsWrite(input)) {
      await this.enqueueGlobalSettingsMutation(() => this.writeNow(input, undefined, { notify: false }));
      return this.notifyPersistedWrite(input, false);
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
    const result = await this.enqueueGlobalSettingsMutation(async () => {
      const settingsPath = join(this.agentDir, "settings.json");
      for (;;) {
        const sourceBytes = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath) : undefined;
        let settings: Record<string, unknown> = {};
        if (sourceBytes !== undefined) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(sourceBytes.toString("utf8")) as unknown;
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
            if (error instanceof GlobalSettingsChangedError) continue;
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
        JSON.parse(input.content);
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
      if (!sameOptionalBytes(previous?.bytes, expected)) throw new GlobalSettingsChangedError();
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

  private enqueueGlobalSettingsMutation<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.settingsMutationTail.then(operation);
    this.settingsMutationTail = current.then(() => undefined, () => undefined);
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

function isGlobalSettingsWrite(input: ConfigWriteInput): boolean {
  return input.scope === "global" && normalize(input.path) === "settings.json";
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
