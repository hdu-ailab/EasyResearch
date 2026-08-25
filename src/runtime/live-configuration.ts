import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { watch as chokidarWatch, type ChokidarOptions } from "chokidar";
import {
  loadAgentCatalog,
  RESEARCH_ASSISTANT_AGENT,
  resolveAgentCatalog,
  type AgentCatalogSnapshot,
  type AgentConfig,
  type AgentDiscoveryResult,
  type DiscoveryOptions,
} from "../subagent/agents";
import type {
  ConfigurationErrorEvent,
  ConfigurationEvent,
  ConfigurationUpdatedEvent,
} from "../web/contracts";
import { getAgentDir } from "./pi-import";
import { readGlobalAgentDefaults } from "../subagent/agent-defaults";
import {
  parseGlobalCompactionPolicy,
  type GlobalCompactionPolicy,
} from "./compaction-policy";
import type { ApiUsageSettingsDto } from "../web/contracts";
import { parseGlobalApiUsageSettings } from "./api-usage-settings";

export type { ConfigurationErrorEvent, ConfigurationEvent, ConfigurationUpdatedEvent } from "../web/contracts";

const SAFE_CONFIGURATION_ERROR =
  "Configuration validation failed. Fix the global Agent or model configuration and retry.";
const SAFE_CONFIGURATION_UNAVAILABLE =
  "No valid configuration is available. Fix the global Agent or model configuration and retry.";
const SAFE_WATCHER_ERROR = "Configuration monitoring failed. Refresh to check for updates.";
const STABILITY_THRESHOLD_MS = 200;

export interface ConfigurationFingerprint {
  value: string;
  agents: string;
  models: string;
  agentDefaults?: string;
  compaction: string;
  compactionPolicy: GlobalCompactionPolicy;
  apiUsage: string;
  apiUsageSettings: ApiUsageSettingsDto;
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

interface ConfigurationWatcher {
  on(event: string, listener: (...args: unknown[]) => void): ConfigurationWatcher;
  close(): Promise<void>;
}

export type ConfigurationWatchImplementation = (
  paths: string[],
  options: ChokidarOptions,
) => ConfigurationWatcher;

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
}

export interface LiveConfiguration {
  readonly generation: number;
  readonly error: string | null;
  readonly compactionPolicy: GlobalCompactionPolicy;
  readonly apiUsageSettings: ApiUsageSettingsDto;
  start(): Promise<void>;
  synchronize(): Promise<void>;
  /** True only for the latest validation-clean accepted generation. */
  isCurrent(generation: number): boolean;
  notify(change: {
    agentsChanged?: boolean;
    modelsChanged?: boolean;
    force?: boolean;
  }): Promise<void>;
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
  force: boolean;
  waiters: Array<() => void>;
}

type SynchronizationOutcome = "committed" | "unchanged" | "failed" | "closed";

