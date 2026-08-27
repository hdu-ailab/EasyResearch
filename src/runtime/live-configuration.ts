import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ChokidarOptions } from "chokidar";
import { readGlobalAgentDefaults } from "../subagent/agent-defaults";
import {
  type AgentCatalogSnapshot,
  type AgentConfig,
  type AgentDiscoveryResult,
  type DiscoveryOptions,
  loadAgentCatalog,
  RESEARCH_ASSISTANT_AGENT,
  resolveAgentCatalog,
} from "../subagent/agents";
import { isDotAgentsSkillEnabled } from "../subagent/skill-resolution";
import type {
  ApiUsageSettingsDto,
  ConfigurationErrorEvent,
  ConfigurationEvent,
  ConfigurationUpdatedEvent,
} from "../web/contracts";
import { parseGlobalApiUsageSettings } from "./api-usage-settings";
import {
  type GlobalCompactionPolicy,
  parseGlobalCompactionPolicy,
} from "./compaction-policy";
import {
  type ConfigurationWatcherManager,
  createConfigurationWatcherManager,
  type PreparedProjectResourceChanges,
  type ProjectWatchRegistration,
  type WatcherDependencies,
} from "./configuration-watchers";
import { getAgentDir } from "./pi-import";
import {
  fingerprintGlobalSkillResources,
  fingerprintSkillRoot,
  type AcceptedSkillDescriptor,
} from "./resource-fingerprint";

export type { ConfigurationErrorEvent, ConfigurationEvent, ConfigurationUpdatedEvent } from "../web/contracts";

const SAFE_CONFIGURATION_ERROR =
  "Configuration validation failed. Fix the global Agent or model configuration and retry.";
const SAFE_CONFIGURATION_UNAVAILABLE =
  "No valid configuration is available. Fix the global Agent or model configuration and retry.";
const SAFE_WATCHER_ERROR = "Configuration monitoring failed. Refresh to check for updates.";

export interface ConfigurationFingerprint {
  value: string;
  agents: string;
  models: string;
  agentDefaults?: string;
  compaction: string;
  compactionPolicy: GlobalCompactionPolicy;
  apiUsage: string;
  apiUsageSettings: ApiUsageSettingsDto;
  globalSkills: string;
  homeSkills: string | null;
  globalSkillDescriptors: readonly AcceptedSkillDescriptor[];
  homeSkillDescriptors: readonly AcceptedSkillDescriptor[] | null;
}

export interface ModelCatalogEntry {
  provider: string;
  id: string;
}

export interface PreparedModelCatalog {
  readonly models: readonly ModelCatalogEntry[];
  /**
   * Atomically replace accepted model state. This must be synchronous and must
   * leave accepted state untouched if it throws.
   */
  commit(): void;
  /** Discard isolated candidate state without reading or replacing accepted state. */
  rollback(): void | Promise<void>;
}

export interface ModelCatalogValidator {
  /** Preparation must not mutate model state visible to runtime consumers. */
  prepareModelCatalog(): Promise<PreparedModelCatalog>;
}

export type ConfigurationWatchImplementation = (
  paths: string[],
  options: ChokidarOptions,
) => {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  close(): Promise<void>;
};

export interface ConfigurationChange {
  agentsChanged?: boolean;
  modelsChanged?: boolean;
  skillsChanged?: boolean;
  projectCwds?: readonly string[];
  force?: boolean;
}

export interface SkillResolutionPolicy {
  enableDotAgentsSkill: boolean;
}

export interface LiveConfigurationOptions {
  agentDir?: string;
  catalogOptions?: Omit<DiscoveryOptions, "agentDir" | "cwd">;
  modelValidator: ModelCatalogValidator;
  fingerprint?: (agentDir: string) => Promise<ConfigurationFingerprint>;
  loadCatalog?: (options: DiscoveryOptions) => Promise<AgentCatalogSnapshot>;
  resolveCatalog?: (
    snapshot: AgentCatalogSnapshot,
    options: DiscoveryOptions,
  ) => AgentDiscoveryResult;
  watch?: ConfigurationWatchImplementation;
  createWatcherManager?: (dependencies: WatcherDependencies) => ConfigurationWatcherManager;
}

