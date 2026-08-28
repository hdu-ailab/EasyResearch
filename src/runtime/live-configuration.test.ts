import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentCatalogSnapshot,
  type AgentConfig,
  type AgentDefinition,
  type AgentDiscoveryResult,
  type DiscoveryOptions,
  resolveAgentCatalog,
} from "../subagent/agents";
import type { ConfigurationEvent } from "../web/contracts";
import { ConfigFileService } from "../web/config-files";
import type {
  ConfigurationWatcherManager,
  ProjectWatchRegistration,
  ResourceWatchChange,
  WatcherDependencies,
} from "./configuration-watchers";
import { createAgentRuntimeBinding } from "./agent-runtime-binding";
import { repairDanglingAgentDefaults } from "./agent-default-repair";
import {
  type ConfigurationFingerprint,
  ConfigurationUnavailableError,
  type ConfigurationWatchImplementation,
  createLiveConfiguration,
  fingerprintConfiguration,
  type LiveConfiguration,
} from "./live-configuration";

const tempRoots: string[] = [];
const realConfigurations: LiveConfiguration[] = [];

afterEach(async () => {
  for (const live of realConfigurations.splice(0)) await live.close().catch(() => {});
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-live-config-"));
  tempRoots.push(root);
  return root;
}

function definition(version: string): AgentDefinition {
  return {
    name: "research-assistant",
    description: `Research Assistant ${version}`,
    enabled: true,
    builtin: true,
    tools: [],
    subagents: ["search"],
    skills: ["research-project-workflow"],
    systemPrompt: `Prompt ${version}`,
    source: "global",
    filePath: `/private/agents/research-assistant-${version}.md`,
  };
}

function catalog(version: string): AgentCatalogSnapshot {
  return {
    definitions: [definition(version)],
    diagnostics: [],
    defaults: { "research-assistant": { model: `provider/${version}`, thinking: "high" } },
  };
}

function fingerprint(
  agents: string,
  models: string,
  agentDefaults = "defaults-v1",
  compaction = "compaction-v1",
  compactionPolicy = { triggerPercent: 70, globalEnabled: true, globalKeepRecentTokens: 20_000 },
  apiUsage = "api-usage-v1",
  apiUsageSettings = { showApiUsageDetails: false },
  globalSkills = "global-skills-v1",
  homeSkills: string | null = null,
  globalSkillDescriptors: ConfigurationFingerprint["globalSkillDescriptors"] = [],
  homeSkillDescriptors: ConfigurationFingerprint["homeSkillDescriptors"] = null,
): ConfigurationFingerprint {
  return {
    value: `${agents}:${models}:${agentDefaults}:${compaction}:${apiUsage}:${globalSkills}:${homeSkills ?? "disabled"}`,
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

function withSkills(
  base: ConfigurationFingerprint,
  globalSkills: string,
  homeSkills: string | null = base.homeSkills,
  globalSkillDescriptors = base.globalSkillDescriptors,
  homeSkillDescriptors = base.homeSkillDescriptors,
): ConfigurationFingerprint {
  return {
    ...base,
    value: `${base.value}:skills:${globalSkills}:${homeSkills ?? "disabled"}`,
    globalSkills,
    homeSkills,
    globalSkillDescriptors,
    homeSkillDescriptors,
  };
}

function resolvedAgents(snapshot: AgentCatalogSnapshot, options: DiscoveryOptions = {}): AgentDiscoveryResult {
  return {
    agents: snapshot.definitions.map(
      (agent): AgentConfig => ({
        ...agent,
        model: snapshot.defaults?.[agent.name]?.model,
        thinking: snapshot.defaults?.[agent.name]?.thinking,
        tools: agent.tools ? [...agent.tools] : undefined,
        effectiveTools: agent.tools ? [...agent.tools] : ["read", "bash"],
        subagents: agent.subagents ? [...agent.subagents] : undefined,
        skills: agent.skills ? [...agent.skills] : undefined,
        effectiveSkills: options.cwd ? [`skill@${options.cwd}`] : ["global-skill"],
        effectiveSkillPaths: options.cwd ? [`/skills/project${options.cwd}`] : ["/skills/global-skill"],
        missingSkills: [],
      }),
    ),
  };
}

function agentMarkdown(name: string, marker: string, skills: readonly string[] = []): string {
  const skillLines = skills.length === 0
    ? ["skills: []"]
    : ["skills:", ...skills.map((skill) => `  - ${skill}`)];
  return [
    "---",
    `name: ${name}`,
    `description: ${name} ${marker}`,
    "enable: true",
    "tools:",
    "  - read",
    ...skillLines,
    "subagents: []",
    "---",
    "",
    `ROLE_${marker}`,
    "",
  ].join("\n");
}

function skillMarkdown(name: string, marker: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${marker}`,
    "---",
    "",
    `# ${marker}`,
    "",
  ].join("\n");
}

function acceptedSkillPath() {
  return expect.stringContaining("easyresearch-skill-snapshots-");
}

function droppedConfigurationWatch(): ConfigurationWatchImplementation {
  return (() => {
    const watcher = {
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === "ready") queueMicrotask(listener);
        return watcher;
      },
      add() {
        return watcher;
      },
      async close() {},
    };
    return watcher;
  }) as ConfigurationWatchImplementation;
}

interface RealConfigurationHarness {
  root: string;
  agentDir: string;
  homeDir: string;
  project: string;
  live: LiveConfiguration;
  events: ConfigurationEvent[];
}

async function startRealConfiguration(options: {
  prepare?: (paths: Omit<RealConfigurationHarness, "live" | "events">) => void;
  watch?: ConfigurationWatchImplementation;
} = {}): Promise<RealConfigurationHarness> {
  const root = tempRoot();
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  const project = join(root, "paper");
  mkdirSync(agentDir);
  mkdirSync(homeDir);
  mkdirSync(project);
  const paths = { root, agentDir, homeDir, project };
  options.prepare?.(paths);
  const live = createLiveConfiguration({
    agentDir,
    catalogOptions: { homeDir },
    modelValidator: {
      async prepareModelCatalog() {
        return { registeredModels: [], availableModels: [], commit() {}, rollback() {} };
      },
      currentAvailableModels: () => [],
    },
    ...(options.watch ? { watch: options.watch } : {}),
  });
  realConfigurations.push(live);
  const events: ConfigurationEvent[] = [];
  live.subscribe((event) => events.push(event));
  await live.start();
  expect(live.generation).toBe(1);
  expect(live.error).toBeNull();
  return { ...paths, live, events };
}

async function waitForGeneration(live: LiveConfiguration, generation: number): Promise<void> {
  await vi.waitFor(() => expect(live.generation).toBe(generation), {
    timeout: 10_000,
    interval: 20,
  });
}

function configurationUpdates(events: readonly ConfigurationEvent[]): ConfigurationEvent[] {
  return events.filter((event) => event.type === "config.updated");
}

function fakeWatcher(autoReady = true) {
  const callbacks = new Map<string, Array<(...args: unknown[]) => void>>();
  const close = vi.fn(async () => {});
  const emit = (event: string, ...args: unknown[]) => {
    for (const callback of callbacks.get(event) ?? []) callback(...args);
  };
  const watch = vi.fn(() => {
    const watcher = {
      on(event: string, callback: (...args: unknown[]) => void) {
        const listeners = callbacks.get(event) ?? [];
        listeners.push(callback);
        callbacks.set(event, listeners);
        return watcher;
      },
      close,
    };
    if (autoReady) queueMicrotask(() => emit("ready"));
    return watcher;
  });
  return {
    watch: watch as unknown as ConfigurationWatchImplementation,
    close,
    emit,
    ready() {
      emit("ready");
    },
  };
}

interface TestProjectRecord {
  refs: number;
  baseline: string;
}

interface TestProjectTransaction {
  state: "pending" | "committed" | "rolled-back";
}

function fakeResourceWatcherManager(options: { autoReady?: boolean } = {}) {
  let dependencies: WatcherDependencies | undefined;
  let releaseStart: (() => void) | undefined;
  const startReady = options.autoReady === false
    ? new Promise<void>((resolveReady) => {
      releaseStart = resolveReady;
    })
    : Promise.resolve();
  const projects = new Map<string, TestProjectRecord>();
  const projectValues = new Map<string, string>();
  const transactions: TestProjectTransaction[] = [];
  const topologyChanges: boolean[] = [];
  let started = false;
  let closed = false;
  let homeEnabled = false;
  let startCalls = 0;
  let closeAttempts = 0;
  let startFailure: Error | undefined;
  let prepareFailure: Error | undefined;
  let acquireFailure: Error | undefined;
  let deferredAcquisition: {
    promise: Promise<ProjectWatchRegistration>;
    started: boolean;
  } | undefined;
  let closeAction: () => Promise<void> = async () => {};
  let topologyHook: ((enabled: boolean) => void) | undefined;

  const projectValue = (cwd: string): string => projectValues.get(cwd) ?? "missing";
  const registrationFor = (cwd: string, record: TestProjectRecord): ProjectWatchRegistration => {
    let released = false;
    return {
      cwd,
      async release() {
        if (released) return;
        released = true;
        if (projects.get(cwd) !== record) return;
        record.refs -= 1;
        if (record.refs === 0) projects.delete(cwd);
      },
    };
  };
  const manager: ConfigurationWatcherManager = {
    async start(enableHome) {
      startCalls += 1;
      await startReady;
      if (closed) throw new Error("resource watcher manager closed");
      if (startFailure) {
        const failure = startFailure;
        startFailure = undefined;
        throw failure;
      }
      started = true;
      homeEnabled = enableHome;
    },
    async setHomeEnabled(enabled) {
      if (!started || closed) throw new Error("resource watcher manager unavailable");
      homeEnabled = enabled;
      topologyChanges.push(enabled);
      topologyHook?.(enabled);
    },
    async acquireProject(candidateCwd) {
      if (deferredAcquisition) {
        const acquisition = deferredAcquisition;
        deferredAcquisition = undefined;
        acquisition.started = true;
        return acquisition.promise;
      }
      if (acquireFailure) {
        const failure = acquireFailure;
        acquireFailure = undefined;
        throw failure;
      }
      const cwd = resolve(candidateCwd);
      const existing = projects.get(cwd);
      if (existing) {
        existing.refs += 1;
        return registrationFor(cwd, existing);
      }
      const record = { refs: 1, baseline: projectValue(cwd) };
      projects.set(cwd, record);
      return registrationFor(cwd, record);
    },
    async prepareProjectChanges(cwds) {
      if (prepareFailure) {
        const failure = prepareFailure;
        prepareFailure = undefined;
        throw failure;
      }
      if (transactions.some((transaction) => transaction.state === "pending")) {
        throw new Error("previous project transaction was not settled");
      }
      const entries = [...new Set(cwds.map((cwd) => resolve(cwd)))]
        .flatMap((cwd) => {
          const record = projects.get(cwd);
          return record ? [{ cwd, record, value: projectValue(cwd) }] : [];
        });
      const transaction: TestProjectTransaction = { state: "pending" };
      transactions.push(transaction);
      return {
        changedCwds: entries
          .filter(({ record, value }) => record.baseline !== value)
          .map(({ cwd }) => cwd),
        async isCurrent() {
          return entries.every(({ cwd, record, value }) =>
            projects.get(cwd) === record && projectValue(cwd) === value
          );
        },
        commit() {
          if (transaction.state !== "pending") return;
          transaction.state = "committed";
          for (const { cwd, record, value } of entries) {
            if (projects.get(cwd) === record) record.baseline = value;
          }
        },
        rollback() {
          if (transaction.state === "pending") transaction.state = "rolled-back";
        },
      };
    },
    projectSkillDescriptors() {
      return [];
    },
    async close() {
      closeAttempts += 1;
      await closeAction();
      closed = true;
    },
  };
  const createManager = (nextDependencies: WatcherDependencies): ConfigurationWatcherManager => {
    dependencies = nextDependencies;
    return manager;
  };

  return {
    createManager,
    emitChange(change: ResourceWatchChange) {
      dependencies?.onChange(change);
    },
    emitError() {
      dependencies?.onError();
    },
    ready() {
      releaseStart?.();
    },
    setProjectValue(cwd: string, value: string) {
      projectValues.set(resolve(cwd), value);
    },
    failNextPrepare(error: Error) {
      prepareFailure = error;
    },
    failNextStart(error: Error) {
      startFailure = error;
    },
    failNextAcquire(error: Error) {
      acquireFailure = error;
    },
    deferNextAcquire() {
      let resolveAcquisition!: (registration: ProjectWatchRegistration) => void;
      const acquisition = {
        promise: new Promise<ProjectWatchRegistration>((resolveRegistration) => {
          resolveAcquisition = resolveRegistration;
        }),
        started: false,
      };
      deferredAcquisition = acquisition;
      return {
        resolve: resolveAcquisition,
        started: () => acquisition.started,
      };
    },
    setCloseAction(action: () => Promise<void>) {
      closeAction = action;
    },
    setTopologyHook(hook: (enabled: boolean) => void) {
      topologyHook = hook;
    },
    get homeEnabled() {
      return homeEnabled;
    },
    get startCalls() {
      return startCalls;
    },
    get closeAttempts() {
      return closeAttempts;
    },
    topologyChanges,
    transactions,
  };
}

