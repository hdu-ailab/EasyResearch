import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ChokidarOptions, watch as chokidarWatch } from "chokidar";
import type { ConfigurationWatchImplementation } from "./live-configuration";
import type { SkillScopeFingerprint } from "./resource-fingerprint";
import type { AcceptedSkillDescriptor } from "./resource-fingerprint";

const WATCH_DEPTH = 18;
const STABILITY_THRESHOLD_MS = 200;
const WATCH_EVENTS = ["add", "change", "unlink", "addDir", "unlinkDir"] as const;
const PROJECT_INSTALL_ATTEMPTS = 2;

export interface ResourceWatchChange {
  agentsChanged?: boolean;
  modelsChanged?: boolean;
  skillsChanged?: boolean;
  projectCwds?: readonly string[];
}

export interface WatcherDependencies {
  agentDir: string;
  homeDir: string;
  watch?: ConfigurationWatchImplementation;
  onChange(change: ResourceWatchChange): void;
  onError(): void;
  fingerprintProject(cwd: string): Promise<SkillScopeFingerprint>;
}

export interface ProjectWatchRegistration {
  readonly cwd: string;
  release(): Promise<void>;
}

export interface PreparedProjectResourceChanges {
  readonly changedCwds: readonly string[];
  commit(): void;
  rollback(): void;
}

export interface ConfigurationWatcherManager {
  start(enableHome: boolean): Promise<void>;
  setHomeEnabled(enabled: boolean): Promise<void>;
  acquireProject(cwd: string): Promise<ProjectWatchRegistration>;
  prepareProjectChanges(cwds: readonly string[]): Promise<PreparedProjectResourceChanges>;
  projectSkillDescriptors(cwd: string): readonly AcceptedSkillDescriptor[] | undefined;
  close(): Promise<void>;
}

interface ConfigurationWatcher {
  on(event: string, listener: (...args: unknown[]) => void): ConfigurationWatcher;
  add(paths: string | readonly string[]): ConfigurationWatcher;
  close(): Promise<void>;
}

interface WatchInstance {
  readonly token: symbol;
  watcher?: ConfigurationWatcher;
  cancelInstallation?: () => void;
  closed?: boolean;
}

interface ProjectRecord {
  readonly cwd: string;
  readonly scope: Extract<WatchScope, { kind: "project" }>;
  instance?: WatchInstance;
  refs: number;
  baseline: SkillScopeFingerprint;
  baselineVersion: number;
}

interface PreparedProjectEntry {
  readonly cwd: string;
  readonly record: ProjectRecord;
  readonly baselineVersion: number;
  readonly fingerprint: SkillScopeFingerprint;
}

type WatchScope =
  | {
      readonly kind: "global";
      readonly anchor: string;
      readonly agentsDir: string;
      readonly skillsDir: string;
      readonly settingsPath: string;
      readonly modelsPath: string;
    }
  | {
      readonly kind: "home";
      readonly anchor: string;
      readonly dotAgentsDir: string;
      readonly skillsDir: string;
    }
  | {
      readonly kind: "project";
      readonly anchor: string;
      canonicalAnchor: string;
      readonly cwd: string;
    };