export interface LiveConfiguration {
  readonly generation: number;
  readonly error: string | null;
  readonly compactionPolicy: GlobalCompactionPolicy;
  readonly apiUsageSettings: ApiUsageSettingsDto;
  readonly skillPolicy: SkillResolutionPolicy;
  start(): Promise<void>;
  synchronize(options?: { projectCwds?: readonly string[] }): Promise<void>;
  acquireProject(cwd: string): Promise<ProjectWatchRegistration>;
  /** True only for the latest validation-clean accepted generation. */
  isCurrent(generation: number): boolean;
  notify(change: ConfigurationChange): Promise<void>;
  resolveAgents(cwd?: string): Promise<AgentConfig[]>;
  subscribe(listener: (event: ConfigurationEvent) => void): () => void;
  close(): Promise<void>;
}

export class ConfigurationUnavailableError extends Error {
  constructor() {
    super(SAFE_CONFIGURATION_UNAVAILABLE);
    this.name = "ConfigurationUnavailableError";
  }
}

interface PendingSynchronization {
  agentsChanged: boolean;
  modelsChanged: boolean;
  skillsChanged: boolean;
  projectCwds: Set<string>;
  force: boolean;
  waiters: Array<() => void>;
}

interface SynchronizationRequest {
  agentsChanged: boolean;
  modelsChanged: boolean;
  skillsChanged: boolean;
  projectCwds: readonly string[];
  force: boolean;
}

type SynchronizationOutcome = "committed" | "unchanged" | "failed" | "closed";

