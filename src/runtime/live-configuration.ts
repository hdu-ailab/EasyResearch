import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
  type AgentDefaultRepairResult,
  type DanglingAgentModelRepair,
  planDanglingAgentDefaultRepairs,
} from "./agent-default-repair";
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
import { parsePiSettingsJson } from "./pi-settings-json";
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
const SAFE_SETTINGS_DIAGNOSTIC =
  "Configuration issue in global settings.json. Open settings.json in Config to repair it.";

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
  diagnostic?: string;
  invalidSettingsLayers?: {
    agentDefaults?: true;
    compaction?: true;
    apiUsage?: true;
    skillPolicy?: true;
  };
}

export interface ModelCatalogEntry {
  provider: string;
  id: string;
}

export interface PreparedModelCatalog {
  readonly registeredModels: readonly ModelCatalogEntry[];
  readonly availableModels: readonly ModelCatalogEntry[];
  readonly fallbackModel?: ModelCatalogEntry;
  readonly diagnostic?: string;
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
  /** Current credential-filtered availability from the accepted runtime. */
  currentAvailableModels(): readonly ModelCatalogEntry[];
  refreshAvailability?(): Promise<readonly ModelCatalogEntry[]>;
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
  availabilityChanged?: boolean;
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
  skillSnapshotRoot?: string;
  repairAgentDefaults?: (
    repairs: readonly DanglingAgentModelRepair[],
  ) => Promise<AgentDefaultRepairResult>;
}

export interface LiveConfiguration {
  readonly generation: number;
  readonly availabilityEpoch: number;
  readonly error: string | null;
  readonly compactionPolicy: GlobalCompactionPolicy;
  readonly apiUsageSettings: ApiUsageSettingsDto;
  readonly skillPolicy: SkillResolutionPolicy;
  start(): Promise<void>;
  synchronize(options?: { projectCwds?: readonly string[] }): Promise<ConfigurationSynchronizationOutcome>;
  acquireProject(cwd: string): Promise<ProjectWatchRegistration>;
  /** True only for the latest accepted generation, including retained last-good state. */
  isCurrent(generation: number): boolean;
  notify(change: ConfigurationChange): Promise<ConfigurationSynchronizationOutcome>;
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
  availabilityChanged: boolean;
  structuralCheckRequested: boolean;
  force: boolean;
  waiters: Array<(outcome: ConfigurationSynchronizationOutcome) => void>;
}

interface SynchronizationRequest {
  agentsChanged: boolean;
  modelsChanged: boolean;
  skillsChanged: boolean;
  projectCwds: readonly string[];
  force: boolean;
}

export type ConfigurationSynchronizationStatus =
  | "committed"
  | "unchanged"
  | "repaired"
  | "rejected"
  | "superseded"
  | "closed";

export interface ConfigurationSynchronizationOutcome {
  status: ConfigurationSynchronizationStatus;
  generation: number;
  availabilityEpoch: number;
  error: string | null;
}