function modelOption(reference: string) {
  const separator = reference.indexOf("/");
  return {
    provider: reference.slice(0, separator),
    id: reference.slice(separator + 1),
    reasoning: false,
  };
}

function explicitModels(snapshot: AgentCatalogSnapshot) {
  return [...new Set(Object.values(snapshot.defaults ?? {}).flatMap((entry) => entry.model ? [entry.model] : []))]
    .map(modelOption);
}

function harness(
  initialCatalog: AgentCatalogSnapshot = catalog("v1"),
  options: {
    agentDir?: string;
    autoReady?: boolean;
    catalogOptions?: Omit<DiscoveryOptions, "agentDir" | "cwd">;
    watch?: ConfigurationWatchImplementation;
    createWatcherManager?: (dependencies: WatcherDependencies) => ConfigurationWatcherManager;
    resolveCatalog?: (
      snapshot: AgentCatalogSnapshot,
      options: DiscoveryOptions,
    ) => AgentDiscoveryResult;
    repairAgentDefaults?: Parameters<typeof createLiveConfiguration>[0]["repairAgentDefaults"];
  } = {},
) {
  let currentCatalog = initialCatalog;
  let currentFingerprint = fingerprint("agents-v1", "models-v1");
  let registeredModels = explicitModels(currentCatalog);
  let availableModels = [...registeredModels];
  let availabilityError: Error | undefined;
  let acceptedModels: string[] = [];
  const loadCatalog = vi.fn(async (_discovery: DiscoveryOptions) => currentCatalog);
  const resolveCatalog = vi.fn(options.resolveCatalog ?? resolvedAgents);
  const preparedModelCatalogs: Array<{
    registeredModels: ReturnType<typeof modelOption>[];
    availableModels: ReturnType<typeof modelOption>[];
    commit: ReturnType<typeof vi.fn>;
    rollback: ReturnType<typeof vi.fn>;
  }> = [];
  const prepareCandidate = (references: string[]) => {
    const models = references.map(modelOption);
    let settled = false;
    const commit = vi.fn(() => {
      if (settled) throw new Error("candidate already settled");
      settled = true;
      acceptedModels = references.slice();
    });
    const rollback = vi.fn(async () => {
      if (settled) throw new Error("candidate already settled");
      settled = true;
    });
    const candidate = { registeredModels: models, availableModels: models, commit, rollback };
    preparedModelCatalogs.push(candidate);
    return candidate;
  };
  const prepareModels = vi.fn(async () =>
    (() => {
      const candidate = prepareCandidate(registeredModels.map((model) => `${model.provider}/${model.id}`));
      return {
        ...candidate,
        availableModels: availableModels.map((model) => ({ ...model })),
      };
    })()
  );
  const readFingerprint = vi.fn(async () => currentFingerprint);
  const watcher = fakeWatcher(options.autoReady);
  const live = createLiveConfiguration({
    agentDir: options.agentDir ?? "/global",
    catalogOptions: options.catalogOptions,
    modelValidator: {
      prepareModelCatalog: prepareModels,
      currentAvailableModels: () => {
        if (availabilityError) throw availabilityError;
        return availableModels.map((model) => ({ ...model }));
      },
    },
    fingerprint: readFingerprint,
    loadCatalog,
    resolveCatalog,
    watch: options.watch ?? watcher.watch,
    createWatcherManager: options.createWatcherManager,
    repairAgentDefaults: options.repairAgentDefaults,
  });
  return {
    live,
    loadCatalog,
    resolveCatalog,
    prepareModels,
    preparedModelCatalogs,
    prepareCandidate,
    acceptedModels() {
      return acceptedModels.slice();
    },
    readFingerprint,
    watcher,
    setCatalog(next: AgentCatalogSnapshot) {
      currentCatalog = next;
      registeredModels = explicitModels(next);
      availableModels = [...registeredModels];
    },
    setFingerprint(next: ConfigurationFingerprint) {
      currentFingerprint = next;
    },
    setModels(references: string[]) {
      registeredModels = references.map(modelOption);
      availableModels = [...registeredModels];
    },
    setAvailability(references: string[]) {
      availableModels = references.map(modelOption);
    },
    setAvailabilityError(error: Error | undefined) {
      availabilityError = error;
    },
  };
}