export function createLiveConfiguration(options: LiveConfigurationOptions): LiveConfiguration {
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const catalogOptions = { ...options.catalogOptions };
  const homeDir = resolve(catalogOptions.homeDir ?? homedir());
  const readFingerprint = options.fingerprint ?? ((path) => fingerprintConfiguration(path, homeDir));
  const loadCatalog = options.loadCatalog ?? ((discovery) => loadAgentCatalog(discovery));
  const resolveCatalog = options.resolveCatalog ?? resolveAgentCatalog;
  const createWatcherManager = options.createWatcherManager ?? createConfigurationWatcherManager;
  const listeners = new Set<(event: ConfigurationEvent) => void>();

  let currentGeneration = 0;
  let validationError: string | null = null;
  let watcherError: string | null = null;
  let currentCatalog: AgentCatalogSnapshot | undefined;
  let currentFingerprint: ConfigurationFingerprint | undefined;
  let currentCompactionPolicy = parseGlobalCompactionPolicy({});
  let currentApiUsageSettings = parseGlobalApiUsageSettings({});
  let watcherManager: ConfigurationWatcherManager;
  let watcherManagerAdmissionStarted = false;
  let watcherManagerStarted = false;
  let watcherManagerClosed = false;
  let watchedHomeEnabled = false;
  let startPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let pending: PendingSynchronization | undefined;
  let drainScheduled = false;
  let draining = false;
  let drainPromise: Promise<void> | undefined;
  let failedAgentsChanged = false;
  let failedModelsChanged = false;
  let failedSkillsChanged = false;
  const failedProjectCwds = new Set<string>();
  let closed = false;

  const publish = (event: ConfigurationEvent): void => {
    for (const listener of [...listeners]) {
      try {
        const result = listener({ ...event }) as unknown;
        if (isPromiseLike(result)) void Promise.resolve(result).catch(() => {});
      } catch {
        // A subscriber is an observer, never part of configuration state.
      }
    }
  };

  const emitError = (message: string): void => {
    if (closed) return;
    const event: ConfigurationErrorEvent = {
      type: "config.error",
      generation: currentGeneration,
      message,
    };
    publish(event);
  };

  const publishValidationError = (): void => {
    if (closed || validationError === SAFE_CONFIGURATION_ERROR) return;
    validationError = SAFE_CONFIGURATION_ERROR;
    emitError(SAFE_CONFIGURATION_ERROR);
  };

  const publishWatcherError = (): void => {
    if (closed || watcherError === SAFE_WATCHER_ERROR) return;
    watcherError = SAFE_WATCHER_ERROR;
    emitError(SAFE_WATCHER_ERROR);
  };

  const skillPolicyFor = (fingerprint: ConfigurationFingerprint | undefined): SkillResolutionPolicy => ({
    enableDotAgentsSkill: fingerprint?.homeSkills !== null && fingerprint !== undefined,
  });
  const acceptedSkillPolicy = (): SkillResolutionPolicy => skillPolicyFor(currentFingerprint);

  const alignHomeWatcher = async (): Promise<void> => {
    if (!watcherManagerAdmissionStarted || closed) return;
    const enabled = acceptedSkillPolicy().enableDotAgentsSkill;
    try {
      if (!watcherManagerStarted) {
        await watcherManager.start(enabled);
        watcherManagerStarted = true;
      } else {
        if (enabled === watchedHomeEnabled) return;
        await watcherManager.setHomeEnabled(enabled);
      }
      if (closed) return;
      watchedHomeEnabled = enabled;
    } catch {
      publishWatcherError();
      return;
    }

    let confirmed: ConfigurationFingerprint;
    try {
      confirmed = await readFingerprint(agentDir);
    } catch {
      publishValidationError();
      return;
    }
    if (!closed && currentFingerprint !== undefined && !sameFingerprint(confirmed, currentFingerprint)) {
      void requestSynchronization({});
    }
  };

  const validateAndAdvance = async (change: SynchronizationRequest): Promise<SynchronizationOutcome> => {
    let requiresRuntimeAlignment = false;
    for (;;) {
      let preparedProjects: PreparedProjectResourceChanges | undefined;
      let preparedModels: PreparedModelCatalog | undefined;
      const rollbackPreparedProjects = (): void => {
        const candidateProjects = preparedProjects;
        preparedProjects = undefined;
        candidateProjects?.rollback();
      };
      const rollbackPreparedModels = async (): Promise<void> => {
        const candidateModels = preparedModels;
        preparedModels = undefined;
        await candidateModels?.rollback();
      };
      try {
        preparedProjects = await watcherManager.prepareProjectChanges(change.projectCwds);
        if (closed) {
          rollbackPreparedProjects();
          return "closed";
        }
        const candidate = await readFingerprint(agentDir);
        if (closed) {
          rollbackPreparedProjects();
          return "closed";
        }
        const projectSkillsChanged = preparedProjects.changedCwds.length > 0;
        const shouldCommit =
          change.force ||
          validationError !== null ||
          currentCatalog === undefined ||
          currentFingerprint === undefined ||
          projectSkillsChanged ||
          !sameFingerprint(candidate, currentFingerprint);
        if (!shouldCommit && !requiresRuntimeAlignment) {
          rollbackPreparedProjects();
          await alignHomeWatcher();
          return "unchanged";
        }

        const nextCatalog = await loadCatalog({
          ...catalogOptions,
          agentDir,
          cwd: undefined,
          enableDotAgentsSkill: skillPolicyFor(candidate).enableDotAgentsSkill,
        });
        assertValidCatalog(nextCatalog);
        if (closed) {
          rollbackPreparedProjects();
          return "closed";
        }
        preparedModels = await options.modelValidator.prepareModelCatalog();
        assertConfiguredModelsAvailable(nextCatalog, preparedModels.models);
        if (closed) {
          await rollbackPreparedModels();
          rollbackPreparedProjects();
          return "closed";
        }

        const confirmed = await readFingerprint(agentDir);
        if (!sameFingerprint(candidate, confirmed)) {
          await rollbackPreparedModels();
          rollbackPreparedProjects();
          requiresRuntimeAlignment = true;
          continue;
        }
        if (closed) {
          await rollbackPreparedModels();
          rollbackPreparedProjects();
          return "closed";
        }
        if (!shouldCommit) {
          await rollbackPreparedModels();
          rollbackPreparedProjects();
          return "unchanged";
        }

        const agentsChanged =
          change.agentsChanged ||
          failedAgentsChanged ||
          currentFingerprint === undefined ||
          candidate.agents !== currentFingerprint.agents ||
          candidate.agentDefaults !== currentFingerprint.agentDefaults;
        const modelsChanged =
          change.modelsChanged ||
          currentFingerprint === undefined ||
          candidate.models !== currentFingerprint.models;
        const skillsChanged = change.skillsChanged ||
          currentFingerprint === undefined ||
          projectSkillsChanged ||
          candidate.globalSkills !== currentFingerprint.globalSkills ||
          candidate.homeSkills !== currentFingerprint.homeSkills;
        const apiUsageChanged = currentFingerprint !== undefined
          && candidate.apiUsage !== currentFingerprint.apiUsage;
        const runtimeChanged = agentsChanged
          || modelsChanged
          || skillsChanged
          || currentFingerprint === undefined
          || candidate.compaction !== currentFingerprint.compaction;
        const event: ConfigurationUpdatedEvent = {
          type: "config.updated",
          generation: currentGeneration + 1,
          agentsChanged,
          modelsChanged,
          skillsChanged,
          runtimeChanged,
          ...(apiUsageChanged ? { apiUsageChanged: true } : {}),
        };

        preparedModels.commit();
        preparedModels = undefined;
        preparedProjects.commit();
        preparedProjects = undefined;
        currentCatalog = nextCatalog;
        currentFingerprint = candidate;
        currentCompactionPolicy = candidate.compactionPolicy;
        currentApiUsageSettings = candidate.apiUsageSettings;
        currentGeneration = event.generation;
        validationError = null;
        failedAgentsChanged = false;
        failedModelsChanged = false;
        failedSkillsChanged = false;
        failedProjectCwds.clear();
        publish(event);
        if (watcherError) emitError(watcherError);
        await alignHomeWatcher();
        return "committed";
      } catch {
        try {
          await rollbackPreparedModels();
        } catch {
          // The candidate is isolated, so disposal failure cannot replace accepted state.
        }
        try {
          rollbackPreparedProjects();
        } catch {
          // Project candidate disposal cannot replace accepted baselines.
        }
        if (closed) return "closed";
        publishValidationError();
        return "failed";
      }
    }
  };

  const settlePending = (): void => {
    const batch = pending;
    pending = undefined;
    for (const resolveWaiter of batch?.waiters ?? []) resolveWaiter();
  };

  const drain = async (): Promise<void> => {
    draining = true;
    try {
      while (!closed && pending) {
        const batch = pending;
        pending = undefined;
        const request: SynchronizationRequest = {
          agentsChanged: batch.agentsChanged || failedAgentsChanged,
          modelsChanged: batch.modelsChanged || failedModelsChanged,
          skillsChanged: batch.skillsChanged || failedSkillsChanged,
          projectCwds: [...new Set([...failedProjectCwds, ...batch.projectCwds])],
          force: batch.force,
        };
        let outcome: SynchronizationOutcome = "closed";
        try {
          outcome = await validateAndAdvance(request);
        } catch {
          publishValidationError();
          outcome = "failed";
        } finally {
          if (outcome === "failed") {
            failedAgentsChanged ||= batch.agentsChanged;
            failedModelsChanged ||= batch.modelsChanged;
            failedSkillsChanged ||= batch.skillsChanged;
            for (const cwd of batch.projectCwds) failedProjectCwds.add(cwd);
          }
          for (const resolveWaiter of batch.waiters) resolveWaiter();
        }
      }
    } finally {
      draining = false;
      if (closed) settlePending();
    }
  };

  const scheduleDrain = (): void => {
    if (closed || drainScheduled || draining) return;
    drainScheduled = true;
    queueMicrotask(() => {
      drainScheduled = false;
      if (closed) {
        settlePending();
        return;
      }
      drainPromise = drain().finally(() => {
        drainPromise = undefined;
        if (pending) scheduleDrain();
      });
    });
  };

  const requestSynchronization = (change: ConfigurationChange): Promise<void> => {
    if (closed) return Promise.resolve();
    return new Promise<void>((resolveWaiter) => {
      pending ??= {
        agentsChanged: false,
        modelsChanged: false,
        skillsChanged: false,
        projectCwds: new Set<string>(),
        force: false,
        waiters: [],
      };
      pending.agentsChanged ||= change.agentsChanged === true;
      pending.modelsChanged ||= change.modelsChanged === true;
      pending.skillsChanged ||= change.skillsChanged === true;
      for (const cwd of change.projectCwds ?? []) pending.projectCwds.add(cwd);
      pending.force ||= change.force === true;
      pending.waiters.push(resolveWaiter);
      scheduleDrain();
    });
  };

  watcherManager = createWatcherManager({
    agentDir,
    homeDir,
    watch: options.watch,
    onChange(change) {
      if (closed) return;
      void requestSynchronization(change);
    },
    onError() {
      publishWatcherError();
    },
    fingerprintProject(cwd) {
      return fingerprintSkillRoot(join(cwd, ".easyresearch", "skills"), `project:${cwd}`);
    },
  });

  return {
    get generation() {
      return currentGeneration;
    },
    get error() {
      return validationError ?? watcherError;
    },
    get compactionPolicy() {
      return { ...currentCompactionPolicy };
    },
    get apiUsageSettings() {
      return { ...currentApiUsageSettings };
    },
    get skillPolicy() {
      return acceptedSkillPolicy();
    },
    start() {
      if (closed) return Promise.resolve();
      startPromise ??= (async () => {
        await requestSynchronization({});
        if (closed) return;
        watcherManagerAdmissionStarted = true;
        await alignHomeWatcher();
        if (closed) return;
        await requestSynchronization({});
      })();
      return startPromise;
    },
    synchronize(options = {}) {
      return requestSynchronization({ projectCwds: options.projectCwds });
    },
    async acquireProject(cwd) {
      if (closed) throw new Error(SAFE_WATCHER_ERROR);
      let registration: ProjectWatchRegistration;
      try {
        registration = await watcherManager.acquireProject(cwd);
      } catch {
        publishWatcherError();
        throw new Error(SAFE_WATCHER_ERROR);
      }
      if (!closed) return registration;
      try {
        await registration.release();
      } catch {
        // The caller cannot safely own a registration after closure even when cleanup fails.
      }
      throw new Error(SAFE_WATCHER_ERROR);
    },
    isCurrent(generation) {
      return (
        !closed &&
        validationError === null &&
        currentCatalog !== undefined &&
        currentFingerprint !== undefined &&
        generation === currentGeneration
      );
    },
    notify(change) {
      return requestSynchronization(change);
    },
    async resolveAgents(cwd) {
      const snapshot = currentCatalog;
      const projectSkillDescriptors = cwd === undefined
        ? undefined
        : watcherManager.projectSkillDescriptors(cwd);
      if (currentGeneration === 0 || snapshot === undefined) {
        throw new ConfigurationUnavailableError();
      }
      try {
        return resolveCatalog(snapshot, {
          ...catalogOptions,
          agentDir,
          cwd,
          enableDotAgentsSkill: acceptedSkillPolicy().enableDotAgentsSkill,
          acceptedSkillDescriptors: {
            global: currentFingerprint!.globalSkillDescriptors,
            home: currentFingerprint!.homeSkillDescriptors,
            ...(projectSkillDescriptors === undefined
              ? {}
              : { project: projectSkillDescriptors }),
          },
        }).agents;
      } catch {
        throw new Error("Agent configuration could not be resolved.");
      }
    },
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      if (closePromise) return closePromise;
      const attempt = (async () => {
        closed = true;
        listeners.clear();
        settlePending();
        const failures: unknown[] = [];
        if (!watcherManagerClosed) {
          try {
            await watcherManager.close();
            watcherManagerClosed = true;
          } catch (error) {
            failures.push(error);
          }
        }
        try {
          await drainPromise;
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new Error("Configuration monitoring could not close safely.");
        }
      })();
      closePromise = attempt;
      void attempt.catch(() => {
        if (closePromise === attempt) closePromise = undefined;
      });
      return attempt;
    },
  };
}