export function createConfigurationWatcherManager(dependencies: WatcherDependencies): ConfigurationWatcherManager {
  const agentDir = resolve(dependencies.agentDir);
  const homeDir = resolve(dependencies.homeDir);
  const watch = dependencies.watch ?? (chokidarWatch as unknown as ConfigurationWatchImplementation);
  const globalScope: WatchScope = {
    kind: "global",
    anchor: agentDir,
    agentsDir: join(agentDir, "agents"),
    skillsDir: join(agentDir, "skills"),
    settingsPath: join(agentDir, "settings.json"),
    modelsPath: join(agentDir, "models.json"),
  };
  const homeScope: WatchScope = {
    kind: "home",
    anchor: homeDir,
    dotAgentsDir: join(homeDir, ".agents"),
    skillsDir: join(homeDir, ".agents", "skills"),
  };

  const projects = new Map<string, ProjectRecord>();
  const projectCloseOnly = new Map<string, WatchInstance>();
  let globalInstance: WatchInstance | undefined;
  let globalCloseOnly: WatchInstance | undefined;
  let homeInstance: WatchInstance | undefined;
  let homeCloseOnly: WatchInstance | undefined;
  let homeEnabled = false;
  let started = false;
  let admissionClosed = false;
  let transitions: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  let refreshProjectAnchor: (scope: Extract<WatchScope, { kind: "project" }>, instance: WatchInstance) => Promise<void>;

  const reportError = (): void => {
    try {
      const result = dependencies.onError() as unknown;
      if (isPromiseLike(result)) void Promise.resolve(result).catch(() => {});
    } catch {
      // Monitoring diagnostics cannot become watcher lifecycle failures.
    }
  };

  const reportChange = (change: ResourceWatchChange): void => {
    try {
      const result = dependencies.onChange(change) as unknown;
      if (isPromiseLike(result)) void Promise.resolve(result).catch(reportError);
    } catch {
      reportError();
    }
  };

  const serialize = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const result = transitions.then(operation, operation);
    transitions = result.then(
      () => {},
      () => {},
    );
    return result;
  };

  const isCurrent = (scope: WatchScope, instance: WatchInstance): boolean => {
    if (admissionClosed) return false;
    if (scope.kind === "global") return globalInstance?.token === instance.token;
    if (scope.kind === "home") return homeEnabled && homeInstance?.token === instance.token;
    return projects.get(scope.cwd)?.instance?.token === instance.token;
  };

  const installWatcher = async (scope: WatchScope, instance: WatchInstance): Promise<void> => {
    if (admissionClosed) throw new WatcherManagerClosingError();
    let readySettled = false;
    let waitingForExactAnchor = false;
    let settleReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolveReady, rejectWatcherReady) => {
      settleReady = () => {
        if (readySettled) return;
        readySettled = true;
        resolveReady();
      };
      rejectReady = (error) => {
        if (readySettled) return;
        readySettled = true;
        rejectWatcherReady(error);
      };
    });
    const cancelInstallation = (): void => rejectReady(new WatcherManagerClosingError());
    instance.cancelInstallation = cancelInstallation;

    try {
      const watcher = watch(initialWatchAnchors(scope), watcherOptions(scope)) as ConfigurationWatcher;
      instance.watcher = watcher;
      const synchronizePath = (event: (typeof WATCH_EVENTS)[number], candidate: unknown): void => {
        const path = resolve(String(candidate));
        if (scope.kind === "project" && path === scope.anchor && waitingForExactAnchor) {
          waitingForExactAnchor = false;
          if (event === "unlink" || event === "unlinkDir") {
            rejectReady(new ProjectAnchorUnavailableError());
          } else {
            settleReady();
          }
          return;
        }
        if (!isCurrent(scope, instance)) return;
        if (scope.kind === "project" && path === scope.anchor) {
          void serialize(() => refreshProjectAnchor(scope, instance)).catch(() => {});
          return;
        }
        const change = classifyPath(scope, path);
        if (change) reportChange(change);
      };
      for (const event of WATCH_EVENTS) watcher.on(event, (candidate) => synchronizePath(event, candidate));
      watcher.on("ready", () => {
        if (readySettled) return;
        if (scope.kind !== "project" || scope.canonicalAnchor === scope.anchor) {
          settleReady();
          return;
        }
        waitingForExactAnchor = true;
        watcher.add(scope.anchor);
      });
      watcher.on("error", (error) => {
        if (isCurrent(scope, instance)) reportError();
        rejectReady(error);
      });
    } catch (error) {
      reportError();
      rejectReady(error);
    }
    try {
      await ready;
    } finally {
      if (instance.cancelInstallation === cancelInstallation) instance.cancelInstallation = undefined;
    }
  };

  const closeInstance = async (instance: WatchInstance | undefined): Promise<void> => {
    if (!instance || instance.closed) return;
    await instance?.watcher?.close();
    instance.closed = true;
  };

  const cancelInstallation = (instance: WatchInstance | undefined): void => {
    instance?.cancelInstallation?.();
  };

  const closeGlobalOnly = async (): Promise<void> => {
    const instance = globalCloseOnly;
    if (!instance) return;
    try {
      await closeInstance(instance);
      if (globalCloseOnly === instance) globalCloseOnly = undefined;
    } catch (error) {
      reportError();
      throw error;
    }
  };

  const closeHomeOnly = async (): Promise<void> => {
    const instance = homeCloseOnly;
    if (!instance) return;
    try {
      await closeInstance(instance);
      if (homeCloseOnly === instance) homeCloseOnly = undefined;
    } catch (error) {
      reportError();
      throw error;
    }
  };

  const closeProjectOnly = async (cwd: string): Promise<void> => {
    const instance = projectCloseOnly.get(cwd);
    if (!instance) return;
    try {
      await closeInstance(instance);
      if (projectCloseOnly.get(cwd) === instance) projectCloseOnly.delete(cwd);
    } catch (error) {
      reportError();
      throw error;
    }
  };

  const abandonProjectRecord = async (record: ProjectRecord): Promise<void> => {
    if (projects.get(record.cwd) !== record) return;
    projects.delete(record.cwd);
    const instance = record.instance;
    record.instance = undefined;
    if (instance) projectCloseOnly.set(record.cwd, instance);
    try {
      await closeProjectOnly(record.cwd);
    } catch {
      // The close-only owner remains available to a later acquire, release, or shutdown retry.
    }
  };

  const installStableProjectWatcher = async (
    scope: Extract<WatchScope, { kind: "project" }>,
    record: ProjectRecord,
    firstInstance: WatchInstance,
  ): Promise<void> => {
    let instance = firstInstance;
    for (let attempt = 0; attempt < PROJECT_INSTALL_ATTEMPTS; attempt += 1) {
      if (admissionClosed) throw new WatcherManagerClosingError();
      record.instance = instance;
      await installWatcher(scope, instance);
      if (admissionClosed) throw new WatcherManagerClosingError();

      let confirmedAnchor: string;
      try {
        confirmedAnchor = await projectCanonicalAnchor(scope.cwd);
      } catch (error) {
        if (isMissingPathError(error)) throw new ProjectAnchorUnavailableError();
        throw error;
      }
      if (admissionClosed) throw new WatcherManagerClosingError();
      if (confirmedAnchor === scope.canonicalAnchor) return;

      await closeInstance(instance);
      if (attempt + 1 >= PROJECT_INSTALL_ATTEMPTS) {
        reportError();
        throw new Error("Project watcher target changed repeatedly during installation.");
      }
      scope.canonicalAnchor = confirmedAnchor;
      instance = { token: Symbol(`project-resource-watcher:${scope.cwd}`) };
    }
  };

  const degradeProjectWatcher = async (record: ProjectRecord, instance: WatchInstance): Promise<void> => {
    if (projects.get(record.cwd) !== record) return;
    if (record.instance?.token === instance.token) record.instance = undefined;
    projectCloseOnly.set(record.cwd, instance);
    try {
      await closeProjectOnly(record.cwd);
    } catch {
      // Failed physical ownership remains in the close-only map for the next retry.
    }
  };

  const retryProjectWatcher = async (record: ProjectRecord, required: boolean): Promise<boolean> => {
    if (record.instance) return true;
    try {
      await closeProjectOnly(record.cwd);
      if (admissionClosed) throw new WatcherManagerClosingError();
      record.scope.canonicalAnchor = await projectCanonicalAnchor(record.cwd);
      const replacement: WatchInstance = { token: Symbol(`project-resource-watcher:${record.cwd}`) };
      record.instance = replacement;
      try {
        await installStableProjectWatcher(record.scope, record, replacement);
        return true;
      } catch (error) {
        if (error instanceof ProjectAnchorUnavailableError) return true;
        await degradeProjectWatcher(record, replacement);
        throw error;
      }
    } catch (error) {
      if (required) throw error;
      return false;
    }
  };

  refreshProjectAnchor = async (scope, instance): Promise<void> => {
    if (admissionClosed) return;
    const record = projects.get(scope.cwd);
    if (!record || record.instance?.token !== instance.token) return;

    let canonicalAnchor: string;
    try {
      canonicalAnchor = await projectCanonicalAnchor(scope.cwd);
    } catch {
      reportChange({ skillsChanged: true, projectCwds: [scope.cwd] });
      return;
    }
    if (canonicalAnchor === scope.canonicalAnchor) {
      reportChange({ skillsChanged: true, projectCwds: [scope.cwd] });
      return;
    }

    try {
      await closeInstance(instance);
    } catch {
      reportError();
      return;
    }

    if (record.instance?.token === instance.token) record.instance = undefined;

    const replacement: WatchInstance = { token: Symbol(`project-resource-watcher:${scope.cwd}`) };
    record.instance = replacement;
    scope.canonicalAnchor = canonicalAnchor;
    try {
      await installStableProjectWatcher(scope, record, replacement);
      if (projects.get(scope.cwd) === record) {
        reportChange({ skillsChanged: true, projectCwds: [scope.cwd] });
      }
    } catch (error) {
      if (error instanceof ProjectAnchorUnavailableError) {
        if (projects.get(scope.cwd) === record) {
          reportChange({ skillsChanged: true, projectCwds: [scope.cwd] });
        }
        return;
      }
      await degradeProjectWatcher(record, replacement);
      if (projects.get(scope.cwd) === record) {
        reportChange({ skillsChanged: true, projectCwds: [scope.cwd] });
      }
    }
  };

  const setHomeEnabledInternal = async (enabled: boolean): Promise<void> => {
    await closeHomeOnly();

    if (enabled) {
      if (homeEnabled && homeInstance) return;
      homeEnabled = true;
      const instance: WatchInstance = { token: Symbol("home-resource-watcher") };
      homeInstance = instance;
      try {
        await installWatcher(homeScope, instance);
      } catch (error) {
        homeEnabled = false;
        if (homeInstance?.token === instance.token) homeInstance = undefined;
        homeCloseOnly = instance;
        try {
          await closeHomeOnly();
        } catch {
          // The close-only owner remains available to a later policy or shutdown retry.
        }
        throw error;
      }
      return;
    }

    homeEnabled = false;
    const instance = homeInstance;
    homeInstance = undefined;
    if (!instance) return;
    homeCloseOnly = instance;
    try {
      await closeInstance(instance);
      if (homeCloseOnly === instance) homeCloseOnly = undefined;
    } catch (error) {
      reportError();
      throw error;
    }
  };

  const releaseProjectRecord = async (record: ProjectRecord): Promise<void> => {
    if (projects.get(record.cwd) !== record) {
      await closeProjectOnly(record.cwd);
      return;
    }
    record.refs -= 1;
    if (record.refs > 0) return;

    projects.delete(record.cwd);
    const instance = record.instance;
    record.instance = undefined;
    if (instance) projectCloseOnly.set(record.cwd, instance);
    await closeProjectOnly(record.cwd);
  };

  const registrationFor = (record: ProjectRecord): ProjectWatchRegistration => {
    let refReleased = false;
    let releasePromise: Promise<void> | undefined;
    return {
      cwd: record.cwd,
      release() {
        if (releasePromise) return releasePromise;
        const attempt = serialize(async () => {
          if (!refReleased) {
            refReleased = true;
            await releaseProjectRecord(record);
            return;
          }
          await closeProjectOnly(record.cwd);
        });
        releasePromise = attempt;
        void attempt.catch(() => {
          if (releasePromise === attempt) releasePromise = undefined;
        });
        return attempt;
      },
    };
  };

  const acquireProjectInternal = async (cwd: string): Promise<ProjectWatchRegistration> => {
    await closeProjectOnly(cwd);
    const existing = projects.get(cwd);
    if (existing) {
      await retryProjectWatcher(existing, true);
      existing.refs += 1;
      return registrationFor(existing);
    }

    const watchTarget = await projectCanonicalAnchor(cwd);
    const instance: WatchInstance = { token: Symbol(`project-resource-watcher:${cwd}`) };
    const scope: Extract<WatchScope, { kind: "project" }> = {
      kind: "project",
      anchor: cwd,
      canonicalAnchor: watchTarget,
      cwd,
    };
    const record: ProjectRecord = {
      cwd,
      scope,
      instance,
      refs: 1,
      baseline: { value: "", descriptors: [], skillDescriptors: [] },
      baselineVersion: 0,
    };
    projects.set(cwd, record);
    try {
      await installStableProjectWatcher(scope, record, instance);
      if (admissionClosed) throw new WatcherManagerClosingError();
      record.baseline = await dependencies.fingerprintProject(cwd);
      return registrationFor(record);
    } catch (error) {
      await abandonProjectRecord(record);
      throw error;
    }
  };

  const prepareProjectChangesInternal = async (cwds: readonly string[]): Promise<PreparedProjectResourceChanges> => {
    const entries: PreparedProjectEntry[] = [];
    const changedCwds: string[] = [];
    for (const cwd of uniqueNormalizedPaths(cwds)) {
      const record = projects.get(cwd);
      if (!record) continue;
      await retryProjectWatcher(record, false);
      const fingerprint = await dependencies.fingerprintProject(cwd);
      entries.push({
        cwd,
        record,
        baselineVersion: record.baselineVersion,
        fingerprint,
      });
      if (fingerprint.value !== record.baseline.value) changedCwds.push(cwd);
    }

    let settled = false;
    return {
      changedCwds,
      commit() {
        if (settled) return;
        settled = true;
        for (const entry of entries) {
          const current = projects.get(entry.cwd);
          if (current !== entry.record || current.baselineVersion !== entry.baselineVersion) continue;
          current.baseline = entry.fingerprint;
          current.baselineVersion += 1;
        }
      },
      rollback() {
        settled = true;
      },
    };
  };

  const closeAll = async (): Promise<void> => {
    if (globalInstance) {
      globalCloseOnly = globalInstance;
      globalInstance = undefined;
    }
    homeEnabled = false;
    if (homeInstance) {
      homeCloseOnly = homeInstance;
      homeInstance = undefined;
    }
    for (const [cwd, record] of projects) {
      projects.delete(cwd);
      const instance = record.instance;
      record.instance = undefined;
      if (instance) projectCloseOnly.set(cwd, instance);
    }

    const failures: unknown[] = [];
    if (globalCloseOnly) {
      const instance = globalCloseOnly;
      try {
        await closeInstance(instance);
        if (globalCloseOnly === instance) globalCloseOnly = undefined;
      } catch (error) {
        failures.push(error);
        reportError();
      }
    }
    if (homeCloseOnly) {
      const instance = homeCloseOnly;
      try {
        await closeInstance(instance);
        if (homeCloseOnly === instance) homeCloseOnly = undefined;
      } catch (error) {
        failures.push(error);
        reportError();
      }
    }
    for (const [cwd, instance] of [...projectCloseOnly]) {
      try {
        await closeInstance(instance);
        if (projectCloseOnly.get(cwd) === instance) projectCloseOnly.delete(cwd);
      } catch (error) {
        failures.push(error);
        reportError();
      }
    }
    if (failures.length > 0) throw new Error("Configuration watcher manager could not close safely.");
  };

  return {
    start(enableHome) {
      if (admissionClosed) return Promise.reject(new Error("Configuration watcher manager is closing."));
      return serialize(async () => {
        if (!started) {
          await closeGlobalOnly();
          const instance: WatchInstance = { token: Symbol("global-resource-watcher") };
          globalInstance = instance;
          try {
            await installWatcher(globalScope, instance);
            started = true;
          } catch (error) {
            if (globalInstance?.token === instance.token) globalInstance = undefined;
            globalCloseOnly = instance;
            try {
              await closeGlobalOnly();
            } catch {
              // The close-only owner remains available to a later start or shutdown retry.
            }
            throw error;
          }
        }
        await setHomeEnabledInternal(enableHome);
      });
    },
    setHomeEnabled(enabled) {
      if (admissionClosed) return Promise.reject(new Error("Configuration watcher manager is closing."));
      return serialize(() => setHomeEnabledInternal(enabled));
    },
    acquireProject(cwd) {
      if (admissionClosed) return Promise.reject(new Error("Configuration watcher manager is closing."));
      const normalizedCwd = resolve(cwd);
      return serialize(() => acquireProjectInternal(normalizedCwd));
    },
    prepareProjectChanges(cwds) {
      if (admissionClosed) return Promise.reject(new Error("Configuration watcher manager is closing."));
      return serialize(() => prepareProjectChangesInternal(cwds));
    },
    projectSkillDescriptors(cwd) {
      const descriptors = projects.get(resolve(cwd))?.baseline.skillDescriptors;
      return descriptors?.map((descriptor) => ({ ...descriptor }));
    },
    close() {
      if (closePromise) return closePromise;
      admissionClosed = true;
      cancelInstallation(globalInstance);
      cancelInstallation(homeInstance);
      for (const record of projects.values()) cancelInstallation(record.instance);
      const attempt = serialize(closeAll);
      closePromise = attempt;
      void attempt.catch(() => {
        if (closePromise === attempt) closePromise = undefined;
      });
      return attempt;
    },
  };
}