describe("live configuration generations", () => {
  it("accepts an explicit registered DeepSeek model with empty availability", async () => {
    const deepseekCatalog = catalog("v1");
    deepseekCatalog.defaults = {
      "research-assistant": { model: "deepseek/deepseek-v4-flash", thinking: "high" },
    };
    const state = harness(deepseekCatalog);
    state.setModels(["deepseek/deepseek-v4-flash"]);
    state.setAvailability([]);

    await state.live.start();

    expect(state.live.generation).toBe(1);
    expect(state.live.error).toBeNull();
    await expect(state.live.resolveAgents()).resolves.toEqual([
      expect.objectContaining({ model: "deepseek/deepseek-v4-flash", thinking: "high" }),
    ]);
  });

  it("does not poison structural configuration when availability projection fails", async () => {
    const state = harness();
    await state.live.start();
    state.setAvailabilityError(new Error("private malformed credential state"));

    await expect(state.live.notify({ availabilityChanged: true })).resolves.toMatchObject({
      status: "committed",
      generation: 1,
      availabilityEpoch: 2,
      error: null,
    });

    expect(state.live.generation).toBe(1);
    expect(state.live.isCurrent(1)).toBe(true);
    expect(state.live.error).toBeNull();
  });

  it("keeps malformed settings bytes while starting from cold defaults", async () => {
    const root = tempRoot();
    const agentDir = join(root, "agent");
    const homeDir = join(root, "home");
    mkdirSync(agentDir);
    mkdirSync(homeDir);
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(settingsPath, "{ malformed settings\n");
    const before = readFileSync(settingsPath);
    const live = createLiveConfiguration({
      agentDir,
      catalogOptions: { homeDir },
      modelValidator: {
        async prepareModelCatalog() {
          return {
            registeredModels: [],
            availableModels: [],
            commit() {},
            rollback() {},
          };
        },
        currentAvailableModels: () => [],
      },
      watch: droppedConfigurationWatch(),
    });
    realConfigurations.push(live);

    await live.start();

    expect(live.generation).toBe(1);
    expect(live.isCurrent(1)).toBe(true);
    expect(live.error).toMatch(/configuration/i);
    await expect(live.resolveAgents()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "research-assistant", model: undefined }),
    ]));
    expect(readFileSync(settingsPath)).toEqual(before);
  });

  it("retains last-good Agent defaults after a later malformed settings layer", async () => {
    const state = harness();
    await state.live.start();
    state.setCatalog({ ...catalog("v1"), defaults: {} });
    state.setModels(["provider/v1"]);
    state.setFingerprint({
      ...fingerprint("agents-v1", "models-v1", "defaults-invalid"),
      diagnostic: "Configuration validation failed. Fix the global Agent or model configuration and retry.",
      invalidSettingsLayers: { agentDefaults: true },
    });

    const outcome = await state.live.synchronize();

    expect({ outcome, generation: state.live.generation }).toMatchObject({
      outcome: { status: "committed" },
      generation: 2,
    });
    expect(state.live.error).toMatch(/configuration/i);
    await expect(state.live.resolveAgents()).resolves.toEqual([
      expect.objectContaining({ model: "provider/v1", thinking: "high" }),
    ]);
  });


  it("self-repairs the v0.0.75 dangling model on cold start and stays repaired after restart", async () => {
    const root = tempRoot();
    const agentDir = join(root, "agent");
    const bundledRoot = join(root, "bundled");
    const bundledAgents = join(bundledRoot, "agents");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(bundledAgents, { recursive: true });
    writeFileSync(
      join(bundledAgents, "research-assistant.md"),
      agentMarkdown("research-assistant", "RA"),
    );
    writeFileSync(join(bundledAgents, "search.md"), agentMarkdown("search", "SEARCH"));
    const dangling = "deepseek/deepseek-v4-flash";
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(settingsPath, `${JSON.stringify({
      theme: "light",
      easyresearch: {
        keep: true,
        agentDefaults: {
          "research-assistant": { model: dangling, thinking: "max" },
          search: { model: dangling, thinking: "high" },
          dormant: { model: dangling, thinking: "low" },
        },
      },
    }, null, 2)}\n`);
    const config = new ConfigFileService(agentDir);
    const repair = vi.fn((repairs) => repairDanglingAgentDefaults(config, repairs));
    const prepareModelCatalog = vi.fn(async () => {
        return {
          registeredModels: [modelOption("openai/fallback")],
          availableModels: [modelOption("openai/fallback")],
          fallbackModel: modelOption("openai/fallback"),
          commit() {},
          rollback() {},
        };
      });
    const modelValidator = {
      prepareModelCatalog,
      currentAvailableModels: () => [modelOption("openai/fallback")],
    };
    const create = () => createLiveConfiguration({
      agentDir,
      catalogOptions: { bundledAgentsDir: bundledRoot, homeDir: join(root, "home") },
      modelValidator,
      repairAgentDefaults: repair,
      watch: droppedConfigurationWatch(),
    });

    const first = create();
    realConfigurations.push(first);
    await first.start();

    expect({
      generation: first.generation,
      error: first.error,
      prepareCalls: prepareModelCatalog.mock.calls.length,
      repairCalls: repair.mock.calls.length,
    }).toEqual({
      generation: 1,
      error: null,
      prepareCalls: 2,
      repairCalls: 1,
    });
    expect(await first.resolveAgents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "research-assistant", model: "openai/fallback", thinking: "max" }),
      expect.objectContaining({ name: "search", model: undefined, thinking: "high" }),
    ]));
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
      theme: "light",
      easyresearch: {
        keep: true,
        agentDefaults: {
          "research-assistant": { model: "openai/fallback", thinking: "max" },
          search: { thinking: "high" },
          dormant: { model: dangling, thinking: "low" },
        },
      },
    });
    await first.close();
    realConfigurations.splice(realConfigurations.indexOf(first), 1);

    repair.mockClear();
    const restarted = create();
    realConfigurations.push(restarted);
    await restarted.start();

    expect(restarted.generation).toBe(1);
    expect(restarted.error).toBeNull();
    expect(repair).not.toHaveBeenCalled();
    expect(await restarted.resolveAgents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "research-assistant", model: "openai/fallback" }),
      expect.objectContaining({ name: "search", model: undefined }),
    ]));
  });

  it("clears dangling discovered models without a fallback while keeping configuration usable", async () => {
    const initial = catalog("v1");
    initial.defaults = {
      "research-assistant": { model: "removed/missing", thinking: "high" },
    };
    let current = initial;
    let currentFingerprint = fingerprint("agents-v1", "models-v1", "defaults-v1");
    const repair = vi.fn(async (repairs: Parameters<typeof repairDanglingAgentDefaults>[1]) => {
      expect(repairs).toEqual([{
        agentName: "research-assistant",
        danglingModel: "removed/missing",
      }]);
      current = { ...current, defaults: { "research-assistant": { thinking: "high" } } };
      currentFingerprint = fingerprint("agents-v1", "models-v1", "defaults-v2");
      return { status: "repaired" as const, repairedAgents: ["research-assistant"] };
    });
    const prepareModelCatalog = vi.fn(async () => ({
      registeredModels: [],
      availableModels: [],
      commit() {},
      rollback() {},
    }));
    const live = createLiveConfiguration({
      agentDir: "/global",
      fingerprint: async () => currentFingerprint,
      loadCatalog: async () => current,
      resolveCatalog: resolvedAgents,
      modelValidator: {
        prepareModelCatalog,
        currentAvailableModels: () => [],
      },
      repairAgentDefaults: repair,
      createWatcherManager: fakeResourceWatcherManager().createManager,
    });

    await live.start();

    expect({
      generation: live.generation,
      error: live.error,
      prepareCalls: prepareModelCatalog.mock.calls.length,
      repairCalls: repair.mock.calls.length,
    }).toEqual({
      generation: 1,
      error: null,
      prepareCalls: 2,
      repairCalls: 1,
    });
    await expect(live.resolveAgents()).resolves.toEqual([
      expect.objectContaining({ name: "research-assistant", model: undefined, thinking: "high" }),
    ]);
    await live.close();
  });

  it("returns truthful synchronization outcomes and advances auth availability separately", async () => {
    const state = harness();
    const events: ConfigurationEvent[] = [];
    state.live.subscribe((event) => events.push(event));

    await state.live.start();
    expect(state.live.generation).toBe(1);
    expect(state.live.availabilityEpoch).toBe(1);

    await expect(state.live.synchronize()).resolves.toMatchObject({
      status: "unchanged",
      generation: 1,
      availabilityEpoch: 1,
    });

    state.setAvailability([]);
    await expect(state.live.notify({ availabilityChanged: true })).resolves.toMatchObject({
      status: "committed",
      generation: 1,
      availabilityEpoch: 2,
    });

    expect(state.live.generation).toBe(1);
    expect(events.at(-1)).toEqual({
      type: "config.updated",
      generation: 1,
      availabilityEpoch: 2,
      availabilityChanged: true,
      agentsChanged: false,
      modelsChanged: false,
      skillsChanged: false,
      runtimeChanged: false,
    });

    state.setFingerprint(fingerprint("broken-v2", "models-v1"));
    state.setCatalog({ definitions: [], diagnostics: [] });
    await expect(state.live.synchronize()).resolves.toMatchObject({ status: "rejected", generation: 1 });

    state.setAvailability(["provider/recovered"]);
    await expect(state.live.notify({ availabilityChanged: true })).resolves.toMatchObject({
      status: "committed",
      generation: 1,
      availabilityEpoch: 3,
      error: expect.stringMatching(/configuration/i),
    });

    await state.live.close();
    await expect(state.live.synchronize()).resolves.toMatchObject({ status: "closed", generation: 1 });
  });

  it("reports a validation candidate superseded by a concurrent source reversion", async () => {
    const state = harness();
    await state.live.start();
    state.setModels(["provider/v1", "provider/v2"]);
    state.loadCatalog
      .mockResolvedValueOnce(catalog("v2"))
      .mockResolvedValueOnce(catalog("v1"));
    state.readFingerprint
      .mockResolvedValueOnce(fingerprint("agents-v2", "models-v2"))
      .mockResolvedValueOnce(fingerprint("agents-v1", "models-v1"))
      .mockResolvedValue(fingerprint("agents-v1", "models-v1"));

    await expect(state.live.synchronize()).resolves.toMatchObject({
      status: "superseded",
      generation: 1,
    });
    expect(state.live.generation).toBe(1);
    expect(state.live.error).toBeNull();
  });

  it("reports repaired only after the persisted CAS result is accepted", async () => {
    let state!: ReturnType<typeof harness>;
    const repair = vi.fn(async () => {
      state.setCatalog({
        ...catalog("fallback"),
        defaults: { "research-assistant": { model: "provider/fallback", thinking: "high" } },
      });
      state.setFingerprint(fingerprint("agents-v2", "models-v2", "defaults-v3"));
      return { status: "repaired" as const, repairedAgents: ["research-assistant"] };
    });
    state = harness(catalog("v1"), { repairAgentDefaults: repair });
    await state.live.start();
    state.setCatalog({
      ...catalog("v2"),
      defaults: { "research-assistant": { model: "removed/missing", thinking: "high" } },
    });
    state.setModels(["provider/fallback"]);
    state.setFingerprint(fingerprint("agents-v2", "models-v2", "defaults-v2"));

    const [synchronization, availability] = await Promise.all([
      state.live.synchronize(),
      state.live.notify({ availabilityChanged: true }),
    ]);
    expect(synchronization).toMatchObject({ status: "repaired", generation: 2 });
    expect(availability).toMatchObject({ status: "repaired", generation: 2 });
    expect(repair).toHaveBeenCalledOnce();
    await expect(state.live.resolveAgents()).resolves.toEqual([
      expect.objectContaining({ model: "provider/fallback", thinking: "high" }),
    ]);
  });



  it("publishes the accepted compaction policy with its generation", async () => {
    const state = harness();
    await state.live.start();

    expect(state.live.compactionPolicy).toEqual({
      triggerPercent: 70,
      globalEnabled: true,
      globalKeepRecentTokens: 20_000,
    });

    state.setFingerprint(fingerprint(
      "agents-v1",
      "models-v1",
      "defaults-v1",
      "compaction-v2",
      { triggerPercent: 80, globalEnabled: false, globalKeepRecentTokens: 7_000 },
    ));
    await state.live.synchronize();

    expect(state.live.compactionPolicy).toEqual({
      triggerPercent: 80,
      globalEnabled: false,
      globalKeepRecentTokens: 7_000,
    });
  });

  it("starts at generation one and coalesces concurrent synchronization onto one complete refresh", async () => {
    const state = harness();

    await state.live.start();
    expect(state.live.generation).toBe(1);

    state.setCatalog(catalog("v2"));
    state.setFingerprint(fingerprint("agents-v2", "models-v1"));
    await Promise.all([
      state.live.synchronize(),
      state.live.synchronize(),
      state.live.synchronize(),
    ]);

    expect(state.live.generation).toBe(2);
    expect(state.loadCatalog).toHaveBeenCalledTimes(2);
    expect(state.prepareModels).toHaveBeenCalledTimes(2);
    await expect(state.live.resolveAgents("/paper")).resolves.toEqual([
      expect.objectContaining({
        name: "research-assistant",
        model: "provider/v2",
        systemPrompt: "Prompt v2",
        effectiveSkills: ["skill@/paper"],
      }),
    ]);
  });

  it("commits each successfully published model candidate exactly once", async () => {
    const state = harness();

    await state.live.start();

    expect(state.acceptedModels()).toEqual(["provider/v1"]);
    expect(state.preparedModelCatalogs[0]?.commit).toHaveBeenCalledTimes(1);
    expect(state.preparedModelCatalogs[0]?.rollback).not.toHaveBeenCalled();

    state.setCatalog(catalog("v2"));
    state.setFingerprint(fingerprint("agents-v2", "models-v2"));
    await state.live.synchronize();

    expect(state.acceptedModels()).toEqual(["provider/v2"]);
    expect(state.preparedModelCatalogs[1]?.commit).toHaveBeenCalledTimes(1);
    expect(state.preparedModelCatalogs[1]?.rollback).not.toHaveBeenCalled();
    expect(state.live.generation).toBe(2);
  });

  it("retains the last valid catalog, fingerprint, and generation after catalog validation fails", async () => {
    const state = harness();
    const events: ConfigurationEvent[] = [];
    state.live.subscribe((event) => events.push(event));
    await state.live.start();

    state.setFingerprint(withSkills(fingerprint("broken-v2", "models-v1"), "global-skills-v2"));
    state.setCatalog({
      definitions: [],
      diagnostics: [{ agent: "research-assistant", source: "global", message: "SECRET raw diagnostic" }],
    });
    await state.live.synchronize();

    expect(state.live.generation).toBe(1);
    await expect(state.live.resolveAgents("/paper")).resolves.toEqual([
      expect.objectContaining({ model: "provider/v1", systemPrompt: "Prompt v1" }),
    ]);

    state.setCatalog(catalog("v2"));
    state.setFingerprint(withSkills(fingerprint("agents-v2", "models-v1"), "global-skills-v2"));
    await state.live.synchronize();
    expect(state.live.generation).toBe(2);
    expect(events.at(-1)).toEqual({
      type: "config.updated",
      generation: 2,
      availabilityEpoch: 2,
      availabilityChanged: true,
      agentsChanged: true,
      modelsChanged: false,
      skillsChanged: true,
      runtimeChanged: true,
    });
    await expect(state.live.resolveAgents("/paper")).resolves.toEqual([
      expect.objectContaining({ model: "provider/v2", systemPrompt: "Prompt v2" }),
    ]);
  });

  it("keeps the last-good accepted generation current while a later candidate is rejected", async () => {
    const state = harness();
    await state.live.start();
    const acceptedGeneration = state.live.generation;

    expect(state.live.isCurrent(acceptedGeneration)).toBe(true);

    state.setFingerprint(fingerprint("broken-v2", "models-v2"));
    state.setCatalog({
      definitions: [],
      diagnostics: [{ agent: "research-assistant", source: "global", message: "invalid" }],
    });
    await state.live.synchronize();

    expect(state.live.generation).toBe(acceptedGeneration);
    expect(state.live.isCurrent(acceptedGeneration)).toBe(true);

    state.setCatalog(catalog("v2"));
    await state.live.synchronize();

    expect(state.live.isCurrent(acceptedGeneration)).toBe(false);
    expect(state.live.isCurrent(state.live.generation)).toBe(true);
  });

  it("rejects an unavailable explicit Agent model while allowing model inheritance and missing models", async () => {
    const state = harness();
    await state.live.start();
    const inheritingStage: AgentDefinition = {
      ...definition("search-v2"),
      name: "search",
      description: "Search",
      filePath: "/private/agents/search.md",
    };
    const unavailableStage: AgentDefinition = {
      ...definition("experiment-v2"),
      name: "experiment",
      description: "Experiment",
      filePath: "/private/agents/experiment.md",
    };
    state.setCatalog({
      definitions: [definition("v2"), inheritingStage, unavailableStage],
      diagnostics: [],
      defaults: {
        "research-assistant": { model: "provider/v2", thinking: "high" },
        experiment: { model: "provider/missing" },
      },
    });
    state.setModels(["provider/v2"]);
    state.setFingerprint(fingerprint("agents-v2", "models-v2"));

    await state.live.synchronize();

    expect(state.live.generation).toBe(1);
    expect(state.live.error).toMatch(/configuration/i);
    expect(state.acceptedModels()).toEqual(["provider/v1"]);
    const rejectedCandidate = state.preparedModelCatalogs.at(-1);
    expect(rejectedCandidate?.commit).not.toHaveBeenCalled();
    expect(rejectedCandidate?.rollback).toHaveBeenCalledTimes(1);
    await expect(state.live.resolveAgents("/paper")).resolves.toEqual([
      expect.objectContaining({ name: "research-assistant", model: "provider/v1" }),
    ]);

    state.setModels(["provider/v2", "provider/missing"]);
    await state.live.synchronize();

    expect(state.live.generation).toBe(2);
    await expect(state.live.resolveAgents("/paper")).resolves.toEqual([
      expect.objectContaining({ name: "research-assistant", model: "provider/v2" }),
      expect.objectContaining({ name: "search", model: undefined }),
      expect.objectContaining({ name: "experiment", model: "provider/missing" }),
    ]);
  });

  it("keeps generation zero unavailable after invalid startup and recovers on the first valid synchronization", async () => {
    const state = harness({
      definitions: [],
      diagnostics: [{ agent: "research-assistant", source: "global", message: "invalid at /secret/startup" }],
    });
    const events: ConfigurationEvent[] = [];
    state.live.subscribe((event) => events.push(event));

    await state.live.start();

    expect(state.live.generation).toBe(0);
    expect(state.live.error).toMatch(/configuration/i);
    await expect(state.live.resolveAgents("/paper")).rejects.toBeInstanceOf(ConfigurationUnavailableError);
    expect(events).toEqual([
      expect.objectContaining({ type: "config.error", generation: 0 }),
    ]);

    state.setCatalog(catalog("recovered"));
    await state.live.synchronize();

    expect(state.live.generation).toBe(1);
    expect(state.live.error).toBeNull();
    expect(events.at(-1)).toEqual({
      type: "config.updated",
      generation: 1,
      agentsChanged: true,
      modelsChanged: true,
      skillsChanged: true,
      runtimeChanged: true,
    });
    await expect(state.live.resolveAgents("/paper")).resolves.toEqual([
      expect.objectContaining({ model: "provider/recovered" }),
    ]);
  });

  it("isolates an invalid custom Agent while keeping the Research Assistant snapshot usable", async () => {
    const state = harness({
      definitions: [definition("v1")],
      diagnostics: [{ agent: "search", source: "global", message: "Invalid Agent definition." }],
    });

    await state.live.start();

    expect(state.live.generation).toBe(1);
    expect(state.live.error).toMatch(/configuration/i);
    await expect(state.live.resolveAgents("/paper")).resolves.toEqual([
      expect.objectContaining({ name: "research-assistant" }),
    ]);
  });

  it("reports component change flags and forces an auth-driven model revision without changed file bytes", async () => {
    const state = harness();
    const events: ConfigurationEvent[] = [];
    state.live.subscribe((event) => events.push(event));
    await state.live.start();

    state.setCatalog(catalog("agents-v2"));
    state.setFingerprint(fingerprint("agents-v2", "models-v1"));
    await state.live.synchronize();

    state.setFingerprint(fingerprint("agents-v2", "models-v2"));
    await state.live.synchronize();

    await state.live.notify({ modelsChanged: true, force: true });

    expect(events).toEqual([
      {
        type: "config.updated",
        generation: 1,
        agentsChanged: true,
        modelsChanged: true,
        skillsChanged: true,
        runtimeChanged: true,
      },
      {
        type: "config.updated",
        generation: 2,
        availabilityEpoch: 2,
        availabilityChanged: true,
        agentsChanged: true,
        modelsChanged: false,
        skillsChanged: false,
        runtimeChanged: true,
      },
      {
        type: "config.updated",
        generation: 3,
        agentsChanged: false,
        modelsChanged: true,
        skillsChanged: false,
        runtimeChanged: true,
      },
      {
        type: "config.updated",
        generation: 4,
        agentsChanged: false,
        modelsChanged: true,
        skillsChanged: false,
        runtimeChanged: true,
      },
    ]);
    expect(state.loadCatalog).toHaveBeenCalledTimes(4);
    expect(state.prepareModels).toHaveBeenCalledTimes(4);
  });

  it("classifies global and optional-home Skill fingerprints as runtime-only changes", async () => {
    const state = harness();
    const events: ConfigurationEvent[] = [];
    state.live.subscribe((event) => events.push(event));
    await state.live.start();

    const globalChange = withSkills(fingerprint("agents-v1", "models-v1"), "global-skills-v2");
    state.setFingerprint(globalChange);
    await state.live.synchronize();

    state.setFingerprint(withSkills(globalChange, "global-skills-v2", "home-skills-v1"));
    await state.live.synchronize();

    expect(events.slice(1)).toEqual([
      {
        type: "config.updated",
        generation: 2,
        agentsChanged: false,
        modelsChanged: false,
        skillsChanged: true,
        runtimeChanged: true,
      },
      {
        type: "config.updated",
        generation: 3,
        agentsChanged: false,
        modelsChanged: false,
        skillsChanged: true,
        runtimeChanged: true,
      },
    ]);
  });

  it("retains a failed forced model invalidation until a later plain synchronization commits", async () => {
    const state = harness();
    const events: ConfigurationEvent[] = [];
    state.live.subscribe((event) => events.push(event));
    await state.live.start();
    state.setFingerprint(withSkills(fingerprint("agents-v1", "models-v1"), "global-skills-v2"));
    state.prepareModels.mockRejectedValueOnce(new Error("temporary model refresh failure"));

    await state.live.notify({ modelsChanged: true, force: true });

    expect(state.live.generation).toBe(1);
    expect(state.live.error).toMatch(/configuration/i);

    await state.live.synchronize();

    expect(state.live.generation).toBe(2);
    expect(events.at(-1)).toEqual({
      type: "config.updated",
      generation: 2,
      agentsChanged: false,
      modelsChanged: true,
      skillsChanged: true,
      runtimeChanged: true,
    });
  });

  it("retains a changed Skill fingerprint when invalid settings bytes reject the candidate", async () => {
    const state = harness();
    const events: ConfigurationEvent[] = [];
    state.live.subscribe((event) => events.push(event));
    await state.live.start();
    state.setFingerprint(withSkills(fingerprint("agents-v1", "models-v1"), "global-skills-v2"));
    state.readFingerprint.mockRejectedValueOnce(new SyntaxError("invalid settings"));

    await state.live.synchronize();

    expect(state.live.generation).toBe(1);
    expect(state.live.error).toMatch(/configuration/i);

    await state.live.synchronize();

    expect(state.live.generation).toBe(2);
    expect(events.at(-1)).toEqual({
      type: "config.updated",
      generation: 2,
      agentsChanged: false,
      modelsChanged: false,
      skillsChanged: true,
      runtimeChanged: true,
    });
  });

  it("does not lose a forced notification that arrives while synchronization is in flight", async () => {
    const state = harness();
    await state.live.start();

    type PreparedCandidate = ReturnType<typeof state.prepareCandidate>;
    let releaseValidation!: (candidate: PreparedCandidate) => void;
    const validationGate = new Promise<PreparedCandidate>((resolve) => {
      releaseValidation = resolve;
    });
    state.prepareModels.mockImplementationOnce(async () => validationGate);
    state.setFingerprint(fingerprint("agents-v2", "models-v1"));
    state.setCatalog(catalog("v2"));

    const synchronization = state.live.synchronize();
    await vi.waitFor(() => expect(state.prepareModels).toHaveBeenCalledTimes(2));
    const notification = state.live.notify({ modelsChanged: true, force: true });
    releaseValidation(state.prepareCandidate(["provider/v2"]));
    await Promise.all([synchronization, notification]);

    expect(state.live.generation).toBe(3);
    expect(state.loadCatalog).toHaveBeenCalledTimes(3);
    expect(state.prepareModels).toHaveBeenCalledTimes(3);
  });

  it("keeps accepted F1 models when F2 confirmation reverts and the F1 candidate preparation fails", async () => {
    const state = harness();
    const events: ConfigurationEvent[] = [];
    state.live.subscribe((event) => events.push(event));
    await state.live.start();
    state.loadCatalog
      .mockResolvedValueOnce(catalog("v2"))
      .mockResolvedValueOnce(catalog("v1"));
    state.prepareModels
      .mockImplementationOnce(async () => state.prepareCandidate(["provider/v2"]))
      .mockRejectedValueOnce(new Error("accepted F1 candidate preparation failed"));
    state.readFingerprint
      .mockResolvedValueOnce(fingerprint("agents-v2", "models-v2"))
      .mockResolvedValueOnce(fingerprint("agents-v1", "models-v1"));

    await state.live.synchronize();

    expect(state.acceptedModels()).toEqual(["provider/v1"]);
    expect(state.live.generation).toBe(1);
    expect(state.live.error).toMatch(/configuration/i);
    expect(events.filter((event) => event.type === "config.updated")).toHaveLength(1);
    const revertedCandidate = state.preparedModelCatalogs.at(-1);
    expect(revertedCandidate?.commit).not.toHaveBeenCalled();
    expect(revertedCandidate?.rollback).toHaveBeenCalledTimes(1);
    await expect(state.live.resolveAgents("/paper")).resolves.toEqual([
      expect.objectContaining({ model: "provider/v1", systemPrompt: "Prompt v1" }),
    ]);
  });

  it("resolves different project Skills from one generation without reloading Agent definitions", async () => {
    const state = harness();
    await state.live.start();

    const projectA = await state.live.resolveAgents("/projects/a");
    const projectB = await state.live.resolveAgents("/projects/b");

    expect(projectA[0]?.effectiveSkills).toEqual(["skill@/projects/a"]);
    expect(projectB[0]?.effectiveSkills).toEqual(["skill@/projects/b"]);
    expect(state.live.generation).toBe(1);
    expect(state.loadCatalog).toHaveBeenCalledTimes(1);
    expect(state.resolveCatalog.mock.calls[0]?.[0]).toBe(state.resolveCatalog.mock.calls[1]?.[0]);
  });

  it("unsubscribes listeners and isolates a throwing subscriber from state and later subscribers", async () => {
    const state = harness();
    const removedEvents: ConfigurationEvent[] = [];
    const retainedEvents: ConfigurationEvent[] = [];
    const unsubscribe = state.live.subscribe((event) => removedEvents.push(event));
    state.live.subscribe(() => {
      throw new Error("subscriber secret");
    });
    state.live.subscribe((event) => retainedEvents.push(event));

    await state.live.start();
    unsubscribe();
    state.setFingerprint(fingerprint("agents-v2", "models-v1"));
    state.setCatalog(catalog("v2"));
    await state.live.synchronize();

    expect(removedEvents).toHaveLength(1);
    expect(retainedEvents.map((event) => event.generation)).toEqual([1, 2]);
    expect(state.live.generation).toBe(2);
  });

  it.each([
    {
      name: "catalog diagnostics",
      configure(state: ReturnType<typeof harness>) {
        state.setCatalog({
          definitions: [],
          diagnostics: [{ agent: "SECRET_AGENT", source: "global", message: "/home/private AGENT_SECRET" }],
        });
      },
    },
    {
      name: "model validation failures",
      configure(state: ReturnType<typeof harness>) {
        state.prepareModels.mockRejectedValue(
          new Error("models.json /home/private API_KEY=MODEL_SECRET"),
        );
      },
    },
  ])("redacts paths, contents, credentials, and raw diagnostics from $name", async ({ configure }) => {
    const state = harness();
    const events: ConfigurationEvent[] = [];
    state.live.subscribe((event) => events.push(event));
    configure(state);

    await state.live.start();

    const publicText = JSON.stringify({ error: state.live.error, events });
    expect(state.live.generation).toBe(0);
    expect(publicText).toMatch(/configuration/i);
    expect(publicText).not.toContain("/home/private");
    expect(publicText).not.toContain("AGENT_SECRET");
    expect(publicText).not.toContain("MODEL_SECRET");
    expect(publicText).not.toContain("SECRET_AGENT");
    expect(publicText).not.toContain("models.json");
  });

  it("redacts exact-cwd resolution failures after a valid generation", async () => {
    const state = harness();
    await state.live.start();
    state.resolveCatalog.mockImplementationOnce(() => {
      throw new Error("/home/private/project API_KEY=RESOLUTION_SECRET");
    });

    const failure = await state.live.resolveAgents("/home/private/project").catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/configuration/i);
    expect(failure.message).not.toContain("/home/private");
    expect(failure.message).not.toContain("RESOLUTION_SECRET");
  });
});