export async function fingerprintConfiguration(
  agentDir: string,
  homeDir: string = homedir(),
): Promise<ConfigurationFingerprint> {
  const settingsBytes = await readOptionalFile(join(agentDir, "settings.json"));
  let settings: unknown = {};
  if (settingsBytes !== undefined) settings = JSON.parse(settingsBytes.toString("utf8")) as unknown;
  const enableDotAgentsSkill = isDotAgentsSkillEnabled(settings);
  const compactionPolicy = parseGlobalCompactionPolicy(settings);
  const apiUsageSettings = parseGlobalApiUsageSettings(settings);

  const agentsDir = join(agentDir, "agents");
  const names = (await readDirectoryOrEmpty(agentsDir))
    .filter((name) => name.endsWith(".md"))
    .sort(compareNames);
  const agentsHash = createHash("sha256");
  agentsHash.update("easyresearch-agents-v1\0");
  for (const name of names) {
    const bytes = await readFile(join(agentsDir, name));
    updateHashField(agentsHash, Buffer.from(name, "utf8"));
    updateHashField(agentsHash, bytes);
  }
  const agents = agentsHash.digest("hex");

  const modelsHash = createHash("sha256");
  modelsHash.update("easyresearch-models-v1\0");
  const modelsBytes = await readOptionalFile(join(agentDir, "models.json"));
  if (modelsBytes === undefined) {
    modelsHash.update("missing");
  } else {
    modelsHash.update("present");
    updateHashField(modelsHash, modelsBytes);
  }
  const models = modelsHash.digest("hex");

  const defaultsHash = createHash("sha256");
  defaultsHash.update("easyresearch-agent-defaults-v1\0");
  const defaults = await readGlobalAgentDefaults(agentDir);
  for (const [name, entry] of Object.entries(defaults).sort(([left], [right]) => compareNames(left, right))) {
    updateHashField(defaultsHash, Buffer.from(name, "utf8"));
    updateHashField(defaultsHash, Buffer.from(entry.model ?? "", "utf8"));
    updateHashField(defaultsHash, Buffer.from(entry.thinking ?? "", "utf8"));
  }
  const agentDefaults = defaultsHash.digest("hex");

  const compactionHash = createHash("sha256");
  compactionHash.update("easyresearch-compaction-v1\0");
  updateHashField(compactionHash, Buffer.from(String(compactionPolicy.triggerPercent), "utf8"));
  updateHashField(compactionHash, Buffer.from(compactionPolicy.globalEnabled ? "true" : "false", "utf8"));
  updateHashField(compactionHash, Buffer.from(String(compactionPolicy.globalKeepRecentTokens), "utf8"));
  const compaction = compactionHash.digest("hex");
  const apiUsageHash = createHash("sha256");
  apiUsageHash.update("easyresearch-api-usage-v1\0");
  updateHashField(
    apiUsageHash,
    Buffer.from(apiUsageSettings.showApiUsageDetails ? "true" : "false", "utf8"),
  );
  const apiUsage = apiUsageHash.digest("hex");
  const skillResources = await fingerprintGlobalSkillResources({
    agentDir,
    homeDir,
    enableDotAgentsSkill,
  });
  const globalSkills = skillResources.globalSkills.value;
  const homeSkills = skillResources.homeSkills?.value ?? null;
  const globalSkillDescriptors = skillResources.globalSkills.skillDescriptors;
  const homeSkillDescriptors = skillResources.homeSkills?.skillDescriptors ?? null;
  const value = createHash("sha256")
    .update("easyresearch-configuration-v4\0")
    .update(agents)
    .update(models)
    .update(agentDefaults)
    .update(compaction)
    .update(apiUsage)
    .update(globalSkills)
    .update(homeSkills ?? "disabled")
    .digest("hex");
  return {
    value,
    agents,
    models,
    agentDefaults,
    compaction,
    compactionPolicy,
    apiUsage,
    apiUsageSettings,
    globalSkills,
    homeSkills,
    globalSkillDescriptors,
    homeSkillDescriptors,
  };
}