export function createLiveConfiguration(options: LiveConfigurationOptions): LiveConfiguration {
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const ownsSkillSnapshotRoot = options.skillSnapshotRoot === undefined;
  const skillSnapshotRoot = options.skillSnapshotRoot
    ?? mkdtempSync(join(tmpdir(), "easyresearch-skill-snapshots-"));
  const catalogOptions = { ...options.catalogOptions };
  const homeDir = resolve(catalogOptions.homeDir ?? homedir());
  const readFingerprint = options.fingerprint
    ?? ((path) => fingerprintConfiguration(path, homeDir, skillSnapshotRoot));
  const loadCatalog = options.loadCatalog ?? ((discovery) => loadAgentCatalog(discovery));
  const resolveCatalog = options.resolveCatalog ?? resolveAgentCatalog;
  const createWatcherManager = options.createWatcherManager ?? createConfigurationWatcherManager;
  const listeners = new Set<(event: ConfigurationEvent) => void>();

  let currentGeneration = 0;
  let currentAvailabilityEpoch = 0;
  let currentAvailabilitySignature = "";
  let validationError: string | null = null;
  let acceptedDiagnostic: string | null = null;
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
      availabilityEpoch: currentAvailabilityEpoch,
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

  const synchronizationOutcome = (
    status: ConfigurationSynchronizationStatus,
  ): ConfigurationSynchronizationOutcome => ({
    status,
    generation: currentGeneration,
    availabilityEpoch: currentAvailabilityEpoch,
    error: validationError ?? acceptedDiagnostic ?? watcherError,
  });

  const advanceAvailability = async (): Promise<ConfigurationSynchronizationOutcome> => {
    if (closed) return synchronizationOutcome("closed");
    try {
      const models = options.modelValidator.refreshAvailability
        ? await options.modelValidator.refreshAvailability()
        : options.modelValidator.currentAvailableModels();
      currentAvailabilitySignature = modelCatalogSignature(models);
    } catch {
      // Availability is recoverable provider state. The epoch notification
      // still lets readers retry without invalidating structural configuration.
    }
    currentAvailabilityEpoch += 1;
    publish({
      type: "config.updated",
      generation: currentGeneration,
      availabilityEpoch: currentAvailabilityEpoch,
      availabilityChanged: true,
      agentsChanged: false,
      modelsChanged: false,
      skillsChanged: false,
      runtimeChanged: false,
    });
    return synchronizationOutcome("committed");
  };

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

  const validateAndAdvance = async (
    change: SynchronizationRequest,
  ): Promise<ConfigurationSynchronizationStatus> => {
    let requiresRuntimeAlignment = false;
    let repairedDuringValidation = false;
    let supersededDuringValidation = false;
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

        const loadedCatalog = await loadCatalog({
          ...catalogOptions,
          agentDir,
          cwd: undefined,
          enableDotAgentsSkill: skillPolicyFor(candidate).enableDotAgentsSkill,
        });
        const nextCatalog = candidate.invalidSettingsLayers?.agentDefaults && currentCatalog
          ? { ...loadedCatalog, defaults: currentCatalog.defaults }
          : loadedCatalog;
        assertValidCatalog(nextCatalog);
        if (closed) {
          rollbackPreparedProjects();
          return "closed";
        }
        preparedModels = await options.modelValidator.prepareModelCatalog();
        const danglingRepairs = planDanglingAgentDefaultRepairs(
          nextCatalog,
          preparedModels.registeredModels,
          preparedModels.fallbackModel,
        );
        if (danglingRepairs.length > 0) {
          if (!options.repairAgentDefaults) throw new Error("Configured Agent model is unavailable");
          const repairResult = await options.repairAgentDefaults(danglingRepairs);
          await rollbackPreparedModels();
          rollbackPreparedProjects();
          const repairedFingerprint = await readFingerprint(agentDir);
          if (repairResult.status === "unchanged" && sameFingerprint(candidate, repairedFingerprint)) {
            throw new Error("Configured Agent model repair was superseded without a source change");
          }
          repairedDuringValidation ||= repairResult.status === "repaired";
          requiresRuntimeAlignment = true;
          continue;
        }
        if (closed) {
          await rollbackPreparedModels();
          rollbackPreparedProjects();
          return "closed";
        }

        const confirmed = await readFingerprint(agentDir);
        if (!sameFingerprint(candidate, confirmed) || !(await preparedProjects.isCurrent())) {
          await rollbackPreparedModels();
          rollbackPreparedProjects();
          requiresRuntimeAlignment = true;
          supersededDuringValidation = true;
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
          return supersededDuringValidation ? "superseded" : "unchanged";
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
        const preparedAvailabilitySignature = modelCatalogSignature(preparedModels.availableModels);
        const availabilityChanged = currentFingerprint !== undefined
          && preparedAvailabilitySignature !== currentAvailabilitySignature;
        const event: ConfigurationUpdatedEvent = {
          type: "config.updated",
          generation: currentGeneration + 1,
          agentsChanged,
          modelsChanged,
          skillsChanged,
          runtimeChanged,
          ...(availabilityChanged
            ? {
                availabilityEpoch: currentAvailabilityEpoch + 1,
                availabilityChanged: true,
              }
            : {}),
          ...(apiUsageChanged ? { apiUsageChanged: true } : {}),
        };

        const candidateDiagnostic = candidate.diagnostic
          ?? preparedModels.diagnostic
          ?? catalogDiagnostic(nextCatalog)
          ?? null;
        preparedModels.commit();
        preparedModels = undefined;
        preparedProjects.commit();
        preparedProjects = undefined;
        currentCatalog = nextCatalog;
        currentFingerprint = candidate;
        currentCompactionPolicy = candidate.invalidSettingsLayers?.compaction && currentFingerprint
          ? currentCompactionPolicy
          : candidate.compactionPolicy;
        currentApiUsageSettings = candidate.invalidSettingsLayers?.apiUsage && currentFingerprint
          ? currentApiUsageSettings
          : candidate.apiUsageSettings;
        if (currentAvailabilityEpoch === 0) currentAvailabilityEpoch = 1;
        else if (availabilityChanged) currentAvailabilityEpoch += 1;
        currentAvailabilitySignature = preparedAvailabilitySignature;
        currentGeneration = event.generation;
        validationError = null;
        acceptedDiagnostic = candidateDiagnostic;
        failedAgentsChanged = false;
        failedModelsChanged = false;
        failedSkillsChanged = false;
        failedProjectCwds.clear();
        publish(event);
        if (acceptedDiagnostic) emitError(acceptedDiagnostic);
        if (watcherError) emitError(watcherError);
        await alignHomeWatcher();
        return repairedDuringValidation ? "repaired" : "committed";
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
        return "rejected";
      }
    }
  };

  const settlePending = (settled = synchronizationOutcome("closed")): void => {
    const batch = pending;
    pending = undefined;
    for (const resolveWaiter of batch?.waiters ?? []) resolveWaiter(settled);
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
        let settled = synchronizationOutcome("closed");
        try {
          const availabilityOnly =
            batch.availabilityChanged
            && !batch.structuralCheckRequested
            && !batch.agentsChanged
            && !batch.modelsChanged
            && !batch.skillsChanged
            && batch.projectCwds.size === 0
            && !batch.force;
          if (availabilityOnly) {
            settled = await advanceAvailability();
          } else {
            settled = synchronizationOutcome(await validateAndAdvance(request));
            if (batch.availabilityChanged && settled.status !== "closed") {
              const structuralStatus = settled.status;
              await advanceAvailability();
              settled = synchronizationOutcome(structuralStatus);
            }
          }
        } catch {
          publishValidationError();
          settled = synchronizationOutcome("rejected");
        } finally {
          if (settled.status === "rejected") {
            failedAgentsChanged ||= batch.agentsChanged;
            failedModelsChanged ||= batch.modelsChanged;
            failedSkillsChanged ||= batch.skillsChanged;
            for (const cwd of batch.projectCwds) failedProjectCwds.add(cwd);
          }
          for (const resolveWaiter of batch.waiters) resolveWaiter(settled);
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

  const requestSynchronization = (
    change: ConfigurationChange,
    structuralCheckRequested = true,
  ): Promise<ConfigurationSynchronizationOutcome> => {
    if (closed) return Promise.resolve(synchronizationOutcome("closed"));
    return new Promise<ConfigurationSynchronizationOutcome>((resolveWaiter) => {
      pending ??= {
        agentsChanged: false,
        modelsChanged: false,
        skillsChanged: false,
        projectCwds: new Set<string>(),
        availabilityChanged: false,
        structuralCheckRequested: false,
        force: false,
        waiters: [],
      };
      pending.agentsChanged ||= change.agentsChanged === true;
      pending.modelsChanged ||= change.modelsChanged === true;
      pending.skillsChanged ||= change.skillsChanged === true;
      for (const cwd of change.projectCwds ?? []) pending.projectCwds.add(cwd);
      pending.availabilityChanged ||= change.availabilityChanged === true;
      pending.structuralCheckRequested ||= structuralCheckRequested;
      pending.force ||= change.force === true;
      pending.waiters.push(resolveWaiter);
      scheduleDrain();
    });
  };

  try {
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
        return fingerprintSkillRoot(
          join(cwd, ".easyresearch", "skills"),
          `project:${cwd}`,
          skillSnapshotRoot,
        );
      },
    });
  } catch (error) {
    if (ownsSkillSnapshotRoot) rmSync(skillSnapshotRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    get generation() {
      return currentGeneration;
    },
    get availabilityEpoch() {
      return currentAvailabilityEpoch;
    },
    get error() {
      return validationError ?? acceptedDiagnostic ?? watcherError;
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
        currentCatalog !== undefined &&
        currentFingerprint !== undefined &&
        generation === currentGeneration
      );
    },
    notify(change) {
      const availabilityOnly =
        change.availabilityChanged === true
        && change.agentsChanged !== true
        && change.modelsChanged !== true
        && change.skillsChanged !== true
        && (change.projectCwds?.length ?? 0) === 0
        && change.force !== true;
      return requestSynchronization(change, !availabilityOnly);
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
      } catch (cause) {
        throw new Error("Agent configuration could not be resolved.", { cause });
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
        if (ownsSkillSnapshotRoot) {
          try {
            rmSync(skillSnapshotRoot, { recursive: true, force: true });
          } catch (error) {
            failures.push(error);
          }
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
  snapshotRoot?: string,
): Promise<ConfigurationFingerprint> {
  const settingsBytes = await readOptionalFile(join(agentDir, "settings.json"));
  let settings: unknown = {};
  let diagnostic: string | undefined;
  const invalidSettingsLayers: NonNullable<ConfigurationFingerprint["invalidSettingsLayers"]> = {};
  if (settingsBytes !== undefined) {
    try {
      settings = parsePiSettingsJson(settingsBytes.toString("utf8"));
    } catch {
      diagnostic = SAFE_SETTINGS_DIAGNOSTIC;
      invalidSettingsLayers.agentDefaults = true;
      invalidSettingsLayers.compaction = true;
      invalidSettingsLayers.apiUsage = true;
      invalidSettingsLayers.skillPolicy = true;
    }
  }
  let enableDotAgentsSkill = false;
  let compactionPolicy = parseGlobalCompactionPolicy({});
  let apiUsageSettings = parseGlobalApiUsageSettings({});
  try {
    enableDotAgentsSkill = isDotAgentsSkillEnabled(settings);
  } catch {
    diagnostic = SAFE_SETTINGS_DIAGNOSTIC;
    invalidSettingsLayers.skillPolicy = true;
  }
  try {
    compactionPolicy = parseGlobalCompactionPolicy(settings);
  } catch {
    diagnostic = SAFE_SETTINGS_DIAGNOSTIC;
    invalidSettingsLayers.compaction = true;
  }
  try {
    apiUsageSettings = parseGlobalApiUsageSettings(settings);
  } catch {
    diagnostic = SAFE_SETTINGS_DIAGNOSTIC;
    invalidSettingsLayers.apiUsage = true;
  }

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
  let defaults: Awaited<ReturnType<typeof readGlobalAgentDefaults>> = {};
  try {
    defaults = await readGlobalAgentDefaults(agentDir);
  } catch {
    diagnostic = SAFE_SETTINGS_DIAGNOSTIC;
    invalidSettingsLayers.agentDefaults = true;
    if (settingsBytes !== undefined) updateHashField(defaultsHash, settingsBytes);
  }
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
    snapshotRoot,
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
    .update(diagnostic ?? "valid")
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
    ...(diagnostic ? { diagnostic } : {}),
    ...(Object.keys(invalidSettingsLayers).length > 0 ? { invalidSettingsLayers } : {}),
  };
}

function assertValidCatalog(snapshot: AgentCatalogSnapshot): void {
  if (
    snapshot.definitions.length === 0 ||
    !snapshot.definitions.some((agent) => agent.name === RESEARCH_ASSISTANT_AGENT)
  ) {
    throw new Error("Invalid Agent catalog");
  }
}

function catalogDiagnostic(snapshot: AgentCatalogSnapshot): string | undefined {
  const diagnostic = snapshot.diagnostics[0];
  if (!diagnostic) return undefined;
  return diagnostic.source === "global"
    ? `Agent configuration issue in global agents/${diagnostic.agent}.md. Open that file in Config to repair it.`
    : `Agent configuration issue in bundled Agent ${diagnostic.agent}. Reinstall this EasyResearch version.`;
}

function sameFingerprint(left: ConfigurationFingerprint, right: ConfigurationFingerprint): boolean {
  return left.value === right.value &&
    left.agents === right.agents &&
    left.models === right.models &&
    left.agentDefaults === right.agentDefaults &&
    left.compaction === right.compaction &&
    left.apiUsage === right.apiUsage &&
    left.globalSkills === right.globalSkills &&
    left.homeSkills === right.homeSkills &&
    left.diagnostic === right.diagnostic;
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

function modelCatalogSignature(models: readonly ModelCatalogEntry[]): string {
  return [...models]
    .map((model) => `${model.provider}\0${model.id}`)
    .sort(compareNames)
    .join("\n");
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