describe("live configuration resource transactions", () => {
  it("does not advance for empty or auxiliary-only Skill roots but advances for the first descriptor", async () => {
    const base = tempRoot();
    const agentDir = join(base, "agent");
    const homeDir = join(base, "home");
    const skillRoot = join(agentDir, "skills");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    const resources = fakeResourceWatcherManager();
    const events: ConfigurationEvent[] = [];
    const live = createLiveConfiguration({
      agentDir,
      catalogOptions: { homeDir, bundledSkillsDir: join(base, "bundled-skills") },
      modelValidator: {
        async prepareModelCatalog() {
          return {
            registeredModels: [modelOption("provider/v1")],
            availableModels: [modelOption("provider/v1")],
            commit() {},
            rollback() {},
          };
        },
        currentAvailableModels: () => [modelOption("provider/v1")],
      },
      loadCatalog: async () => catalog("v1"),
      resolveCatalog: resolvedAgents,
      createWatcherManager: resources.createManager,
    });
    live.subscribe((event) => events.push(event));
    await live.start();
    expect(live.generation).toBe(1);

    mkdirSync(join(skillRoot, "empty", "nested"), { recursive: true });
    await live.notify({ skillsChanged: true });
    expect(live.generation).toBe(1);

    writeFileSync(join(skillRoot, "helper.py"), "print('auxiliary')", "utf8");
    await live.notify({ skillsChanged: true });
    expect(live.generation).toBe(1);

    writeFileSync(join(skillRoot, "empty", "nested", ".SKILL.md.failed.tmp"), "temp artifact", "utf8");
    await live.notify({ skillsChanged: true });
    expect(live.generation).toBe(1);

    writeFileSync(join(skillRoot, "empty", "nested", "SKILL.md"), "first descriptor", "utf8");
    await live.notify({ skillsChanged: true });

    expect(live.generation).toBe(2);
    expect(events.slice(1)).toEqual([{
      type: "config.updated",
      generation: 2,
      agentsChanged: false,
      modelsChanged: false,
      skillsChanged: true,
      runtimeChanged: true,
    }]);
    await live.close();
  });

  it("commits optional-home policy before changing topology and emits one Skill generation per toggle", async () => {
    const resources = fakeResourceWatcherManager();
    const state = harness(catalog("v1"), { createWatcherManager: resources.createManager });
    const events: ConfigurationEvent[] = [];
    const topologySnapshots: Array<{ enabled: boolean; generation: number; policy: boolean }> = [];
    state.live.subscribe((event) => events.push(event));
    await state.live.start();
    resources.setTopologyHook((enabled) => {
      topologySnapshots.push({
        enabled,
        generation: state.live.generation,
        policy: state.live.skillPolicy.enableDotAgentsSkill,
      });
    });

    expect(state.live.skillPolicy).toEqual({ enableDotAgentsSkill: false });
    expect(resources.homeEnabled).toBe(false);

    state.setFingerprint(withSkills(fingerprint("agents-v1", "models-v1"), "global-skills-v1", "home-v1"));
    await state.live.synchronize();

    expect(state.live.generation).toBe(2);
    expect(state.live.skillPolicy).toEqual({ enableDotAgentsSkill: true });
    expect(resources.homeEnabled).toBe(true);

    state.setFingerprint(withSkills(fingerprint("agents-v1", "models-v1"), "global-skills-v1", null));
    await state.live.synchronize();

    expect(state.live.generation).toBe(3);
    expect(state.live.skillPolicy).toEqual({ enableDotAgentsSkill: false });
    expect(resources.homeEnabled).toBe(false);
    expect(topologySnapshots).toEqual([
      { enabled: true, generation: 2, policy: true },
      { enabled: false, generation: 3, policy: false },
    ]);
    expect(events.slice(1)).toEqual([
      {
        type: "config.updated",
        generation: 2,
        agentsChanged: false,
        modelsChanged: false,
        skillsChanged: true,
        runtimeChanged: true,
      },
      {
        type: "config.updated",
        generation: 3,
        agentsChanged: false,
        modelsChanged: false,
        skillsChanged: true,
        runtimeChanged: true,
      },
    ]);
  });

  it("resolves Skills with the accepted optional-home policy without leaking a rejected candidate", async () => {
    const base = tempRoot();
    const agentDir = join(base, "agent");
    const homeDir = join(base, "home");
    const project = join(base, "paper");
    const bundledSkillsDir = join(base, "bundled-skills");
    mkdirSync(join(homeDir, ".agents", "skills", "home-only"), { recursive: true });
    mkdirSync(agentDir);
    mkdirSync(project);
    mkdirSync(bundledSkillsDir);
    writeFileSync(join(homeDir, ".agents", "skills", "home-only", "SKILL.md"), "# Home only\n", "utf8");
    const acceptedCatalog = catalog("v1");
    acceptedCatalog.definitions = [{ ...definition("v1"), skills: ["home-only"] }];
    const resources = fakeResourceWatcherManager();
    const state = harness(acceptedCatalog, {
      agentDir,
      catalogOptions: { homeDir, bundledSkillsDir },
      createWatcherManager: resources.createManager,
      resolveCatalog: resolveAgentCatalog,
    });
    await state.live.start();

    await expect(state.live.resolveAgents(project)).resolves.toEqual([
      expect.objectContaining({ effectiveSkills: [], missingSkills: ["home-only"] }),
    ]);

    state.setFingerprint(withSkills(
      fingerprint("agents-v1", "models-v1"),
      "global-skills-v1",
      "home-v1",
      [],
      [{ name: "home-only", relativePath: "home-only/SKILL.md" }],
    ));
    state.setCatalog({
      definitions: [],
      diagnostics: [{ agent: "research-assistant", source: "global", message: "invalid candidate" }],
    });
    await state.live.synchronize();

    expect(state.live.skillPolicy).toEqual({ enableDotAgentsSkill: false });
    expect(state.loadCatalog.mock.calls.at(-1)?.[0].enableDotAgentsSkill).toBe(true);
    await expect(state.live.resolveAgents(project)).resolves.toEqual([
      expect.objectContaining({ effectiveSkills: [], missingSkills: ["home-only"] }),
    ]);

    state.setCatalog(acceptedCatalog);
    await state.live.synchronize();

    expect(state.live.skillPolicy).toEqual({ enableDotAgentsSkill: true });
    await expect(state.live.resolveAgents(project)).resolves.toEqual([
      expect.objectContaining({ effectiveSkills: ["home-only"], missingSkills: [] }),
    ]);
  });

  it("confirms optional-home bytes after topology installation and accepts only a concurrent delta", async () => {
    const resources = fakeResourceWatcherManager();
    const state = harness(catalog("v1"), { createWatcherManager: resources.createManager });
    const events: ConfigurationEvent[] = [];
    state.live.subscribe((event) => events.push(event));
    await state.live.start();
    resources.setTopologyHook((enabled) => {
      if (enabled) {
        state.setFingerprint(withSkills(fingerprint("agents-v1", "models-v1"), "global-skills-v1", "home-v2"));
      }
    });

    state.setFingerprint(withSkills(fingerprint("agents-v1", "models-v1"), "global-skills-v1", "home-v1"));
    await state.live.synchronize();
    await vi.waitFor(() => expect(state.live.generation).toBe(3));

    expect(events.slice(1).map((event) => event.type === "config.updated" && event.skillsChanged)).toEqual([
      true,
      true,
    ]);
  });

  it("waits for the post-topology fingerprint confirmation before synchronization settles", async () => {
    const resources = fakeResourceWatcherManager();
    const state = harness(catalog("v1"), { createWatcherManager: resources.createManager });
    await state.live.start();
    let releaseConfirmation!: (fingerprint: ConfigurationFingerprint) => void;
    const confirmation = new Promise<ConfigurationFingerprint>((resolveConfirmation) => {
      releaseConfirmation = resolveConfirmation;
    });
    const enabled = withSkills(fingerprint("agents-v1", "models-v1"), "global-skills-v1", "home-v1");
    let confirmationStarted = false;
    resources.setTopologyHook(() => {
      state.readFingerprint.mockImplementationOnce(async () => {
        confirmationStarted = true;
        return confirmation;
      });
    });
    state.setFingerprint(enabled);
    let settled = false;

    const synchronizing = state.live.synchronize().then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(confirmationStarted).toBe(true));

    expect(settled).toBe(false);
    releaseConfirmation(enabled);
    await synchronizing;
    expect(state.live.generation).toBe(2);
  });

  it("retries failed watcher startup from unchanged accepted state without creating a generation", async () => {
    const resources = fakeResourceWatcherManager();
    resources.failNextStart(new Error("watch startup failed at /home/private WATCH_SECRET"));
    const state = harness(catalog("v1"), { createWatcherManager: resources.createManager });
    const events: ConfigurationEvent[] = [];
    state.live.subscribe((event) => events.push(event));

    await state.live.start();

    expect(resources.startCalls).toBe(2);
    expect(state.live.generation).toBe(1);
    expect(state.live.error).toMatch(/monitoring/i);
    expect(JSON.stringify(events)).not.toContain("/home/private");
    expect(JSON.stringify(events)).not.toContain("WATCH_SECRET");

    await state.live.synchronize();

    expect(resources.startCalls).toBe(2);
    expect(state.live.generation).toBe(1);
  });

  it("baselines project acquisition and reacquisition without a generation and coalesces one owned delta", async () => {
    const resources = fakeResourceWatcherManager();
    const state = harness(catalog("v1"), { createWatcherManager: resources.createManager });
    const events: ConfigurationEvent[] = [];
    const project = resolve("/projects/paper");
    resources.setProjectValue(project, "project-v1");
    state.live.subscribe((event) => events.push(event));
    await state.live.start();

    const first = await state.live.acquireProject(project);
    await state.live.synchronize({ projectCwds: [project] });
    expect(state.live.generation).toBe(1);

    resources.setProjectValue(project, "project-v2");
    resources.emitChange({ skillsChanged: true, projectCwds: [project] });
    await Promise.all([
      state.live.synchronize({ projectCwds: [project] }),
      state.live.synchronize({ projectCwds: [project, project] }),
    ]);

    expect(state.live.generation).toBe(2);
    expect(events.slice(1)).toEqual([
      {
        type: "config.updated",
        generation: 2,
        agentsChanged: false,
        modelsChanged: false,
        skillsChanged: true,
        runtimeChanged: true,
      },
    ]);

    await first.release();
    resources.setProjectValue(project, "project-v3");
    const reacquired = await state.live.acquireProject(project);
    await state.live.synchronize({ projectCwds: [project] });
    expect(state.live.generation).toBe(2);
    await reacquired.release();
  });

  it("rolls back pending global and project Skill state on invalid Agent bytes and commits it once on repair", async () => {
    const resources = fakeResourceWatcherManager();
    const state = harness(catalog("v1"), { createWatcherManager: resources.createManager });
    const events: ConfigurationEvent[] = [];
    const project = resolve("/projects/transaction-paper");
    resources.setProjectValue(project, "project-v1");
    state.live.subscribe((event) => events.push(event));
    await state.live.start();
    const registration = await state.live.acquireProject(project);

    resources.setProjectValue(project, "project-v2");
    state.setFingerprint(withSkills(fingerprint("agents-v2", "models-v1"), "global-skills-v2"));
    state.setCatalog({
      definitions: [],
      diagnostics: [{ agent: "research-assistant", source: "global", message: "SECRET invalid Agent" }],
    });
    await state.live.notify({
      agentsChanged: true,
      skillsChanged: true,
      projectCwds: [project],
    });

    expect(state.live.generation).toBe(1);
    expect(resources.transactions.at(-1)?.state).toBe("rolled-back");

    state.setCatalog(catalog("v2"));
    await state.live.synchronize();

    expect(state.live.generation).toBe(2);
    expect(events.at(-1)).toEqual({
      type: "config.updated",
      generation: 2,
      availabilityEpoch: 2,
      availabilityChanged: true,
      agentsChanged: true,
      modelsChanged: false,
      skillsChanged: true,
      runtimeChanged: true,
    });
    expect(resources.transactions.at(-1)?.state).toBe("committed");

    await state.live.synchronize({ projectCwds: [project] });
    expect(state.live.generation).toBe(2);
    expect(state.live.error).toBeNull();
    await registration.release();
  });

  it("rolls back a raced project candidate before preparing and committing the confirmed bytes", async () => {
    const resources = fakeResourceWatcherManager();
    const state = harness(catalog("v1"), { createWatcherManager: resources.createManager });
    const project = resolve("/projects/raced-paper");
    resources.setProjectValue(project, "project-v1");
    await state.live.start();
    const registration = await state.live.acquireProject(project);

    resources.setProjectValue(project, "project-v2");
    state.setCatalog(catalog("v2"));
    const firstCandidate = fingerprint("agents-v2", "models-v1");
    const confirmedCandidate = fingerprint("agents-v3", "models-v1");
    state.setFingerprint(confirmedCandidate);
    state.readFingerprint
      .mockResolvedValueOnce(firstCandidate)
      .mockImplementationOnce(async () => {
        resources.setProjectValue(project, "project-v3");
        return confirmedCandidate;
      });

    await state.live.synchronize({ projectCwds: [project] });

    expect(state.live.generation).toBe(2);
    expect(state.live.error).toBeNull();
    expect(resources.transactions.slice(-2).map((transaction) => transaction.state)).toEqual([
      "rolled-back",
      "committed",
    ]);
    await state.live.synchronize({ projectCwds: [project] });
    expect(state.live.generation).toBe(2);
    await registration.release();
  });

  it("accepts malformed Skill descriptor bytes through the watcher without host syntax validation", async () => {
    const base = tempRoot();
    const agentDir = join(base, "agent");
    const homeDir = join(base, "home");
    const descriptor = join(agentDir, "skills", "custom", "SKILL.md");
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    mkdirSync(join(descriptor, ".."), { recursive: true });
    mkdirSync(homeDir);
    writeFileSync(join(agentDir, "models.json"), "{}", "utf8");
    writeFileSync(descriptor, "---\nname: valid\n---\n# Valid\n", "utf8");
    const resources = fakeResourceWatcherManager();
    const events: ConfigurationEvent[] = [];
    const live = createLiveConfiguration({
      agentDir,
      catalogOptions: { homeDir },
      modelValidator: {
        async prepareModelCatalog() {
          return {
            registeredModels: [modelOption("provider/v1")],
            availableModels: [modelOption("provider/v1")],
            commit() {},
            rollback() {},
          };
        },
        currentAvailableModels: () => [modelOption("provider/v1")],
      },
      loadCatalog: async () => catalog("v1"),
      resolveCatalog: resolvedAgents,
      createWatcherManager: resources.createManager,
    });
    live.subscribe((event) => events.push(event));
    await live.start();

    writeFileSync(descriptor, "---\nname: [\n---\n# Pi owns this diagnostic\n", "utf8");
    resources.emitChange({ skillsChanged: true });
    await vi.waitFor(() => expect(live.generation).toBe(2));

    expect(events.at(-1)).toEqual({
      type: "config.updated",
      generation: 2,
      agentsChanged: false,
      modelsChanged: false,
      skillsChanged: true,
      runtimeChanged: true,
    });
    await live.close();
  });

  it("redacts project fingerprint and acquisition bound failures without committing their baselines", async () => {
    const resources = fakeResourceWatcherManager();
    const state = harness(catalog("v1"), { createWatcherManager: resources.createManager });
    const events: ConfigurationEvent[] = [];
    const project = resolve("/projects/bounded-paper");
    resources.setProjectValue(project, "project-v1");
    state.live.subscribe((event) => events.push(event));
    await state.live.start();
    const registration = await state.live.acquireProject(project);
    resources.setProjectValue(project, "project-v2");
    resources.failNextPrepare(new Error("descriptor limit at /home/private API_KEY=BOUND_SECRET"));

    await state.live.synchronize({ projectCwds: [project] });

    expect(state.live.generation).toBe(1);
    expect(JSON.stringify({ error: state.live.error, events })).not.toContain("/home/private");
    expect(JSON.stringify({ error: state.live.error, events })).not.toContain("BOUND_SECRET");

    await state.live.synchronize();
    expect(state.live.generation).toBe(2);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: "config.updated",
      skillsChanged: true,
      runtimeChanged: true,
    }));
    await registration.release();

    resources.failNextAcquire(new Error("depth bound at /home/private ACQUIRE_SECRET"));
    const acquisitionError = await state.live.acquireProject("/projects/rejected-paper").catch((error) => error);
    expect(acquisitionError).toBeInstanceOf(Error);
    expect(acquisitionError.message).toMatch(/configuration|monitoring/i);
    expect(acquisitionError.message).not.toContain("/home/private");
    expect(acquisitionError.message).not.toContain("ACQUIRE_SECRET");
  });

  it("releases and rejects a deferred project acquisition when close wins", async () => {
    const resources = fakeResourceWatcherManager();
    const deferred = resources.deferNextAcquire();
    const state = harness(catalog("v1"), { createWatcherManager: resources.createManager });
    const events: ConfigurationEvent[] = [];
    const project = resolve("/projects/deferred-close-paper");
    let releases = 0;
    state.live.subscribe((event) => events.push(event));
    await state.live.start();
    const acceptedError = state.live.error;
    const acceptedGeneration = state.live.generation;
    const acceptedEventCount = events.length;

    const acquiring = state.live.acquireProject(project);
    await vi.waitFor(() => expect(deferred.started()).toBe(true));
    const closing = state.live.close();
    deferred.resolve({
      cwd: project,
      async release() {
        releases += 1;
      },
    });
    const acquisitionResult = await acquiring.catch((error) => error);
    await closing;

    expect(acquisitionResult).toBeInstanceOf(Error);
    expect(acquisitionResult.message).toMatch(/monitoring/i);
    expect(releases).toBe(1);
    expect(state.live.generation).toBe(acceptedGeneration);
    expect(state.live.error).toBe(acceptedError);
    expect(events).toHaveLength(acceptedEventCount);
  });

  it("rolls back a prepared project transaction and ignores every manager callback after close", async () => {
    const resources = fakeResourceWatcherManager();
    const state = harness(catalog("v1"), { createWatcherManager: resources.createManager });
    const events: ConfigurationEvent[] = [];
    const project = resolve("/projects/closing-paper");
    resources.setProjectValue(project, "project-v1");
    state.live.subscribe((event) => events.push(event));
    await state.live.start();
    await state.live.acquireProject(project);
    resources.setProjectValue(project, "project-v2");

    type PreparedCandidate = ReturnType<typeof state.prepareCandidate>;
    let releaseValidation!: (candidate: PreparedCandidate) => void;
    const validationGate = new Promise<PreparedCandidate>((resolveCandidate) => {
      releaseValidation = resolveCandidate;
    });
    state.prepareModels.mockImplementationOnce(async () => validationGate);
    const synchronizing = state.live.synchronize({ projectCwds: [project] });
    await vi.waitFor(() => expect(state.prepareModels).toHaveBeenCalledTimes(2));
    const closing = state.live.close();
    releaseValidation(state.prepareCandidate(["provider/v1"]));
    await Promise.all([synchronizing, closing]);

    expect(resources.transactions.at(-1)?.state).toBe("rolled-back");
    const acceptedError = state.live.error;
    const acceptedEventCount = events.length;
    state.setFingerprint(fingerprint("agents-v2", "models-v2"));
    resources.emitChange({ agentsChanged: true, skillsChanged: true, projectCwds: [project] });
    resources.emitError();
    await state.live.synchronize({ projectCwds: [project] });
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));

    expect(resources.closeAttempts).toBe(1);
    expect(state.live.generation).toBe(1);
    expect(state.live.error).toBe(acceptedError);
    expect(events).toHaveLength(acceptedEventCount);
  });

  it("ignores a fingerprint rejection after close wins the active transaction", async () => {
    const resources = fakeResourceWatcherManager();
    const state = harness(catalog("v1"), { createWatcherManager: resources.createManager });
    const events: ConfigurationEvent[] = [];
    state.live.subscribe((event) => events.push(event));
    await state.live.start();
    let rejectFingerprint!: (error: Error) => void;
    let fingerprintStarted = false;
    const fingerprintGate = new Promise<ConfigurationFingerprint>((_resolveFingerprint, rejectCandidate) => {
      rejectFingerprint = rejectCandidate;
    });
    state.readFingerprint.mockImplementationOnce(async () => {
      fingerprintStarted = true;
      return fingerprintGate;
    });

    const synchronizing = state.live.synchronize();
    await vi.waitFor(() => expect(fingerprintStarted).toBe(true));
    const closing = state.live.close();
    rejectFingerprint(new Error("late fingerprint failure at /home/private CLOSE_SECRET"));
    await Promise.all([synchronizing, closing]);

    expect(state.live.generation).toBe(1);
    expect(state.live.error).toBeNull();
    expect(events).toHaveLength(1);
    expect(resources.transactions.at(-1)?.state).toBe("rolled-back");
  });
});