export function createLiveConfiguration(options: LiveConfigurationOptions): LiveConfiguration {
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const agentsDir = join(agentDir, "agents");
  const settingsPath = join(agentDir, "settings.json");
  const modelsPath = join(agentDir, "models.json");
  const catalogOptions = { ...options.catalogOptions };
  const readFingerprint = options.fingerprint ?? fingerprintConfiguration;
  const loadCatalog = options.loadCatalog ?? ((discovery) => loadAgentCatalog(discovery));
  const resolveCatalog = options.resolveCatalog ?? resolveAgentCatalog;
  const watch = options.watch ?? (chokidarWatch as unknown as ConfigurationWatchImplementation);
  const listeners = new Set<(event: ConfigurationEvent) => void>();

  let currentGeneration = 0;
  let validationError: string | null = null;
  let watcherError: string | null = null;
  let currentCatalog: AgentCatalogSnapshot | undefined;
  let currentFingerprint: ConfigurationFingerprint | undefined;
  let currentCompactionPolicy = parseGlobalCompactionPolicy({});
  let currentApiUsageSettings = parseGlobalApiUsageSettings({});
  let watcher: ConfigurationWatcher | undefined;
  let settleWatcherReady: (() => void) | undefined;
  let watcherReady: Promise<void> | undefined;
  let watcherInitialized = false;
  let startPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let watcherClosed = false;
  let pending: PendingSynchronization | undefined;
  let drainScheduled = false;
  let draining = false;
  let drainPromise: Promise<void> | undefined;
  let failedAgentsChanged = false;
  let failedModelsChanged = false;
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
    if (validationError === SAFE_CONFIGURATION_ERROR) return;
    validationError = SAFE_CONFIGURATION_ERROR;
    emitError(SAFE_CONFIGURATION_ERROR);
  };

  const publishWatcherError = (): void => {
    watcherError = SAFE_WATCHER_ERROR;
    emitError(SAFE_WATCHER_ERROR);
  };

  const validateAndAdvance = async (change: {
    agentsChanged: boolean;
    modelsChanged: boolean;
    force: boolean;
  }): Promise<SynchronizationOutcome> => {
    let candidate: ConfigurationFingerprint;
    try {
      candidate = await readFingerprint(agentDir);
    } catch {
      publishValidationError();
      return "failed";
    }

    let requiresRuntimeAlignment = false;
    for (;;) {
      if (closed) return "closed";
      const shouldCommit =
        change.force ||
        validationError !== null ||
        currentCatalog === undefined ||
        currentFingerprint === undefined ||
        !sameFingerprint(candidate, currentFingerprint);
      if (!shouldCommit && !requiresRuntimeAlignment) return "unchanged";

      let preparedModels: PreparedModelCatalog | undefined;
      const rollbackPreparedModels = async (): Promise<void> => {
        const candidateModels = preparedModels;
        preparedModels = undefined;
        await candidateModels?.rollback();
      };
      try {
        const nextCatalog = await loadCatalog({
          ...catalogOptions,
          agentDir,
          cwd: undefined,
        });
        assertValidCatalog(nextCatalog);
        if (closed) return "closed";
        preparedModels = await options.modelValidator.prepareModelCatalog();
        assertConfiguredModelsAvailable(nextCatalog, preparedModels.models);
        if (closed) {
          await rollbackPreparedModels();
          return "closed";
        }

        const confirmed = await readFingerprint(agentDir);
        if (!sameFingerprint(candidate, confirmed)) {
          await rollbackPreparedModels();
          candidate = confirmed;
          requiresRuntimeAlignment = true;
          continue;
        }
        if (closed) {
          await rollbackPreparedModels();
          return "closed";
        }
        if (!shouldCommit) {
          await rollbackPreparedModels();
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
          failedModelsChanged ||
          currentFingerprint === undefined ||
          candidate.models !== currentFingerprint.models;
        const apiUsageChanged = currentFingerprint !== undefined
          && candidate.apiUsage !== currentFingerprint.apiUsage;
        const runtimeChanged = agentsChanged
          || modelsChanged
          || currentFingerprint === undefined
          || candidate.compaction !== currentFingerprint.compaction;
        const event: ConfigurationUpdatedEvent = {
          type: "config.updated",
          generation: currentGeneration + 1,
          agentsChanged,
          modelsChanged,
          ...(apiUsageChanged ? { apiUsageChanged: true, runtimeChanged } : {}),
        };

        preparedModels.commit();
        preparedModels = undefined;
        currentCatalog = nextCatalog;
        currentFingerprint = candidate;
        currentCompactionPolicy = candidate.compactionPolicy;
        currentApiUsageSettings = candidate.apiUsageSettings;
        currentGeneration = event.generation;
        validationError = null;
        failedAgentsChanged = false;
        failedModelsChanged = false;
        publish(event);
        if (watcherError) emitError(watcherError);
        return "committed";
      } catch {
        try {
          await rollbackPreparedModels();
        } catch {
          // The candidate is isolated, so disposal failure cannot replace accepted state.
        }
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
        let outcome: SynchronizationOutcome = "closed";
        try {
          outcome = await validateAndAdvance(batch);
        } catch {
          publishValidationError();
          outcome = "failed";
        } finally {
          if (outcome === "failed") {
            failedAgentsChanged ||= batch.agentsChanged;
            failedModelsChanged ||= batch.modelsChanged;
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

  const requestSynchronization = (change: {
    agentsChanged?: boolean;
    modelsChanged?: boolean;
    force?: boolean;
  }): Promise<void> => {
    if (closed) return Promise.resolve();
    return new Promise<void>((resolveWaiter) => {
      pending ??= {
        agentsChanged: false,
        modelsChanged: false,
        force: false,
        waiters: [],
      };
      pending.agentsChanged ||= change.agentsChanged === true;
      pending.modelsChanged ||= change.modelsChanged === true;
      pending.force ||= change.force === true;
      pending.waiters.push(resolveWaiter);
      scheduleDrain();
    });
  };

  const installWatcher = (): Promise<void> => {
    if (watcherInitialized || closed) return watcherReady ?? Promise.resolve();
    watcherInitialized = true;
    let readySettled = false;
    watcherReady = new Promise<void>((resolveReady) => {
      settleWatcherReady = () => {
        if (readySettled) return;
        readySettled = true;
        resolveReady();
      };
    });
    try {
      watcher = watch([agentsDir, settingsPath, modelsPath], {
        ignoreInitial: true,
        depth: 0,
        ignored: (candidate) => {
          const path = resolve(String(candidate));
          return path !== agentsDir && path !== settingsPath && path !== modelsPath && !isAgentMarkdownPath(path, agentsDir);
        },
        awaitWriteFinish: {
          stabilityThreshold: STABILITY_THRESHOLD_MS,
          pollInterval: 50,
        },
      });
      const synchronizePath = (candidate: unknown) => {
        if (closed) return;
        const path = resolve(String(candidate));
        if (path === settingsPath) void requestSynchronization({});
        else if (path === modelsPath || isAgentMarkdownPath(path, agentsDir)) void requestSynchronization({});
      };
      watcher.on("add", synchronizePath);
      watcher.on("change", synchronizePath);
      watcher.on("unlink", synchronizePath);
      watcher.on("ready", () => settleWatcherReady?.());
      watcher.on("error", () => {
        publishWatcherError();
        settleWatcherReady?.();
      });
    } catch {
      watcher = undefined;
      publishWatcherError();
      settleWatcherReady?.();
    }
    return watcherReady;
  };

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
    start() {
      if (closed) return Promise.resolve();
      startPromise ??= (async () => {
        const ready = installWatcher();
        await requestSynchronization({});
        await ready;
        if (closed) return;
        await requestSynchronization({});
      })();
      return startPromise;
    },
    synchronize() {
      return requestSynchronization({});
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
      if (currentGeneration === 0 || snapshot === undefined) {
        throw new ConfigurationUnavailableError();
      }
      try {
        return resolveCatalog(snapshot, {
          ...catalogOptions,
          agentDir,
          cwd,
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
        settleWatcherReady?.();
        listeners.clear();
        settlePending();
        const failures: unknown[] = [];
        if (!watcherClosed) {
          try {
            await watcher?.close();
            watcherClosed = true;
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

export async function fingerprintConfiguration(agentDir: string): Promise<ConfigurationFingerprint> {
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
  for (const name of Object.keys(defaults).sort(compareNames)) {
    const entry = defaults[name]!;
    updateHashField(defaultsHash, Buffer.from(name, "utf8"));
    updateHashField(defaultsHash, Buffer.from(entry.model ?? "", "utf8"));
    updateHashField(defaultsHash, Buffer.from(entry.thinking ?? "", "utf8"));
  }
  const agentDefaults = defaultsHash.digest("hex");

  const settingsBytes = await readOptionalFile(join(agentDir, "settings.json"));
  let settings: unknown = {};
  if (settingsBytes !== undefined) settings = JSON.parse(settingsBytes.toString("utf8")) as unknown;
  const compactionPolicy = parseGlobalCompactionPolicy(settings);
  const compactionHash = createHash("sha256");
  compactionHash.update("easyresearch-compaction-v1\0");
  updateHashField(compactionHash, Buffer.from(String(compactionPolicy.triggerPercent), "utf8"));
  updateHashField(compactionHash, Buffer.from(compactionPolicy.globalEnabled ? "true" : "false", "utf8"));
  updateHashField(compactionHash, Buffer.from(String(compactionPolicy.globalKeepRecentTokens), "utf8"));
  const compaction = compactionHash.digest("hex");
  const apiUsageSettings = parseGlobalApiUsageSettings(settings);
  const apiUsageHash = createHash("sha256");
  apiUsageHash.update("easyresearch-api-usage-v1\0");
  updateHashField(
    apiUsageHash,
    Buffer.from(apiUsageSettings.showApiUsageDetails ? "true" : "false", "utf8"),
  );
  const apiUsage = apiUsageHash.digest("hex");
  const value = createHash("sha256")
    .update("easyresearch-configuration-v3\0")
    .update(agents)
    .update(models)
    .update(agentDefaults)
    .update(compaction)
    .update(apiUsage)
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
    left.apiUsage === right.apiUsage;
}

function isAgentMarkdownPath(path: string, agentsDir: string): boolean {
  return dirname(path) === agentsDir && path.endsWith(".md");
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