function assertValidCatalog(snapshot: AgentCatalogSnapshot): void {
  if (
    snapshot.diagnostics.length > 0 ||
    snapshot.definitions.length === 0 ||
    !snapshot.definitions.some((agent) => agent.name === RESEARCH_ASSISTANT_AGENT)
  ) {
    throw new Error("Invalid Agent catalog");
  }
}

function assertConfiguredModelsAvailable(
  snapshot: AgentCatalogSnapshot,
  availableModels: readonly ModelCatalogEntry[],
): void {
  const available = new Set(availableModels.map((model) => `${model.provider}/${model.id}`));
  if (snapshot.definitions.some((agent) => {
    const model = snapshot.defaults?.[agent.name]?.model;
    return model !== undefined && !available.has(model);
  })) {
    throw new Error("Configured Agent model is unavailable");
  }
}

function sameFingerprint(left: ConfigurationFingerprint, right: ConfigurationFingerprint): boolean {
  return left.value === right.value &&
    left.agents === right.agents &&
    left.models === right.models &&
    left.agentDefaults === right.agentDefaults &&
    left.compaction === right.compaction &&
    left.apiUsage === right.apiUsage &&
    left.globalSkills === right.globalSkills &&
    left.homeSkills === right.homeSkills;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) && typeof (value as { then?: unknown }).then === "function";
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function updateHashField(hash: ReturnType<typeof createHash>, bytes: Uint8Array): void {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
}

async function readDirectoryOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function readOptionalFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