class WatcherManagerClosingError extends Error {
  constructor() {
    super("Configuration watcher manager is closing.");
    this.name = "WatcherManagerClosingError";
  }
}

class ProjectAnchorUnavailableError extends Error {
  constructor() {
    super("Project watcher exact anchor is temporarily unavailable.");
    this.name = "ProjectAnchorUnavailableError";
  }
}

function watcherOptions(scope: WatchScope): ChokidarOptions {
  return {
    ignoreInitial: true,
    depth: WATCH_DEPTH,
    followSymlinks: false,
    atomic: true,
    ignored: (candidate) => !isAllowedPath(scope, resolve(String(candidate))),
    awaitWriteFinish: {
      stabilityThreshold: STABILITY_THRESHOLD_MS,
      pollInterval: 50,
    },
  };
}

function watchAnchors(scope: WatchScope): string[] {
  if (scope.kind !== "project" || scope.canonicalAnchor === scope.anchor) return [scope.anchor];
  return [scope.anchor, scope.canonicalAnchor];
}

function initialWatchAnchors(scope: WatchScope): string[] {
  if (scope.kind !== "project" || scope.canonicalAnchor === scope.anchor) return [scope.anchor];
  return [scope.canonicalAnchor];
}

async function projectCanonicalAnchor(cwd: string): Promise<string> {
  return (await lstat(cwd)).isSymbolicLink() ? realpath(cwd) : cwd;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAllowedPath(scope: WatchScope, path: string): boolean {
  if (scope.kind === "project") {
    for (const anchor of watchAnchors(scope)) {
      const configurationDir = join(anchor, ".easyresearch");
      const skillsDir = join(configurationDir, "skills");
      if (path === anchor || path === configurationDir || path === skillsDir || isWithin(skillsDir, path)) return true;
    }
    return false;
  }
  if (path === scope.anchor) return true;
  if (!isWithin(scope.anchor, path)) return false;
  if (scope.kind === "global") {
    return (
      path === scope.settingsPath ||
      path === scope.modelsPath ||
      path === scope.agentsDir ||
      isDirectMarkdown(path, scope.agentsDir) ||
      path === scope.skillsDir ||
      isWithin(scope.skillsDir, path)
    );
  }
  if (scope.kind === "home") {
    return path === scope.dotAgentsDir || path === scope.skillsDir || isWithin(scope.skillsDir, path);
  }
  return false;
}

function classifyPath(scope: WatchScope, path: string): ResourceWatchChange | undefined {
  if (!isAllowedPath(scope, path) || path === scope.anchor) return undefined;
  if (scope.kind === "global") {
    if (path === scope.settingsPath) return {};
    if (path === scope.modelsPath) return { modelsChanged: true };
    if (path === scope.agentsDir || isDirectMarkdown(path, scope.agentsDir)) return { agentsChanged: true };
    if (path === scope.skillsDir || isWithin(scope.skillsDir, path)) return { skillsChanged: true };
    return undefined;
  }
  if (scope.kind === "home") return { skillsChanged: true };
  return { skillsChanged: true, projectCwds: [scope.cwd] };
}

function isDirectMarkdown(path: string, directory: string): boolean {
  const child = relative(directory, path);
  return child.length > 0 && !child.includes(sep) && child.endsWith(".md");
}

function isWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function uniqueNormalizedPaths(paths: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const path of paths) normalized.add(resolve(path));
  return [...normalized];
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
