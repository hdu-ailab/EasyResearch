import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentCatalogSnapshot,
  AgentConfig,
  AgentDefinition,
  AgentDiscoveryResult,
  DiscoveryOptions,
} from "../subagent/agents";
import type { ConfigurationEvent } from "../web/contracts";
import {
  ConfigurationUnavailableError,
  createLiveConfiguration,
  fingerprintConfiguration,
  type ConfigurationFingerprint,
  type ConfigurationWatchImplementation,
} from "./live-configuration";

const tempRoots: string[] = [];

afterEach(() => {
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
): ConfigurationFingerprint {
  return {
    value: `${agents}:${models}:${agentDefaults}:${compaction}:${apiUsage}`,
    agents,
    models,
    agentDefaults,
    compaction,
    compactionPolicy,
    apiUsage,
    apiUsageSettings,
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
        missingSkills: [],
      }),
    ),
  };
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
  options: { autoReady?: boolean; watch?: ConfigurationWatchImplementation } = {},
) {
  let currentCatalog = initialCatalog;
  let currentFingerprint = fingerprint("agents-v1", "models-v1");
  let availableModels = explicitModels(currentCatalog);
  let acceptedModels: string[] = [];
  const loadCatalog = vi.fn(async () => currentCatalog);
  const resolveCatalog = vi.fn(resolvedAgents);
  const preparedModelCatalogs: Array<{
    models: ReturnType<typeof modelOption>[];
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
    const candidate = { models, commit, rollback };
    preparedModelCatalogs.push(candidate);
    return candidate;
  };
  const prepareModels = vi.fn(async () =>
    prepareCandidate(availableModels.map((model) => `${model.provider}/${model.id}`))
  );
  const readFingerprint = vi.fn(async () => currentFingerprint);
  const watcher = fakeWatcher(options.autoReady);
  const live = createLiveConfiguration({
    agentDir: "/global",
    modelValidator: { prepareModelCatalog: prepareModels },
    fingerprint: readFingerprint,
    loadCatalog,
    resolveCatalog,
    watch: options.watch ?? watcher.watch,
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
      availableModels = explicitModels(next);
    },
    setFingerprint(next: ConfigurationFingerprint) {
      currentFingerprint = next;
    },
    setModels(references: string[]) {
      availableModels = references.map(modelOption);
    },
  };
}

describe("live configuration generations", () => {
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
    await state.live.start();

    state.setFingerprint(fingerprint("broken-v2", "models-v1"));
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
    await state.live.synchronize();
    expect(state.live.generation).toBe(2);
    await expect(state.live.resolveAgents("/paper")).resolves.toEqual([
      expect.objectContaining({ model: "provider/v2", systemPrompt: "Prompt v2" }),
    ]);
  });

  it("asserts only a synchronized, validation-clean accepted generation as current", async () => {
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
    expect(state.live.isCurrent(acceptedGeneration)).toBe(false);

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
    });
    await expect(state.live.resolveAgents("/paper")).resolves.toEqual([
      expect.objectContaining({ model: "provider/recovered" }),
    ]);
  });

  it("rejects non-empty diagnostics even when the catalog contains a complete Research Assistant definition", async () => {
    const state = harness({
      definitions: [definition("v1")],
      diagnostics: [{ agent: "search", source: "global", message: "Invalid Agent definition." }],
    });

    await state.live.start();

    expect(state.live.generation).toBe(0);
    expect(state.live.error).toMatch(/configuration/i);
    await expect(state.live.resolveAgents("/paper")).rejects.toBeInstanceOf(ConfigurationUnavailableError);
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
      { type: "config.updated", generation: 1, agentsChanged: true, modelsChanged: true },
      { type: "config.updated", generation: 2, agentsChanged: true, modelsChanged: false },
      { type: "config.updated", generation: 3, agentsChanged: false, modelsChanged: true },
      { type: "config.updated", generation: 4, agentsChanged: false, modelsChanged: true },
    ]);
    expect(state.loadCatalog).toHaveBeenCalledTimes(4);
    expect(state.prepareModels).toHaveBeenCalledTimes(4);
  });

  it("retains a failed forced model invalidation until a later plain synchronization commits", async () => {
    const state = harness();
    const events: ConfigurationEvent[] = [];
    state.live.subscribe((event) => events.push(event));
    await state.live.start();
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

  it("creates one stable-write watcher for the authoritative paths and filters every unrelated event", async () => {
    const state = harness();

    await Promise.all([state.live.start(), state.live.start(), state.live.start()]);

    expect(state.watcher.watch).toHaveBeenCalledTimes(1);
    expect(state.watcher.watch).toHaveBeenCalledWith(
      [join("/global", "agents"), join("/global", "settings.json"), join("/global", "models.json")],
      expect.objectContaining({
        ignoreInitial: true,
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

  it("rejects an invalid configured compaction percentage", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "agents", "research-assistant.md"), "agent", "utf8");
    writeFileSync(join(root, "models.json"), "{}", "utf8");
    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({ easyresearch: { compaction: { triggerPercent: 91 } } }),
      "utf8",
    );

    await expect(fingerprintConfiguration(root)).rejects.toThrow(/integer.*10.*90/i);
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
    await expect(fingerprintConfiguration(root)).rejects.toThrow(/boolean/i);
  });

  it("excludes project files, sessions, logs, auth values, and unrelated global resources", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "agents", "research-assistant.md"), "agent", "utf8");
    writeFileSync(join(root, "models.json"), "{}", "utf8");
    const before = await fingerprintConfiguration(root);

    const excluded = [
      ["auth.json", "API_KEY=AUTH_SECRET"],
      ["settings.json", '{"easyresearch":{"secret":"SETTINGS_SECRET"}}'],
      [join("sessions", "project", "session.jsonl"), "SESSION_SECRET"],
      [join("logs", "easyresearch.log"), "LOG_SECRET"],
      [join("skills", "custom", "SKILL.md"), "SKILL_SECRET"],
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