describe("live configuration watcher and close", () => {
  it("performs a final synchronization after watcher readiness before start resolves", async () => {
    const state = harness(catalog("v1"), { autoReady: false });
    const starting = state.live.start();
    await vi.waitFor(() => expect(state.live.generation).toBe(1));

    state.setCatalog(catalog("v2"));
    state.setFingerprint(fingerprint("agents-v2", "models-v2"));
    state.watcher.ready();
    await starting;

    expect(state.live.generation).toBe(2);
    await expect(state.live.resolveAgents("/paper")).resolves.toEqual([
      expect.objectContaining({ model: "provider/v2", systemPrompt: "Prompt v2" }),
    ]);
  });

  it("starts one stable-anchor resource watcher and filters every unrelated event", async () => {
    const state = harness();

    await Promise.all([state.live.start(), state.live.start(), state.live.start()]);

    expect(state.watcher.watch).toHaveBeenCalledTimes(1);
    expect(state.watcher.watch).toHaveBeenCalledWith(
      ["/global"],
      expect.objectContaining({
        ignoreInitial: true,
        depth: 18,
        followSymlinks: false,
        atomic: true,
        awaitWriteFinish: expect.objectContaining({ stabilityThreshold: 200 }),
      }),
    );

    state.watcher.emit("change", "/project/.easyresearch/agents/search.md");
    state.watcher.emit("change", "/global/auth.json");
    state.watcher.emit("change", "/global/sessions/session.jsonl");
    state.watcher.emit("change", "/global/agents/nested/ignored.md");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.loadCatalog).toHaveBeenCalledTimes(1);

    state.setFingerprint(fingerprint("agents-v2", "models-v1"));
    state.setCatalog(catalog("v2"));
    state.watcher.emit("change", "/global/agents/search.md");
    await vi.waitFor(() => expect(state.live.generation).toBe(2));

    state.setFingerprint(fingerprint("agents-v2", "models-v2"));
    state.watcher.emit("change", "/global/models.json");
    await vi.waitFor(() => expect(state.live.generation).toBe(3));

    state.setCatalog(catalog("settings-v3"));
    state.setFingerprint(fingerprint("agents-v2", "models-v2", "defaults-v2"));
    state.watcher.emit("change", "/global/settings.json");
    await vi.waitFor(() => expect(state.live.generation).toBe(4));
    await expect(state.live.resolveAgents("/paper")).resolves.toEqual([
      expect.objectContaining({ model: "provider/settings-v3" }),
    ]);
  });

  it("keeps a redacted watcher startup failure visible while direct synchronization remains usable", async () => {
    const events: ConfigurationEvent[] = [];
    const state = harness(catalog("v1"), {
      watch: (() => {
        throw new Error("watch failed at /home/private API_KEY=WATCHER_SECRET");
      }) as ConfigurationWatchImplementation,
    });
    state.live.subscribe((event) => events.push(event));

    await state.live.start();

    expect(state.live.generation).toBe(1);
    expect(state.live.error).toMatch(/monitoring/i);
    expect(state.live.isCurrent(1)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("/home/private");
    expect(JSON.stringify(events)).not.toContain("WATCHER_SECRET");

    state.setCatalog(catalog("v2"));
    state.setFingerprint(fingerprint("agents-v2", "models-v2"));
    await state.live.synchronize();

    expect(state.live.generation).toBe(2);
    expect(state.live.error).toMatch(/monitoring/i);
    await expect(state.live.resolveAgents("/paper")).resolves.toEqual([
      expect.objectContaining({ model: "provider/v2" }),
    ]);
  });

  it("closes its watcher once and ignores watcher or direct synchronization after close", async () => {
    const state = harness();
    await state.live.start();

    await Promise.all([state.live.close(), state.live.close(), state.live.close()]);
    state.setFingerprint(fingerprint("agents-v2", "models-v2"));
    state.setCatalog(catalog("v2"));
    state.watcher.emit("change", "/global/models.json");
    await state.live.synchronize();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.watcher.close).toHaveBeenCalledTimes(1);
    expect(state.loadCatalog).toHaveBeenCalledTimes(1);
    expect(state.live.generation).toBe(1);
    expect(state.live.isCurrent(1)).toBe(false);
  });

  it("coalesces concurrent close callers, retries a failed watcher close, and keeps successful cleanup one-shot", async () => {
    const state = harness();
    await state.live.start();
    state.watcher.close
      .mockRejectedValueOnce(new Error("watcher close failed"))
      .mockResolvedValueOnce(undefined);

    const first = await Promise.allSettled([
      state.live.close(),
      state.live.close(),
      state.live.close(),
    ]);

    expect(first.map(({ status }) => status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(state.watcher.close).toHaveBeenCalledTimes(1);

    await Promise.all([state.live.close(), state.live.close()]);
    expect(state.watcher.close).toHaveBeenCalledTimes(2);

    await state.live.close();
    expect(state.watcher.close).toHaveBeenCalledTimes(2);
  });

  it("settles start and queued waiters without publishing when close wins an active validation race", async () => {
    const state = harness();
    const events: ConfigurationEvent[] = [];
    state.live.subscribe((event) => events.push(event));
    type PreparedCandidate = ReturnType<typeof state.prepareCandidate>;
    let releaseValidation!: (candidate: PreparedCandidate) => void;
    const validationGate = new Promise<PreparedCandidate>((resolve) => {
      releaseValidation = resolve;
    });
    state.prepareModels.mockImplementationOnce(async () => validationGate);

    const starting = state.live.start();
    await vi.waitFor(() => expect(state.prepareModels).toHaveBeenCalledTimes(1));
    let queuedSettled = false;
    const queued = state.live.notify({ modelsChanged: true, force: true }).then(() => {
      queuedSettled = true;
    });
    const closing = state.live.close();

    await vi.waitFor(() => expect(queuedSettled).toBe(true));
    const closingCandidate = state.prepareCandidate(["provider/v1"]);
    releaseValidation(closingCandidate);
    await Promise.all([starting, queued, closing]);

    expect(state.acceptedModels()).toEqual([]);
    expect(closingCandidate.commit).not.toHaveBeenCalled();
    expect(closingCandidate.rollback).toHaveBeenCalledTimes(1);
    expect(state.live.generation).toBe(0);
    expect(events).toEqual([]);
  });
});

describe("real filesystem configuration acceptance", () => {
  it.each([
    {
      operation: "first add under an absent Agent root",
      prepare: undefined,
      mutate(agentDir: string, target: string) {
        mkdirSync(join(agentDir, "agents"));
        writeFileSync(target, agentMarkdown("watch-reviewer", "V2"), "utf8");
      },
      expectedMarker: "ROLE_V2",
    },
    {
      operation: "same-size Agent change",
      prepare(agentDir: string, target: string) {
        mkdirSync(join(agentDir, "agents"));
        writeFileSync(target, agentMarkdown("watch-reviewer", "V1"), "utf8");
      },
      mutate(_agentDir: string, target: string) {
        writeFileSync(target, agentMarkdown("watch-reviewer", "V2"), "utf8");
      },
      expectedMarker: "ROLE_V2",
    },
    {
      operation: "Agent unlink",
      prepare(agentDir: string, target: string) {
        mkdirSync(join(agentDir, "agents"));
        writeFileSync(target, agentMarkdown("watch-reviewer", "V1"), "utf8");
      },
      mutate(_agentDir: string, target: string) {
        unlinkSync(target);
      },
      expectedMarker: undefined,
    },
    {
      operation: "atomic Agent replacement",
      prepare(agentDir: string, target: string) {
        mkdirSync(join(agentDir, "agents"));
        writeFileSync(target, agentMarkdown("watch-reviewer", "V1"), "utf8");
      },
      mutate(agentDir: string, target: string) {
        const replacement = join(agentDir, "watch-reviewer.next");
        writeFileSync(replacement, agentMarkdown("watch-reviewer", "V2"), "utf8");
        renameSync(replacement, target);
      },
      expectedMarker: "ROLE_V2",
    },
  ])("accepts $operation without another filesystem trigger", async ({ prepare, mutate, expectedMarker }) => {
    const state = await startRealConfiguration({
      prepare: ({ agentDir }) => {
        const target = join(agentDir, "agents", "watch-reviewer.md");
        prepare?.(agentDir, target);
      },
    });
    const baseline = state.live.generation;
    const baselineUpdates = configurationUpdates(state.events).length;
    const target = join(state.agentDir, "agents", "watch-reviewer.md");

    mutate(state.agentDir, target);
    await waitForGeneration(state.live, baseline + 1);

    const reviewer = (await state.live.resolveAgents(state.project))
      .find((agent) => agent.name === "watch-reviewer");
    if (expectedMarker === undefined) expect(reviewer).toBeUndefined();
    else expect(reviewer?.systemPrompt).toContain(expectedMarker);
    expect(configurationUpdates(state.events)).toHaveLength(baselineUpdates + 1);
    expect(configurationUpdates(state.events).at(-1)).toMatchObject({
      agentsChanged: true,
      runtimeChanged: true,
    });
  }, 15_000);

  it("accepts the first global Skill descriptor when the whole Skill root was absent", async () => {
    const skillName = "watch-global-skill";
    const state = await startRealConfiguration({
      prepare: ({ agentDir }) => {
        mkdirSync(join(agentDir, "agents"));
        writeFileSync(
          join(agentDir, "agents", "skill-consumer.md"),
          agentMarkdown("skill-consumer", "GLOBAL", [skillName]),
          "utf8",
        );
      },
    });
    const baseline = state.live.generation;
    const before = (await state.live.resolveAgents(state.project)).find((agent) => agent.name === "skill-consumer");
    expect(before).toMatchObject({ effectiveSkills: [], missingSkills: [skillName] });

    const descriptor = join(state.agentDir, "skills", skillName, "SKILL.md");
    mkdirSync(join(descriptor, ".."), { recursive: true });
    writeFileSync(descriptor, skillMarkdown(skillName, "GLOBAL_SKILL_V1"), "utf8");
    await waitForGeneration(state.live, baseline + 1);

    const after = (await state.live.resolveAgents(state.project)).find((agent) => agent.name === "skill-consumer");
    expect(after).toMatchObject({ effectiveSkills: [skillName], missingSkills: [] });
    expect(after?.effectiveSkillPaths).toEqual([acceptedSkillPath()]);
    expect(configurationUpdates(state.events).at(-1)).toMatchObject({
      agentsChanged: false,
      skillsChanged: true,
      runtimeChanged: true,
    });
  }, 15_000);

  it.each([
    {
      operation: "same-size global Skill change",
      mutate(descriptor: string, _agentDir: string) {
        writeFileSync(descriptor, skillMarkdown("watch-global-mutation", "GLOBAL_SKILL_V2"), "utf8");
      },
      present: true,
    },
    {
      operation: "global Skill unlink",
      mutate(descriptor: string, _agentDir: string) {
        unlinkSync(descriptor);
      },
      present: false,
    },
    {
      operation: "atomic global Skill replacement",
      mutate(descriptor: string, agentDir: string) {
        const replacement = join(agentDir, "watch-global-mutation.next");
        writeFileSync(replacement, skillMarkdown("watch-global-mutation", "GLOBAL_SKILL_V2"), "utf8");
        renameSync(replacement, descriptor);
      },
      present: true,
    },
  ])("accepts $operation without another filesystem trigger", async ({ mutate, present }) => {
    const skillName = "watch-global-mutation";
    const state = await startRealConfiguration({
      prepare: ({ agentDir }) => {
        const agentPath = join(agentDir, "agents", "global-mutation-consumer.md");
        const descriptor = join(agentDir, "skills", skillName, "SKILL.md");
        mkdirSync(join(agentPath, ".."), { recursive: true });
        mkdirSync(join(descriptor, ".."), { recursive: true });
        writeFileSync(
          agentPath,
          agentMarkdown("global-mutation-consumer", "GLOBAL_MUTATION", [skillName]),
          "utf8",
        );
        writeFileSync(descriptor, skillMarkdown(skillName, "GLOBAL_SKILL_V1"), "utf8");
      },
    });
    const baseline = state.live.generation;
    const baselineUpdates = configurationUpdates(state.events).length;
    const descriptor = join(state.agentDir, "skills", skillName, "SKILL.md");

    mutate(descriptor, state.agentDir);
    await waitForGeneration(state.live, baseline + 1);

    const consumer = (await state.live.resolveAgents(state.project))
      .find((agent) => agent.name === "global-mutation-consumer");
    if (present) {
      expect(consumer).toMatchObject({ effectiveSkills: [skillName], missingSkills: [] });
    } else {
      expect(consumer).toMatchObject({ effectiveSkills: [], missingSkills: [skillName] });
    }
    expect(configurationUpdates(state.events)).toHaveLength(baselineUpdates + 1);
    expect(configurationUpdates(state.events).at(-1)).toMatchObject({
      agentsChanged: false,
      skillsChanged: true,
      runtimeChanged: true,
    });
  }, 15_000);

  it("observes the first optional-home Skill only after an external policy enable", async () => {
    const skillName = "watch-home-skill";
    const state = await startRealConfiguration({
      prepare: ({ agentDir, homeDir }) => {
        mkdirSync(join(agentDir, "agents"));
        writeFileSync(
          join(agentDir, "agents", "home-consumer.md"),
          agentMarkdown("home-consumer", "HOME", [skillName]),
          "utf8",
        );
        const descriptor = join(homeDir, ".agents", "skills", skillName, "SKILL.md");
        mkdirSync(join(descriptor, ".."), { recursive: true });
        writeFileSync(descriptor, skillMarkdown(skillName, "HOME_SKILL_V1"), "utf8");
      },
    });
    const baseline = state.live.generation;
    expect(state.live.skillPolicy).toEqual({ enableDotAgentsSkill: false });

    writeFileSync(
      join(state.agentDir, "settings.json"),
      JSON.stringify({ easyresearch: { enable_dot_agents_skill: true } }),
      "utf8",
    );
    await waitForGeneration(state.live, baseline + 1);

    expect(state.live.skillPolicy).toEqual({ enableDotAgentsSkill: true });
    const consumer = (await state.live.resolveAgents(state.project)).find((agent) => agent.name === "home-consumer");
    expect(consumer?.effectiveSkillPaths).toEqual([acceptedSkillPath()]);
    expect(configurationUpdates(state.events).at(-1)).toMatchObject({
      agentsChanged: false,
      skillsChanged: true,
      runtimeChanged: true,
    });
  }, 15_000);

  it("removes optional-home Skills after an external policy disable", async () => {
    const skillName = "watch-home-disable";
    const state = await startRealConfiguration({
      prepare: ({ agentDir, homeDir }) => {
        mkdirSync(join(agentDir, "agents"));
        writeFileSync(
          join(agentDir, "agents", "home-disable-consumer.md"),
          agentMarkdown("home-disable-consumer", "HOME_DISABLE", [skillName]),
          "utf8",
        );
        writeFileSync(
          join(agentDir, "settings.json"),
          JSON.stringify({ easyresearch: { enable_dot_agents_skill: true } }),
          "utf8",
        );
        const descriptor = join(homeDir, ".agents", "skills", skillName, "SKILL.md");
        mkdirSync(join(descriptor, ".."), { recursive: true });
        writeFileSync(descriptor, skillMarkdown(skillName, "HOME_DISABLE_V1"), "utf8");
      },
    });
    const baseline = state.live.generation;
    expect(state.live.skillPolicy).toEqual({ enableDotAgentsSkill: true });

    writeFileSync(
      join(state.agentDir, "settings.json"),
      JSON.stringify({ easyresearch: { enable_dot_agents_skill: false } }),
      "utf8",
    );
    await waitForGeneration(state.live, baseline + 1);

    expect(state.live.skillPolicy).toEqual({ enableDotAgentsSkill: false });
    const consumer = (await state.live.resolveAgents(state.project))
      .find((agent) => agent.name === "home-disable-consumer");
    expect(consumer).toMatchObject({ effectiveSkills: [], missingSkills: [skillName] });
  }, 15_000);

  it("watches first descriptor creation below absent optional-home directories", async () => {
    const skillName = "watch-home-first";
    const state = await startRealConfiguration({
      prepare: ({ agentDir }) => {
        mkdirSync(join(agentDir, "agents"));
        writeFileSync(
          join(agentDir, "agents", "home-first-consumer.md"),
          agentMarkdown("home-first-consumer", "HOME_FIRST", [skillName]),
          "utf8",
        );
        writeFileSync(
          join(agentDir, "settings.json"),
          JSON.stringify({ easyresearch: { enable_dot_agents_skill: true } }),
          "utf8",
        );
      },
    });
    const baseline = state.live.generation;
    const descriptor = join(state.homeDir, ".agents", "skills", skillName, "SKILL.md");

    mkdirSync(join(descriptor, ".."), { recursive: true });
    writeFileSync(descriptor, skillMarkdown(skillName, "HOME_FIRST_V1"), "utf8");
    await waitForGeneration(state.live, baseline + 1);

    const consumer = (await state.live.resolveAgents(state.project))
      .find((agent) => agent.name === "home-first-consumer");
    expect(consumer?.effectiveSkillPaths).toEqual([acceptedSkillPath()]);
  }, 15_000);

  it("accepts first project Skill creation from an owned exact-cwd anchor", async () => {
    const skillName = "watch-project-skill";
    const state = await startRealConfiguration({
      prepare: ({ agentDir }) => {
        mkdirSync(join(agentDir, "agents"));
        writeFileSync(
          join(agentDir, "agents", "project-consumer.md"),
          agentMarkdown("project-consumer", "PROJECT", [skillName]),
          "utf8",
        );
      },
    });
    const registration = await state.live.acquireProject(state.project);
    const baseline = state.live.generation;
    try {
      const descriptor = join(state.project, ".easyresearch", "skills", skillName, "SKILL.md");
      mkdirSync(join(descriptor, ".."), { recursive: true });
      writeFileSync(descriptor, skillMarkdown(skillName, "PROJECT_SKILL_V1"), "utf8");
      await waitForGeneration(state.live, baseline + 1);

      const consumer = (await state.live.resolveAgents(state.project))
        .find((agent) => agent.name === "project-consumer");
      expect(consumer?.effectiveSkillPaths).toEqual([acceptedSkillPath()]);
      expect(configurationUpdates(state.events).at(-1)).toMatchObject({
        agentsChanged: false,
        skillsChanged: true,
        runtimeChanged: true,
      });
    } finally {
      await registration.release();
    }
  }, 15_000);

  it("re-baselines project bytes changed after release when the exact cwd is reacquired", async () => {
    const skillName = "watch-project-reacquire";
    const state = await startRealConfiguration({
      prepare: ({ agentDir }) => {
        mkdirSync(join(agentDir, "agents"));
        writeFileSync(
          join(agentDir, "agents", "project-reacquire-consumer.md"),
          agentMarkdown("project-reacquire-consumer", "PROJECT_REACQUIRE", [skillName]),
          "utf8",
        );
      },
    });
    const baseline = state.live.generation;
    const first = await state.live.acquireProject(state.project);
    await first.release();

    const descriptor = join(state.project, ".easyresearch", "skills", skillName, "SKILL.md");
    mkdirSync(join(descriptor, ".."), { recursive: true });
    writeFileSync(descriptor, skillMarkdown(skillName, "PROJECT_UNOWNED_V1"), "utf8");
    const second = await state.live.acquireProject(state.project);
    try {
      expect(state.live.generation).toBe(baseline);
      const consumer = (await state.live.resolveAgents(state.project))
        .find((agent) => agent.name === "project-reacquire-consumer");
      expect(consumer?.effectiveSkillPaths).toEqual([acceptedSkillPath()]);
      expect(configurationUpdates(state.events)).toHaveLength(1);
    } finally {
      await second.release();
    }
  }, 15_000);

  it.each([
    { scope: "global", mutation: "add" },
    { scope: "global", mutation: "remove" },
    { scope: "home", mutation: "add" },
    { scope: "home", mutation: "remove" },
    { scope: "project", mutation: "add" },
    { scope: "project", mutation: "remove" },
  ] as const)(
    "isolates a broken Agent while accepting an independent $scope Skill $mutation",
    async ({ scope, mutation }) => {
      const agentName = `accepted-${scope}-${mutation}`;
      const skillName = `accepted-skill-${scope}-${mutation}`;
      let descriptor = "";
      const state = await startRealConfiguration({
        watch: droppedConfigurationWatch(),
        prepare: ({ agentDir, homeDir, project }) => {
          const agentPath = join(agentDir, "agents", `${agentName}.md`);
          mkdirSync(join(agentPath, ".."), { recursive: true });
          writeFileSync(agentPath, agentMarkdown(agentName, "ACCEPTED", [skillName]), "utf8");
          if (scope === "home") {
            writeFileSync(
              join(agentDir, "settings.json"),
              JSON.stringify({ easyresearch: { enable_dot_agents_skill: true } }),
              "utf8",
            );
          }
          const skillRoot = scope === "global"
            ? join(agentDir, "skills")
            : scope === "home"
              ? join(homeDir, ".agents", "skills")
              : join(project, ".easyresearch", "skills");
          descriptor = join(skillRoot, skillName, "SKILL.md");
          if (mutation === "remove") {
            mkdirSync(join(descriptor, ".."), { recursive: true });
            writeFileSync(descriptor, skillMarkdown(skillName, "ACCEPTED_SKILL"), "utf8");
          }
        },
      });
      const registration = scope === "project" ? await state.live.acquireProject(state.project) : undefined;
      const agentPath = join(state.agentDir, "agents", `${agentName}.md`);
      const baselineGeneration = state.live.generation;
      try {
        const before = (await state.live.resolveAgents(state.project)).find((agent) => agent.name === agentName);
        expect(before).toMatchObject(
          mutation === "add"
            ? { effectiveSkills: [], effectiveSkillPaths: [], missingSkills: [skillName] }
            : { effectiveSkills: [skillName], effectiveSkillPaths: [acceptedSkillPath()], missingSkills: [] },
        );

        writeFileSync(agentPath, "---\nname: [\n---\nBROKEN_HOST\n", "utf8");
        if (mutation === "add") {
          mkdirSync(join(descriptor, ".."), { recursive: true });
          writeFileSync(descriptor, skillMarkdown(skillName, "PENDING_SKILL"), "utf8");
        } else {
          unlinkSync(descriptor);
        }
        await state.live.synchronize(
          scope === "project" ? { projectCwds: [state.project] } : undefined,
        );

        expect(state.live.generation).toBe(baselineGeneration + 1);
        expect(state.live.error).toMatch(/configuration/i);
        const blocked = (await state.live.resolveAgents(state.project)).find((agent) => agent.name === agentName);
        expect(blocked).toBeUndefined();

        writeFileSync(agentPath, agentMarkdown(agentName, "REPAIRED", [skillName]), "utf8");
        await state.live.synchronize(
          scope === "project" ? { projectCwds: [state.project] } : undefined,
        );

        expect(state.live.generation).toBe(baselineGeneration + 2);
        const repaired = (await state.live.resolveAgents(state.project)).find((agent) => agent.name === agentName);
        expect(repaired).toMatchObject(
          mutation === "add"
            ? { effectiveSkills: [skillName], effectiveSkillPaths: [acceptedSkillPath()], missingSkills: [] }
            : { effectiveSkills: [], effectiveSkillPaths: [], missingSkills: [skillName] },
        );
      } finally {
        await registration?.release();
      }
    },
    20_000,
  );

  it("accepts changed Skill bytes while isolating a malformed Agent, then restores the Agent", async () => {
    const agentName = "watch-transaction-reviewer";
    const skillName = "watch-transaction-skill";
    const state = await startRealConfiguration({
      prepare: ({ agentDir }) => {
        const agentPath = join(agentDir, "agents", `${agentName}.md`);
        const skillPath = join(agentDir, "skills", skillName, "SKILL.md");
        mkdirSync(join(agentPath, ".."), { recursive: true });
        mkdirSync(join(skillPath, ".."), { recursive: true });
        writeFileSync(agentPath, agentMarkdown(agentName, "TX_V1", [skillName]), "utf8");
        writeFileSync(skillPath, skillMarkdown(skillName, "TX_SKILL_V1"), "utf8");
      },
    });
    const baseline = state.live.generation;
    const baselineUpdates = configurationUpdates(state.events).length;
    const agentPath = join(state.agentDir, "agents", `${agentName}.md`);
    const skillPath = join(state.agentDir, "skills", skillName, "SKILL.md");

    writeFileSync(agentPath, "---\nname: [\n---\nBROKEN_HOST\n", "utf8");
    writeFileSync(skillPath, skillMarkdown(skillName, "TX_SKILL_V2"), "utf8");
    await vi.waitFor(() => expect(state.live.error).toMatch(/configuration/i), {
      timeout: 10_000,
      interval: 20,
    });
    expect(state.live.generation).toBe(baseline + 1);
    expect((await state.live.resolveAgents()).find((agent) => agent.name === agentName)).toBeUndefined();

    writeFileSync(agentPath, agentMarkdown(agentName, "TX_V2", [skillName]), "utf8");
    await waitForGeneration(state.live, baseline + 2);

    expect(state.live.error).toBeNull();
    expect(configurationUpdates(state.events)).toHaveLength(baselineUpdates + 2);
    expect(configurationUpdates(state.events).at(-1)).toMatchObject({
      agentsChanged: true,
      skillsChanged: false,
      runtimeChanged: true,
    });
    const reviewer = (await state.live.resolveAgents(state.project)).find((agent) => agent.name === agentName);
    expect(reviewer?.systemPrompt).toContain("ROLE_TX_V2");
  }, 20_000);
});

describe("missed watcher event recovery", () => {
  it("lets the runtime safe-boundary synchronization accept one combined Agent and project-Skill generation", async () => {
    const skillName = "dropped-event-skill";
    const state = await startRealConfiguration({ watch: droppedConfigurationWatch() });
    const automaticModel = {
      provider: "test-provider",
      id: "test-model",
      name: "Test Model",
      api: "test-api",
      baseUrl: "http://localhost.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 2_048,
    } as Model<any>;
    const runtimeModel = {
      async refresh() {},
      getModel: () => undefined,
      getAvailableSnapshot: () => [],
      getProvider: () => undefined,
      getProviderAuthStatus: () => ({ configured: false }),
      getError: () => undefined,
    };
    const binding = createAgentRuntimeBinding({
      live: state.live,
      agentName: "research-assistant",
      cwd: state.project,
      createModelRuntime: async () => runtimeModel,
      resolveAutomaticModel: async () => automaticModel,
      compaction: {
        apply: (policy) => ({ triggerPercent: policy.triggerPercent, enabled: policy.globalEnabled }),
        current: () => ({ triggerPercent: 70, enabled: true }),
      },
    });
    await binding.ensureCurrent();
    const baseline = state.live.generation;
    const baselineUpdates = configurationUpdates(state.events).length;
    try {
      const agentPath = join(state.agentDir, "agents", "research-assistant.md");
      const skillPath = join(state.project, ".easyresearch", "skills", skillName, "SKILL.md");
      mkdirSync(join(agentPath, ".."), { recursive: true });
      mkdirSync(join(skillPath, ".."), { recursive: true });
      writeFileSync(agentPath, agentMarkdown("research-assistant", "DROPPED", [skillName]), "utf8");
      writeFileSync(skillPath, skillMarkdown(skillName, "DROPPED_SKILL_MARKER"), "utf8");
      expect(state.live.generation).toBe(baseline);

      await binding.ensureCurrent({ activeBoundary: true });

      expect(state.live.generation).toBe(baseline + 1);
      expect(binding.generation()).toBe(baseline + 1);
      expect(binding.current().systemPrompt).toContain("ROLE_DROPPED");
      expect(binding.skillPaths()).toEqual([acceptedSkillPath()]);
      expect(configurationUpdates(state.events)).toHaveLength(baselineUpdates + 1);
      expect(configurationUpdates(state.events).at(-1)).toMatchObject({
        agentsChanged: true,
        skillsChanged: true,
        runtimeChanged: true,
      });
    } finally {
      await binding.dispose();
    }
  });
});

describe("configuration content fingerprint", () => {
  it("is deterministic by sorted Agent filename and changes on same-size edits, add, unlink, and atomic replacement", async () => {
    const first = tempRoot();
    const second = tempRoot();
    for (const root of [first, second]) {
      mkdirSync(join(root, "agents"), { recursive: true });
      writeFileSync(join(root, "models.json"), "{}", "utf8");
    }
    writeFileSync(join(first, "agents", "b.md"), "bravo", "utf8");
    writeFileSync(join(first, "agents", "a.md"), "alpha", "utf8");
    writeFileSync(join(second, "agents", "a.md"), "alpha", "utf8");
    writeFileSync(join(second, "agents", "b.md"), "bravo", "utf8");

    const original = await fingerprintConfiguration(first);
    expect(await fingerprintConfiguration(second)).toEqual(original);

    writeFileSync(join(first, "agents", "a.md"), "ALPHA", "utf8");
    const sameSizeEdit = await fingerprintConfiguration(first);
    expect(sameSizeEdit.agents).not.toBe(original.agents);
    expect(sameSizeEdit.models).toBe(original.models);
    expect(sameSizeEdit.value).not.toBe(original.value);

    writeFileSync(join(first, "agents", "added.md"), "new", "utf8");
    const added = await fingerprintConfiguration(first);
    expect(added.agents).not.toBe(sameSizeEdit.agents);
    unlinkSync(join(first, "agents", "added.md"));
    expect((await fingerprintConfiguration(first)).agents).toBe(sameSizeEdit.agents);

    writeFileSync(join(first, "agents", "replacement.tmp"), "omega", "utf8");
    renameSync(join(first, "agents", "replacement.tmp"), join(first, "agents", "a.md"));
    const replaced = await fingerprintConfiguration(first);
    expect(replaced.agents).not.toBe(sameSizeEdit.agents);
    expect(replaced.models).toBe(sameSizeEdit.models);
  });

  it("changes only the model component for same-size models.json replacement", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "agents", "research-assistant.md"), "agent", "utf8");
    writeFileSync(join(root, "models.json"), '{"a":1}', "utf8");
    const before = await fingerprintConfiguration(root);

    writeFileSync(join(root, "models.next"), '{"b":2}', "utf8");
    renameSync(join(root, "models.next"), join(root, "models.json"));
    const after = await fingerprintConfiguration(root);

    expect(after.models).not.toBe(before.models);
    expect(after.agents).toBe(before.agents);
    expect(after.value).not.toBe(before.value);
  });

  it("changes the configuration only for accepted Agent defaults and compaction inputs", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "agents", "research-assistant.md"), "agent", "utf8");
    writeFileSync(join(root, "models.json"), "{}", "utf8");
    writeFileSync(join(root, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    const before = await fingerprintConfiguration(root);

    writeFileSync(join(root, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");
    expect(await fingerprintConfiguration(root)).toEqual(before);

    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({
        theme: "light",
        compaction: { enabled: false, keepRecentTokens: 7_000 },
        easyresearch: { compaction: { triggerPercent: 80 } },
      }),
      "utf8",
    );
    const compaction = await fingerprintConfiguration(root);
    expect(compaction.agents).toBe(before.agents);
    expect(compaction.models).toBe(before.models);
    expect(compaction.agentDefaults).toBe(before.agentDefaults);
    expect(compaction.compaction).not.toBe(before.compaction);
    expect(compaction.compactionPolicy).toEqual({
      triggerPercent: 80,
      globalEnabled: false,
      globalKeepRecentTokens: 7_000,
    });

    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({ theme: "light", easyresearch: { agentDefaults: { reviewer: { thinking: "high" } } } }),
      "utf8",
    );
    const after = await fingerprintConfiguration(root);
    expect(after.agents).toBe(before.agents);
    expect(after.models).toBe(before.models);
    expect(after.value).not.toBe(before.value);
  });

  it("uses the cold compaction default for an invalid configured percentage", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "agents", "research-assistant.md"), "agent", "utf8");
    writeFileSync(join(root, "models.json"), "{}", "utf8");
    const before = await fingerprintConfiguration(root);
    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({ easyresearch: { compaction: { triggerPercent: 91 } } }),
      "utf8",
    );

    const result = await fingerprintConfiguration(root);
    expect(result.compactionPolicy.triggerPercent).toBe(70);
    expect(result.diagnostic).toMatch(/configuration/i);
    expect(result.value).not.toBe(before.value);
  });

  it("accepts only the global API-usage boolean into the live configuration fingerprint", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "agents", "research-assistant.md"), "agent", "utf8");
    writeFileSync(join(root, "models.json"), "{}", "utf8");
    const before = await fingerprintConfiguration(root);

    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({ easyresearch: { web: { showApiUsageDetails: true } } }),
      "utf8",
    );
    const after = await fingerprintConfiguration(root);

    expect(before.apiUsageSettings).toEqual({ showApiUsageDetails: false });
    expect(after.apiUsageSettings).toEqual({ showApiUsageDetails: true });
    expect(after.apiUsage).not.toBe(before.apiUsage);
    expect(after.compaction).toBe(before.compaction);
    expect(after.value).not.toBe(before.value);

    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({ easyresearch: { web: { showApiUsageDetails: "true" } } }),
      "utf8",
    );
    const invalid = await fingerprintConfiguration(root);
    expect(invalid.apiUsageSettings).toEqual({ showApiUsageDetails: false });
    expect(invalid.diagnostic).toMatch(/configuration/i);
  });

  it("includes global Skill descriptors and candidate-enabled optional-home descriptors", async () => {
    const base = tempRoot();
    const root = join(base, "agent");
    const home = join(base, "home");
    mkdirSync(join(root, "agents"), { recursive: true });
    mkdirSync(join(root, "skills", "nested"), { recursive: true });
    mkdirSync(join(home, ".agents", "skills", "group"), { recursive: true });
    writeFileSync(join(root, "agents", "research-assistant.md"), "agent", "utf8");
    writeFileSync(join(root, "models.json"), "{}", "utf8");
    writeFileSync(join(root, "skills", "nested", "SKILL.md"), "global-v1", "utf8");
    writeFileSync(join(home, ".agents", "skills", "group", "home.md"), "home-v1", "utf8");
    const disabled = await fingerprintConfiguration(root, home);

    writeFileSync(join(home, ".agents", "skills", "group", "home.md"), "HOME-V1", "utf8");
    expect(await fingerprintConfiguration(root, home)).toEqual(disabled);

    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({ easyresearch: { enable_dot_agents_skill: true } }),
      "utf8",
    );
    const enabled = await fingerprintConfiguration(root, home);
    expect(enabled.globalSkills).toBe(disabled.globalSkills);
    expect(enabled.homeSkills).not.toBeNull();
    expect(enabled.value).not.toBe(disabled.value);

    writeFileSync(join(home, ".agents", "skills", "group", "home.md"), "home-v2", "utf8");
    const homeEdited = await fingerprintConfiguration(root, home);
    expect(homeEdited.homeSkills).not.toBe(enabled.homeSkills);
    expect(homeEdited.globalSkills).toBe(enabled.globalSkills);

    writeFileSync(join(root, "skills", "nested", "SKILL.md"), "global-v2", "utf8");
    const globalEdited = await fingerprintConfiguration(root, home);
    expect(globalEdited.globalSkills).not.toBe(homeEdited.globalSkills);
    expect(globalEdited.homeSkills).toBe(homeEdited.homeSkills);
  });

  it("uses cold settings defaults before reading optional-home descriptor bytes", async () => {
    const base = tempRoot();
    const root = join(base, "agent");
    const home = join(base, "home");
    mkdirSync(join(root, "agents"), { recursive: true });
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    writeFileSync(join(root, "agents", "research-assistant.md"), "agent", "utf8");
    writeFileSync(join(root, "models.json"), "{}", "utf8");
    writeFileSync(join(root, "settings.json"), "{ invalid JSON", "utf8");
    writeFileSync(join(home, ".agents", "skills", "home.md"), Buffer.alloc(1_048_577, 0x61));

    const result = await fingerprintConfiguration(root, home);
    expect(result.homeSkills).toBeNull();
    expect(result.diagnostic).toMatch(/configuration/i);
  });

  it("excludes project files, sessions, logs, auth values, and unrelated global resources", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "agents"), { recursive: true });
    mkdirSync(join(root, "skills"), { recursive: true });
    writeFileSync(join(root, "agents", "research-assistant.md"), "agent", "utf8");
    writeFileSync(join(root, "models.json"), "{}", "utf8");
    const before = await fingerprintConfiguration(root);

    const excluded = [
      ["auth.json", "API_KEY=AUTH_SECRET"],
      ["settings.json", '{"easyresearch":{"secret":"SETTINGS_SECRET"}}'],
      [join("sessions", "project", "session.jsonl"), "SESSION_SECRET"],
      [join("logs", "easyresearch.log"), "LOG_SECRET"],
      [join("skills", "custom", "README.md"), "UNRELATED_SKILL_MARKDOWN"],
      [join("skills", "custom", "helper.py"), "SKILL_AUXILIARY"],
      [join("project", ".easyresearch", "agents", "search.md"), "PROJECT_SECRET"],
      [join("agents", "ignored.txt"), "UNRELATED_SECRET"],
      [join("agents", "nested", "ignored.md"), "NESTED_SECRET"],
    ] as const;
    for (const [relativePath, content] of excluded) {
      const path = join(root, relativePath);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content, "utf8");
    }

    expect(await fingerprintConfiguration(root)).toEqual(before);
  });
});
