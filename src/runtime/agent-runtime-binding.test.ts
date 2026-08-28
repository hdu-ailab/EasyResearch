import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../subagent/agents";
import type { ConfigurationEvent, ConfigurationUpdatedEvent } from "../web/contracts";
import { createAgentDefinitionExtension } from "../extensions/agent-definition";
import { createCompactionPolicyBinding, type CompactionPolicyBinding } from "./compaction-policy";
import { importPi } from "./pi-import";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  createAgentRuntimeBinding,
  type AgentRuntimeBinding,
  type AgentRuntimeBindingSession,
} from "./agent-runtime-binding";

function model(name: string, id = "same-model"): Model<any> {
  return {
    provider: "test-provider",
    id,
    name,
    api: "test-api",
    baseUrl: "http://localhost.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  } as Model<any>;
}

function definition(version: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "research-assistant",
    description: `Research Assistant ${version}`,
    enabled: true,
    builtin: true,
    tools: [`tool-${version}`],
    effectiveTools: [`tool-${version}`],
    subagents: [`search-${version}`],
    skills: [`skill-${version}`],
    effectiveSkills: [`skill-${version}`],
    effectiveSkillPaths: [`/skills/skill-${version}`],
    missingSkills: [],
    model: "test-provider/same-model",
    thinking: version === "v1" ? "low" : "high",
    systemPrompt: `Prompt ${version}`,
    source: "global",
    filePath: `/private/${version}.md`,
    ...overrides,
  };
}

class FakeLiveConfiguration {
  generation = 1;
  availabilityEpoch = 1;
  error: string | null = null;
  compactionPolicy = { triggerPercent: 70, globalEnabled: true, globalKeepRecentTokens: 20_000 };
  synchronizeCalls = 0;
  readonly synchronizeOptions: Array<{ projectCwds?: readonly string[] } | undefined> = [];
  readonly operations: string[] = [];
  projectAcquireCalls = 0;
  projectReleaseCalls = 0;
  authoritative = true;
  closed = false;
  validationClean = true;
  onCurrentCheck: (() => void) | undefined;
  synchronizeImpl: (() => void | Promise<void>) | undefined;
  private agents: AgentConfig[];
  private readonly listeners = new Set<(event: ConfigurationEvent) => void>();

  constructor(initial: AgentConfig[]) {
    this.agents = initial;
  }

  async synchronize(options?: { projectCwds?: readonly string[] }): Promise<void> {
    this.synchronizeCalls += 1;
    this.synchronizeOptions.push(options);
    this.operations.push("synchronize");
    await this.synchronizeImpl?.();
  }

  async acquireProject(cwd: string): Promise<{ cwd: string; release(): Promise<void> }> {
    this.projectAcquireCalls += 1;
    this.operations.push(`acquire:${cwd}`);
    return {
      cwd,
      release: async () => {
        this.projectReleaseCalls += 1;
        this.operations.push(`release:${cwd}`);
      },
    };
  }

  isCurrent(generation: number): boolean {
    const current = this.authoritative && !this.closed && this.validationClean && generation === this.generation;
    this.onCurrentCheck?.();
    return current;
  }

  async resolveAgents(): Promise<AgentConfig[]> {
    this.operations.push("resolve");
    return this.agents.map((agent) => ({
      ...agent,
      tools: agent.tools ? [...agent.tools] : undefined,
      effectiveTools: [...agent.effectiveTools],
      subagents: agent.subagents ? [...agent.subagents] : agent.subagents,
      skills: agent.skills ? [...agent.skills] : undefined,
      effectiveSkills: [...agent.effectiveSkills],
      effectiveSkillPaths: [...agent.effectiveSkillPaths],
      missingSkills: [...agent.missingSkills],
    }));
  }

  subscribe(listener: (event: ConfigurationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(
    next: AgentConfig[],
    compactionPolicy = this.compactionPolicy,
  ): void {
    this.agents = next;
    this.compactionPolicy = { ...compactionPolicy };
    this.generation += 1;
    const event: ConfigurationUpdatedEvent = {
      type: "config.updated",
      generation: this.generation,
      agentsChanged: true,
      modelsChanged: true,
      skillsChanged: false,
      runtimeChanged: true,
    };
    for (const listener of [...this.listeners]) listener(event);
  }

  signalCurrent(): void {
    const event: ConfigurationUpdatedEvent = {
      type: "config.updated",
      generation: this.generation,
      agentsChanged: true,
      modelsChanged: true,
      skillsChanged: false,
      runtimeChanged: true,
    };
    for (const listener of [...this.listeners]) listener(event);
  }

  publishApiUsageDisplay(): void {
    this.generation += 1;
    const event: ConfigurationUpdatedEvent = {
      type: "config.updated",
      generation: this.generation,
      agentsChanged: false,
      modelsChanged: false,
      skillsChanged: false,
      apiUsageChanged: true,
      runtimeChanged: false,
    };
    for (const listener of [...this.listeners]) listener(event);
  }

  publishAvailability(): void {
    this.availabilityEpoch += 1;
    const event: ConfigurationUpdatedEvent = {
      type: "config.updated",
      generation: this.generation,
      availabilityEpoch: this.availabilityEpoch,
      availabilityChanged: true,
      agentsChanged: false,
      modelsChanged: false,
      skillsChanged: false,
      runtimeChanged: false,
    };
    for (const listener of [...this.listeners]) listener(event);
  }

  publishSkills(next: AgentConfig[]): void {
    this.agents = next;
    this.generation += 1;
    const event: ConfigurationUpdatedEvent = {
      type: "config.updated",
      generation: this.generation,
      agentsChanged: false,
      modelsChanged: false,
      skillsChanged: true,
      runtimeChanged: true,
    };
    for (const listener of [...this.listeners]) listener(event);
  }
}

class FakeModelRuntimeFactory {
  next = new Map<string, Model<any>>();
  refreshCalls: unknown[] = [];
  refreshGate: Promise<void> | undefined;
  refreshResult: unknown;
  semanticError: string | undefined;
  disposeError: Error | undefined;
  createError: Error | undefined;
  readonly runtimes: FakeModelRuntime[] = [];

  async create(): Promise<FakeModelRuntime> {
    if (this.createError) {
      const error = this.createError;
      this.createError = undefined;
      throw error;
    }
    const runtime = new FakeModelRuntime(this);
    this.runtimes.push(runtime);
    return runtime;
  }

  setNext(...models: Model<any>[]): void {
    this.next = new Map(models.map((entry) => [`${entry.provider}/${entry.id}`, entry]));
  }
}

class FakeModelRuntime {
  current = new Map<string, Model<any>>();
  disposeCalls = 0;

  constructor(private readonly factory: FakeModelRuntimeFactory) {}

  async refresh(options: { allowNetwork: false }): Promise<unknown> {
    this.factory.refreshCalls.push(options);
    await this.factory.refreshGate;
    this.current = new Map(this.factory.next);
    return this.factory.refreshResult;
  }

  getModel(provider: string, modelId: string): Model<any> | undefined {
    return this.current.get(`${provider}/${modelId}`);
  }

  getAvailableSnapshot(): Model<any>[] {
    return [...this.current.values()];
  }

  getProvider(providerId: string): { id: string } | undefined {
    return [...this.current.values()].some((entry) => entry.provider === providerId)
      ? { id: providerId }
      : undefined;
  }

  getProviderAuthStatus(providerId: string): { configured: boolean } {
    return { configured: this.getProvider(providerId) !== undefined };
  }

  getError(): string | undefined {
    return this.factory.semanticError;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    if (this.factory.disposeError) throw this.factory.disposeError;
  }
}

class FakeSession implements AgentRuntimeBindingSession {
  private idle = true;
  onIdleRead: (() => void) | undefined;
  model: Model<any> | undefined;
  thinkingLevel: ThinkingLevel = "off";
  reloadCalls = 0;
  modelCalls: Array<Model<any> | undefined> = [];
  thinkingCalls: ThinkingLevel[] = [];
  failNextReload: Error | undefined;
  failNextModel: Error | undefined;
  readonly reloadFailures: Error[] = [];
  readonly modelFailures: Error[] = [];
  readonly thinkingFailures: Error[] = [];
  abortCalls = 0;
  abortImpl: () => Promise<void> = async () => {};
  onReload: (() => void) | undefined;

  get isIdle(): boolean {
    this.onIdleRead?.();
    return this.idle;
  }

  set isIdle(value: boolean) {
    this.idle = value;
  }

  async reload(): Promise<void> {
    this.reloadCalls += 1;
    const error = this.failNextReload ?? this.reloadFailures.shift();
    this.failNextReload = undefined;
    if (error) throw error;
    this.onReload?.();
  }

  rebindModel(next: Model<any> | undefined): void {
    this.modelCalls.push(next);
    const error = this.failNextModel ?? this.modelFailures.shift();
    this.failNextModel = undefined;
    if (error) throw error;
    this.model = next;
  }

  setThinkingLevel(next: ThinkingLevel): void {
    this.thinkingCalls.push(next);
    const error = this.thinkingFailures.shift();
    if (error) throw error;
    this.thinkingLevel = next;
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    await this.abortImpl();
  }
}

function createHarness(
  initial = definition("v1"),
  onCompactionPolicyChanged = vi.fn(),
  initialModel: Model<any> = model("metadata-v1"),
  onRuntimeCoherent = vi.fn(),
  onApplied = vi.fn(),
) {
  const live = new FakeLiveConfiguration([initial]);
  const models = new FakeModelRuntimeFactory();
  models.setNext(initialModel);
  const resolveAutomaticModel = vi.fn<() => Promise<Model<any> | undefined>>(
    async () => model("automatic", "automatic-model"),
  );
  const settings = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  });
  const baseCompaction = createCompactionPolicyBinding(settings);
  const compactionFailures: Error[] = [];
  const compaction: CompactionPolicyBinding = {
    apply(policy, selectedModel, applyOptions) {
      const error = compactionFailures.shift();
      if (error) throw error;
      return baseCompaction.apply(policy, selectedModel, applyOptions);
    },
    current: () => baseCompaction.current(),
  };
  const binding = createAgentRuntimeBinding({
    live,
    agentName: "research-assistant",
    cwd: "/paper",
    createModelRuntime: () => models.create(),
    resolveAutomaticModel,
    compaction,
    onCompactionPolicyChanged,
    onRuntimeCoherent,
    onApplied,
  });
  return {
    live,
    models,
    binding,
    resolveAutomaticModel,
    initialModel,
    settings,
    compaction,
    compactionFailures,
    onCompactionPolicyChanged,
    onRuntimeCoherent,
    onApplied,
  };
}

async function attachHarness(state: ReturnType<typeof createHarness>) {
  await state.binding.ensureCurrent();
  const session = new FakeSession();
  session.model = state.binding.model();
  session.thinkingLevel = state.binding.thinking();
  let observed = {
    prompt: state.binding.appendSystemPrompt(["Pi base"]),
    tools: state.binding.current().tools,
    skills: state.binding.skillPaths(),
    subagents: state.binding.current().subagents,
  };
  session.onReload = () => {
    observed = {
      prompt: state.binding.appendSystemPrompt(["Pi base"]),
      tools: state.binding.current().tools,
      skills: state.binding.skillPaths(),
      subagents: state.binding.current().subagents,
    };
  };
  await state.binding.attach(session);
  return { session, observed: () => observed };
}

function attachPiSession(
  binding: AgentRuntimeBinding,
  session: Omit<AgentRuntimeBindingSession, "rebindModel"> & {
    agent: { state: { model: Model<any> | undefined } };
  },
): Promise<void> {
  return binding.attach({
    get isIdle() {
      return session.isIdle;
    },
    get model() {
      return session.model;
    },
    get thinkingLevel() {
      return session.thinkingLevel;
    },
    reload: () => session.reload(),
    async abort() {
      const operation = session.abort();
      void operation.catch(() => {});
    },
    rebindModel: (selectedModel) => {
      session.agent.state.model = selectedModel as Model<any>;
    },
    setThinkingLevel: (level) => session.setThinkingLevel(level),
  });
}

describe("AgentRuntimeBinding safe boundaries", () => {
  it("clears Pi's internal unknown model when the accepted configuration has no model", async () => {
    const state = createHarness(definition("v1", { model: undefined }));
    state.resolveAutomaticModel.mockResolvedValue(undefined);
    await state.binding.ensureCurrent();
    const session = new FakeSession();
    session.model = { ...model("unknown", "unknown"), provider: "unknown" };
    session.thinkingLevel = state.binding.thinking();

    await state.binding.attach(session);

    expect(session.model).toBeUndefined();
    expect(session.modelCalls).toEqual([undefined]);
  });

  it("refreshes availability without rebinding an unchanged explicit model", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    const refreshes = state.models.refreshCalls.length;
    const modelRebinds = attached.session.modelCalls.length;
    const reloads = attached.session.reloadCalls;

    state.live.publishAvailability();
    await vi.waitFor(() => expect(state.models.refreshCalls).toHaveLength(refreshes + 1));

    expect(state.binding.generation()).toBe(1);
    expect(attached.session.modelCalls).toHaveLength(modelRebinds);
    expect(attached.session.reloadCalls).toBe(reloads);
  });

  it("resolves and binds an automatic model when availability appears", async () => {
    const state = createHarness(definition("v1", { model: undefined }));
    state.resolveAutomaticModel.mockResolvedValueOnce(undefined);
    const attached = await attachHarness(state);
    expect(attached.session.model).toBeUndefined();

    const fallback = model("available-fallback", "fallback");
    state.models.setNext(fallback);
    state.resolveAutomaticModel.mockResolvedValueOnce(fallback);
    state.live.publishAvailability();

    await vi.waitFor(() => expect(attached.session.model).toBe(fallback));
    expect(attached.session.modelCalls).toEqual([fallback]);
    expect(state.binding.generation()).toBe(1);
  });

  it("clears an automatic model when no model remains available", async () => {
    const state = createHarness(definition("v1", { model: undefined }));
    const attached = await attachHarness(state);
    expect(attached.session.model).toBeDefined();

    state.models.setNext();
    state.resolveAutomaticModel.mockResolvedValueOnce(undefined);
    state.live.publishAvailability();

    await vi.waitFor(() => expect(attached.session.model).toBeUndefined());
    expect(attached.session.modelCalls).toEqual([undefined]);
    expect(state.binding.generation()).toBe(1);
  });

  it("can clear the session model without invoking a persistence-writing model mutation", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    state.resolveAutomaticModel.mockResolvedValue(undefined);
    state.models.setNext(model("metadata-v2"));

    state.live.publish([definition("v2", { model: undefined })]);
    await vi.waitFor(() => expect(state.binding.generation()).toBe(2));

    expect(attached.session.model).toBeUndefined();
    expect(attached.session.modelCalls).toEqual([undefined]);
  });

  it("acquires the exact cwd before initial synchronization and releases it once", async () => {
    const state = createHarness();

    await state.binding.ensureCurrent();

    expect(state.live.operations.slice(0, 3)).toEqual([
      "acquire:/paper",
      "synchronize",
      "resolve",
    ]);
    expect(state.live.synchronizeOptions).toEqual([
      { projectCwds: ["/paper"] },
      { projectCwds: ["/paper"] },
    ]);
    expect(state.live.projectAcquireCalls).toBe(1);

    await state.binding.dispose();
    await state.binding.dispose();

    expect(state.live.projectReleaseCalls).toBe(1);
  });

  it("accepts a visual-only API-usage generation without rebuilding the Agent runtime", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    const reloads = attached.session.reloadCalls;
    const modelCalls = attached.session.modelCalls.length;

    state.live.publishApiUsageDisplay();
    await vi.waitFor(() => expect(state.binding.generation()).toBe(2));

    expect(attached.session.reloadCalls).toBe(reloads);
    expect(attached.session.modelCalls).toHaveLength(modelCalls);
  });

  it("advances a display-only generation during an in-flight no-op boundary without reloading Pi", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    let releaseSynchronization!: () => void;
    const synchronizationGate = new Promise<void>((resolve) => {
      releaseSynchronization = resolve;
    });
    state.live.synchronizeImpl = () => synchronizationGate;
    const synchronizationBaseline = state.live.synchronizeCalls;

    const checking = state.binding.ensureCurrent({ recaptureCompactionBase: true });
    await vi.waitFor(() => expect(state.live.synchronizeCalls).toBe(synchronizationBaseline + 1));
    state.live.publishApiUsageDisplay();
    releaseSynchronization();
    await checking;

    expect(state.binding.generation()).toBe(2);
    expect(attached.session.reloadCalls).toBe(0);
  });

  it("applies and reapplies the accepted compaction policy without a new Agent definition", async () => {
    const state = createHarness();

    await state.binding.ensureCurrent();
    expect(state.settings.getCompactionSettings()).toMatchObject({
      reserveTokens: 38_400,
      keepRecentTokens: 20_000,
    });
    expect(state.binding.compactionPolicy()).toEqual({ triggerPercent: 70, enabled: true });

    state.live.publish(
      [definition("v1")],
      { triggerPercent: 80, globalEnabled: true, globalKeepRecentTokens: 20_000 },
    );
    await state.binding.ensureCurrent();

    expect(state.settings.getCompactionSettings()).toMatchObject({
      reserveTokens: 25_600,
      keepRecentTokens: 20_000,
    });
    expect(state.binding.compactionPolicy()).toEqual({ triggerPercent: 80, enabled: true });
    expect(state.onCompactionPolicyChanged).toHaveBeenCalledWith({ triggerPercent: 80, enabled: true });
  });

  it("reapplies after an external settings reload even when generation is unchanged", async () => {
    const state = createHarness();
    await state.binding.ensureCurrent();
    await state.settings.reload();
    expect(state.settings.getCompactionReserveTokens()).toBe(16_384);

    await state.binding.ensureCurrent({ recaptureCompactionBase: true });

    expect(state.settings.getCompactionReserveTokens()).toBe(38_400);
  });

  it("notifies when equal-id model metadata changes the context window", async () => {
    const state = createHarness();
    await attachHarness(state);
    state.onCompactionPolicyChanged.mockClear();
    state.models.setNext({ ...model("metadata-v2"), contextWindow: 64_000 });

    state.live.publish([definition("v2")]);

    await vi.waitFor(() => expect(state.settings.getCompactionReserveTokens()).toBe(19_200));
    expect(state.onCompactionPolicyChanged).toHaveBeenCalledWith({ triggerPercent: 70, enabled: true });
  });

  it("preserves the uncapped retained-tail base when a model update rolls back", async () => {
    const smallModel = { ...model("small"), contextWindow: 8_192 };
    const state = createHarness(definition("v1"), vi.fn(), smallModel);
    const attached = await attachHarness(state);
    expect(state.settings.getCompactionKeepRecentTokens()).toBe(2_867);
    attached.session.isIdle = false;
    const largeModel = model("large");
    state.models.setNext(largeModel);
    attached.session.failNextModel = new Error("model rejected");
    state.live.publish([definition("v2")]);

    await expect(state.binding.ensureCurrent({ activeBoundary: true })).rejects.toThrow();
    expect(attached.session.model).toBe(smallModel);

    attached.session.model = largeModel;
    await state.binding.reapplyCompaction();
    expect(state.settings.getCompactionKeepRecentTokens()).toBe(20_000);
  });

  it("exposes only the generation of the fully applied runtime state", async () => {
    const state = createHarness();

    await state.binding.ensureCurrent();
    expect(state.binding.generation()).toBe(1);

    state.models.setNext(model("metadata-v2"));
    state.live.publish([definition("v2")]);
    await state.binding.ensureCurrent();

    expect(state.binding.generation()).toBe(2);
  });

  it("projects initial and eager idle generations only after their complete transactions commit", async () => {
    const commits: Array<{
      generation: number;
      bindingGeneration: number;
      prompt: string;
      modelName: string | undefined;
      reloads: number;
    }> = [];
    let state!: ReturnType<typeof createHarness>;
    let attached: Awaited<ReturnType<typeof attachHarness>> | undefined;
    const onApplied = vi.fn((generation: number) => {
      commits.push({
        generation,
        bindingGeneration: state.binding.generation(),
        prompt: state.binding.current().systemPrompt,
        modelName: attached?.session.model?.name ?? state.binding.model()?.name,
        reloads: attached?.session.reloadCalls ?? 0,
      });
    });
    state = createHarness(definition("v1"), vi.fn(), model("metadata-v1"), vi.fn(), onApplied);

    await state.binding.ensureCurrent();

    expect(commits).toEqual([{
      generation: 1,
      bindingGeneration: 1,
      prompt: "Prompt v1",
      modelName: "metadata-v1",
      reloads: 0,
    }]);

    attached = await attachHarness(state);
    commits.length = 0;
    state.models.setNext(model("metadata-v2"));
    state.live.publish([definition("v2")]);

    await vi.waitFor(() => expect(commits).toHaveLength(1));
    expect(commits).toEqual([{
      generation: 2,
      bindingGeneration: 2,
      prompt: "Prompt v2",
      modelName: "metadata-v2",
      reloads: 1,
    }]);

    state.live.signalCurrent();
    await state.binding.ensureCurrent();
    expect(commits).toHaveLength(1);
  });

  it("projects an active generation only after the awaited safe-boundary transaction", async () => {
    const commits: Array<{ generation: number; prompt: string; reloads: number }> = [];
    let state!: ReturnType<typeof createHarness>;
    let attached!: Awaited<ReturnType<typeof attachHarness>>;
    const onApplied = vi.fn((generation: number) => {
      commits.push({
        generation,
        prompt: state.binding.current().systemPrompt,
        reloads: attached.session.reloadCalls,
      });
    });
    state = createHarness(definition("v1"), vi.fn(), model("metadata-v1"), vi.fn(), onApplied);
    attached = await attachHarness(state);
    commits.length = 0;
    attached.session.isIdle = false;
    state.models.setNext(model("metadata-v2"));

    state.live.publish([definition("v2")]);
    await state.binding.ensureCurrent();

    expect(commits).toEqual([]);
    expect(attached.session.reloadCalls).toBe(0);

    await state.binding.ensureCurrent({ activeBoundary: true });

    expect(commits).toEqual([{ generation: 2, prompt: "Prompt v2", reloads: 1 }]);
  });

  it("projects a committed display-only generation without reloading Pi", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    state.onApplied.mockClear();

    state.live.publishApiUsageDisplay();

    await vi.waitFor(() => expect(state.onApplied).toHaveBeenCalledWith(2));
    expect(state.onApplied).toHaveBeenCalledOnce();
    expect(state.binding.generation()).toBe(2);
    expect(attached.session.reloadCalls).toBe(0);
  });

  it("defers display-only projection behind an in-flight transaction that later fails compaction", async () => {
    const state = createHarness();
    await attachHarness(state);
    state.onApplied.mockClear();
    let releaseSynchronization!: () => void;
    state.live.synchronizeImpl = () => new Promise<void>((resolve) => {
      releaseSynchronization = resolve;
    });
    state.compactionFailures.push(new Error("compaction reapply failed"));
    const synchronizationBaseline = state.live.synchronizeCalls;

    const checking = state.binding.ensureCurrent({ recaptureCompactionBase: true });
    await vi.waitFor(() => expect(state.live.synchronizeCalls).toBe(synchronizationBaseline + 1));
    state.live.publishApiUsageDisplay();
    expect(state.binding.generation()).toBe(2);
    expect(state.onApplied).not.toHaveBeenCalled();
    releaseSynchronization();

    await expect(checking).rejects.toThrow(/runtime configuration/i);
    expect(state.onApplied).not.toHaveBeenCalled();

    state.live.synchronizeImpl = undefined;
    await state.binding.ensureCurrent({ activeBoundary: true });

    expect(state.onApplied).toHaveBeenCalledOnce();
    expect(state.onApplied).toHaveBeenCalledWith(2);
  });

  it("applies an idle revision immediately across prompt, tools, Skills, subagents, model, and thinking", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    const nextModel = model("metadata-v2");
    state.models.setNext(nextModel);

    state.live.publish([definition("v2")]);

    await vi.waitFor(() => expect(attached.observed().prompt).toEqual(["Pi base", "Prompt v2"]));
    expect(attached.observed()).toEqual({
      prompt: ["Pi base", "Prompt v2"],
      tools: ["tool-v2"],
      skills: ["/skills/skill-v2"],
      subagents: ["search-v2"],
    });
    expect(attached.session.model).toBe(nextModel);
    expect(attached.session.thinkingLevel).toBe("high");
    expect(state.models.refreshCalls.at(-1)).toEqual({ allowNetwork: false });
    expect(attached.session.modelCalls.at(-1)).toBe(nextModel);
  });

  it("eagerly applies an accepted project-to-global Skill fallback without changing Agent Markdown", async () => {
    const initial = definition("v1", {
      effectiveSkillPaths: ["/paper/.easyresearch/skills/shared"],
    });
    const state = createHarness(initial);
    const attached = await attachHarness(state);
    expect(attached.observed().skills).toEqual(["/paper/.easyresearch/skills/shared"]);

    state.live.publishSkills([definition("v1", {
      effectiveSkillPaths: ["/agent/skills/shared"],
    })]);

    await vi.waitFor(() => expect(attached.observed().skills).toEqual(["/agent/skills/shared"]));
    expect(attached.observed()).toMatchObject({
      prompt: ["Pi base", "Prompt v1"],
      tools: ["tool-v1"],
      subagents: ["search-v1"],
    });
    expect(attached.session.reloadCalls).toBe(1);
  });

  it("defers a Skill-only project override while active and applies it at the safe boundary", async () => {
    const state = createHarness(definition("v1", {
      effectiveSkillPaths: ["/agent/skills/shared"],
    }));
    const attached = await attachHarness(state);
    attached.session.isIdle = false;

    state.live.publishSkills([definition("v1", {
      effectiveSkillPaths: ["/paper/.easyresearch/skills/shared"],
    })]);
    await Promise.resolve();
    await state.binding.ensureCurrent();

    expect(attached.session.reloadCalls).toBe(0);
    expect(state.binding.skillPaths()).toEqual(["/agent/skills/shared"]);

    await state.binding.ensureCurrent({ activeBoundary: true });

    expect(attached.session.reloadCalls).toBe(1);
    expect(attached.observed().skills).toEqual(["/paper/.easyresearch/skills/shared"]);
  });

  it("keeps deferred runtime work pending across a later display-only generation", async () => {
    const state = createHarness(definition("v1", {
      effectiveSkillPaths: ["/agent/skills/shared"],
    }));
    const attached = await attachHarness(state);
    attached.session.isIdle = false;

    state.live.publishSkills([definition("v1", {
      effectiveSkillPaths: ["/paper/.easyresearch/skills/shared"],
    })]);
    state.live.publishApiUsageDisplay();
    await Promise.resolve();

    expect(state.binding.generation()).toBe(1);
    expect(state.binding.skillPaths()).toEqual(["/agent/skills/shared"]);
    expect(attached.session.reloadCalls).toBe(0);

    await state.binding.ensureCurrent({ activeBoundary: true });

    expect(state.binding.generation()).toBe(3);
    expect(state.binding.skillPaths()).toEqual(["/paper/.easyresearch/skills/shared"]);
    expect(attached.session.reloadCalls).toBe(1);
  });

  it("marks pre-subscription catch-up pending before display churn during candidate preparation", async () => {
    const state = createHarness(definition("v1", {
      effectiveSkillPaths: ["/agent/skills/shared"],
    }));
    await state.binding.ensureCurrent();
    const session = new FakeSession();
    session.model = state.binding.model();
    session.thinkingLevel = state.binding.thinking();
    state.models.setNext(model("metadata-v2"));
    state.live.publishSkills([definition("v1", {
      effectiveSkillPaths: ["/paper/.easyresearch/skills/shared"],
    })]);
    let releaseRefresh!: () => void;
    state.models.refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshBaseline = state.models.refreshCalls.length;

    const attaching = state.binding.attach(session);
    await vi.waitFor(() => expect(state.models.refreshCalls).toHaveLength(refreshBaseline + 1));
    state.live.publishApiUsageDisplay();
    releaseRefresh();
    await attaching;

    expect(state.binding.generation()).toBe(3);
    expect(state.binding.skillPaths()).toEqual(["/paper/.easyresearch/skills/shared"]);
    expect(session.reloadCalls).toBe(1);
    expect(session.model?.name).toBe("metadata-v2");
  });

  it("marks attach catch-up before a display event can run ahead of the preparation microtask", async () => {
    const state = createHarness(definition("v1", {
      effectiveSkillPaths: ["/agent/skills/shared"],
    }));
    await state.binding.ensureCurrent();
    const session = new FakeSession();
    session.model = state.binding.model();
    session.thinkingLevel = state.binding.thinking();
    state.models.setNext(model("metadata-v2"));
    state.live.publishSkills([definition("v1", {
      effectiveSkillPaths: ["/paper/.easyresearch/skills/shared"],
    })]);

    const attaching = state.binding.attach(session);
    state.live.publishApiUsageDisplay();
    await attaching;

    expect(state.binding.generation()).toBe(3);
    expect(state.binding.skillPaths()).toEqual(["/paper/.easyresearch/skills/shared"]);
    expect(session.reloadCalls).toBe(1);
  });

  it("reloads an idle runtime for same-path Skill metadata or body changes", async () => {
    const state = createHarness(definition("v1", {
      effectiveSkillPaths: ["/agent/skills/shared"],
    }));
    const attached = await attachHarness(state);

    state.live.publishSkills([definition("v1", {
      effectiveSkillPaths: ["/agent/skills/shared"],
    })]);

    await vi.waitFor(() => expect(state.binding.generation()).toBe(2));
    expect(attached.session.reloadCalls).toBe(1);
    expect(attached.observed().skills).toEqual(["/agent/skills/shared"]);
  });

  it("does not mutate an active response or tool batch until the awaited turn-end boundary", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    state.models.setNext(model("metadata-v2"));

    state.live.publish([definition("v2")]);
    await Promise.resolve();
    await state.binding.ensureCurrent();

    expect(state.binding.current().systemPrompt).toBe("Prompt v1");
    expect(attached.session.reloadCalls).toBe(0);

    await state.binding.ensureCurrent({ activeBoundary: true });

    expect(state.binding.current().systemPrompt).toBe("Prompt v2");
    expect(attached.observed().tools).toEqual(["tool-v2"]);
    expect(attached.session.abortCalls).toBe(0);
  });

  it("defers an idle apply when an agent run starts during asynchronous preparation", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    state.models.setNext(model("metadata-v2"));
    state.live.publish([definition("v2")]);
    attached.session.isIdle = true;
    let releaseRefresh!: () => void;
    state.models.refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshBaseline = state.models.refreshCalls.length;

    const applying = state.binding.ensureCurrent();
    await vi.waitFor(() => expect(state.models.refreshCalls).toHaveLength(refreshBaseline + 1));
    attached.session.isIdle = false;
    releaseRefresh();
    await applying;

    expect(attached.session.reloadCalls).toBe(0);
    expect(state.binding.current().systemPrompt).toBe("Prompt v1");

    state.models.refreshGate = undefined;
    await state.binding.ensureCurrent({ activeBoundary: true });
    expect(attached.session.reloadCalls).toBe(1);
    expect(state.binding.current().systemPrompt).toBe("Prompt v2");
  });

  it("discards a valid stale candidate and applies the generation accepted by the post-prepare synchronization", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    state.models.setNext(model("metadata-v2"));
    state.live.publish([definition("v2")]);
    let boundarySynchronizations = 0;
    state.live.synchronizeImpl = () => {
      boundarySynchronizations += 1;
      if (boundarySynchronizations === 2) {
        state.models.setNext(model("metadata-v3"));
        state.live.publish([definition("v3")]);
      }
    };
    const refreshBaseline = state.models.refreshCalls.length;

    await state.binding.ensureCurrent({ activeBoundary: true });

    expect(state.binding.current().systemPrompt).toBe("Prompt v3");
    expect(attached.session.model?.name).toBe("metadata-v3");
    expect(attached.session.reloadCalls).toBe(1);
    expect(state.models.refreshCalls).toHaveLength(refreshBaseline + 2);
  });

  it.each(["invalid", "closed"])(
    "discards a candidate when the post-prepare boundary is %s without advancing generation",
    async () => {
      const state = createHarness();
      const attached = await attachHarness(state);
      attached.session.isIdle = false;
      state.models.setNext(model("metadata-v2"));
      state.live.publish([definition("v2")]);
      let boundarySynchronizations = 0;
      state.live.synchronizeImpl = () => {
        boundarySynchronizations += 1;
        if (boundarySynchronizations === 2) state.live.authoritative = false;
      };

      const failure = await state.binding.ensureCurrent({ activeBoundary: true }).catch((error) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toMatch(/runtime configuration/i);
      expect(state.binding.current().systemPrompt).toBe("Prompt v1");
      expect(attached.session.reloadCalls).toBe(0);
      expect(state.models.runtimes.at(-1)?.disposeCalls).toBe(1);
    },
  );

  it.each([
    ["close", (live: FakeLiveConfiguration) => { live.closed = true; }],
    ["validation failure", (live: FakeLiveConfiguration) => { live.validationClean = false; }],
  ] as const)(
    "rejects a candidate when %s invalidates authority in the final return microtask",
    async (_name, invalidate) => {
      const state = createHarness();
      const attached = await attachHarness(state);
      attached.session.isIdle = false;
      state.models.setNext(model("metadata-v2"));
      state.live.publish([definition("v2")]);
      let scheduled = false;
      state.live.onCurrentCheck = () => {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => invalidate(state.live));
      };

      const failure = await state.binding.ensureCurrent({ activeBoundary: true }).catch((error) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toMatch(/runtime configuration/i);
      expect(state.binding.current().systemPrompt).toBe("Prompt v1");
      expect(attached.session.reloadCalls).toBe(0);
      expect(state.models.runtimes.at(-1)?.disposeCalls).toBe(1);
    },
  );

  it("redacts an activity-discard failure and retains the candidate for teardown retry", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    state.models.setNext(model("metadata-v2"));
    state.live.publish([definition("v2")]);
    attached.session.isIdle = true;
    let releaseRefresh!: () => void;
    state.models.refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    state.models.disposeError = new Error("SECRET discard failure at /private/models.json");

    const applying = state.binding.ensureCurrent();
    await vi.waitFor(() => expect(state.models.runtimes).toHaveLength(2));
    attached.session.isIdle = false;
    releaseRefresh();
    const failure = await applying.catch((error) => error);
    const candidate = state.models.runtimes.at(-1)!;

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/runtime configuration/i);
    expect(failure.message).not.toContain("SECRET");
    expect(failure.message).not.toContain("/private/models.json");
    expect(candidate.disposeCalls).toBe(1);
    expect(state.binding.current().systemPrompt).toBe("Prompt v1");

    state.models.disposeError = undefined;
    await state.binding.dispose();
    expect(candidate.disposeCalls).toBe(2);
  });

  it("redacts a generation-discard failure and retains one cleanup attempt for retry", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    state.models.setNext(model("metadata-v2"));
    state.live.publish([definition("v2")]);
    let boundarySynchronizations = 0;
    state.live.synchronizeImpl = () => {
      boundarySynchronizations += 1;
      if (boundarySynchronizations === 2) {
        state.models.setNext(model("metadata-v3"));
        state.live.publish([definition("v3")]);
      }
    };
    state.models.disposeError = new Error("SECRET stale candidate at /private/models.json");

    const failure = await state.binding.ensureCurrent({ activeBoundary: true }).catch((error) => error);
    const candidate = state.models.runtimes.at(-1)!;

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/runtime configuration/i);
    expect(failure.message).not.toContain("SECRET");
    expect(failure.message).not.toContain("/private/models.json");
    expect(candidate.disposeCalls).toBe(1);
    expect(state.binding.current().systemPrompt).toBe("Prompt v1");
    expect(attached.session.reloadCalls).toBe(0);

    state.models.disposeError = undefined;
    await state.binding.dispose();
    expect(candidate.disposeCalls).toBe(2);
  });

  it("coalesces three concurrent safe-boundary checks into one apply", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    state.models.setNext(model("metadata-v2"));
    state.live.publish([definition("v2")]);
    attached.session.isIdle = true;
    let release!: () => void;
    state.models.refreshGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshBaseline = state.models.refreshCalls.length;

    const checks = [
      state.binding.ensureCurrent(),
      state.binding.ensureCurrent(),
      state.binding.ensureCurrent(),
    ];
    await vi.waitFor(() => expect(state.models.refreshCalls).toHaveLength(refreshBaseline + 1));
    release();
    await Promise.all(checks);

    expect(attached.session.reloadCalls).toBe(1);
    expect(state.binding.current().systemPrompt).toBe("Prompt v2");
  });

  it("escalates a joined active boundary after the idle candidate is discarded", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    state.models.setNext(model("metadata-v2"));
    state.live.publish([definition("v2")]);
    attached.session.isIdle = true;
    let releaseRefresh!: () => void;
    state.models.refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshBaseline = state.models.refreshCalls.length;

    const idleApply = state.binding.ensureCurrent();
    await vi.waitFor(() => expect(state.models.refreshCalls).toHaveLength(refreshBaseline + 1));
    attached.session.isIdle = false;
    const activeApply = state.binding.ensureCurrent({ activeBoundary: true });
    releaseRefresh();
    await Promise.all([idleApply, activeApply]);

    expect(state.models.refreshCalls).toHaveLength(refreshBaseline + 2);
    expect(attached.session.reloadCalls).toBe(1);
    expect(attached.observed()).toMatchObject({
      prompt: ["Pi base", "Prompt v2"],
      tools: ["tool-v2"],
    });
    expect(attached.session.model?.name).toBe("metadata-v2");
  });

  it("owns active demand queued between worker exit and apply-promise clearing", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    state.models.setNext(model("metadata-v2"));
    state.live.publish([definition("v2")]);
    attached.session.isIdle = true;
    let releaseRefresh!: () => void;
    state.models.refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshBaseline = state.models.refreshCalls.length;

    const idleApply = state.binding.ensureCurrent();
    await vi.waitFor(() => expect(state.models.refreshCalls).toHaveLength(refreshBaseline + 1));
    attached.session.isIdle = false;
    state.live.signalCurrent();
    let idleReads = 0;
    let activeApply: Promise<void> | undefined;
    attached.session.onIdleRead = () => {
      idleReads += 1;
      if (idleReads === 2) {
        queueMicrotask(() => {
          activeApply = state.binding.ensureCurrent({ activeBoundary: true });
        });
      }
    };
    releaseRefresh();

    await idleApply;
    await vi.waitFor(() => expect(activeApply).toBeDefined());
    await activeApply;

    expect(state.models.refreshCalls).toHaveLength(refreshBaseline + 2);
    expect(attached.session.reloadCalls).toBe(1);
    expect(state.binding.current().systemPrompt).toBe("Prompt v2");
  });

  it("restores the prior binding and resources after reload failure, then retries the generation", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    state.models.setNext(model("metadata-v2"));
    state.live.publish([definition("v2")]);
    attached.session.failNextReload = new Error("SECRET /private/reload-path");

    const failure = await state.binding.ensureCurrent({ activeBoundary: true }).catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/runtime configuration/i);
    expect(failure.message).not.toContain("SECRET");
    expect(failure.message).not.toContain("/private/reload-path");
    expect(state.binding.current().systemPrompt).toBe("Prompt v1");
    expect(attached.observed().prompt).toEqual(["Pi base", "Prompt v1"]);
    expect(attached.session.reloadCalls).toBe(2);

    await state.binding.ensureCurrent({ activeBoundary: true });

    expect(state.binding.current().systemPrompt).toBe("Prompt v2");
    expect(attached.observed().prompt).toEqual(["Pi base", "Prompt v2"]);
  });

  it.each(["preparation", "reload", "restoration", "compaction"] as const)(
    "does not project a generation on %s failure and projects its later coherent retry once",
    async (failurePoint) => {
      const state = createHarness();
      const attached = await attachHarness(state);
      state.onApplied.mockClear();
      attached.session.isIdle = false;
      state.models.setNext(model("metadata-v2"));
      if (failurePoint === "preparation") {
        state.models.createError = new Error("candidate creation failed");
      } else if (failurePoint === "reload") {
        attached.session.reloadFailures.push(new Error("candidate reload failed"));
      } else if (failurePoint === "restoration") {
        attached.session.reloadFailures.push(
          new Error("candidate reload failed"),
          new Error("prior reload restoration failed"),
        );
      } else {
        state.compactionFailures.push(new Error("candidate compaction failed"));
      }
      state.live.publish([definition("v2")]);

      await expect(state.binding.ensureCurrent({ activeBoundary: true })).rejects.toThrow(/runtime configuration/i);

      expect(state.onApplied).not.toHaveBeenCalled();

      state.models.refreshResult = { aborted: false, errors: new Map() };
      await state.binding.ensureCurrent({ activeBoundary: true });

      expect(state.onApplied).toHaveBeenCalledOnce();
      expect(state.onApplied).toHaveBeenCalledWith(2);
      expect(state.binding.generation()).toBe(2);
      expect(attached.session.model?.name).toBe("metadata-v2");
      expect(attached.session.thinkingLevel).toBe("high");
    },
  );

  it.each(["resources", "model", "thinking", "compaction"] as const)(
    "poisons access after %s restoration fails and clears poison only after a coherent retry",
    async (failedRestoration) => {
      const state = createHarness();
      const attached = await attachHarness(state);
      attached.session.isIdle = false;
      state.models.setNext(model("metadata-v2"));
      state.live.publish([definition("v2")]);

      if (failedRestoration === "resources") {
        attached.session.reloadFailures.push(
          new Error("candidate resource apply failed"),
          new Error("prior resource restoration failed"),
        );
      } else {
        attached.session.modelFailures.push(new Error("candidate model apply failed"));
        if (failedRestoration === "model") {
          attached.session.modelFailures.push(new Error("prior model restoration failed"));
        } else if (failedRestoration === "thinking") {
          attached.session.thinkingFailures.push(new Error("prior thinking restoration failed"));
        } else {
          state.compactionFailures.push(new Error("prior compaction restoration failed"));
        }
      }

      await expect(state.binding.ensureCurrent({ activeBoundary: true })).rejects.toThrow(/runtime configuration/i);

      const blockedAccessors = [
        () => state.binding.generation(),
        () => state.binding.current(),
        () => state.binding.model(),
        () => state.binding.modelRuntime(),
        () => state.binding.thinking(),
        () => state.binding.compactionPolicy(),
        () => state.binding.appendSystemPrompt(["Pi base"]),
        () => state.binding.skillPaths(),
      ];
      for (const access of blockedAccessors) expect(access).toThrow(/runtime configuration/i);
      await expect(state.binding.reapplyCompaction()).rejects.toThrow(/runtime configuration/i);
      expect(state.models.runtimes[1]?.disposeCalls).toBe(1);
      expect(attached.session.abortCalls).toBe(1);

      await state.binding.ensureCurrent({ activeBoundary: true });

      expect(state.binding.generation()).toBe(2);
      expect(state.binding.current().systemPrompt).toBe("Prompt v2");
      expect(state.binding.skillPaths()).toEqual(["/skills/skill-v2"]);
      expect(attached.session.model?.name).toBe("metadata-v2");
      expect(attached.session.thinkingLevel).toBe("high");
      expect(state.binding.compactionPolicy()).toEqual({ triggerPercent: 70, enabled: true });
    },
  );

  it("rolls back failed Skill-path application and retries the same accepted generation", async () => {
    const state = createHarness(definition("v1", {
      effectiveSkillPaths: ["/paper/.easyresearch/skills/shared"],
    }));
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    attached.session.failNextReload = new Error("Skill reload failed");
    state.live.publishSkills([definition("v1", {
      effectiveSkillPaths: ["/agent/skills/shared"],
    })]);

    await expect(state.binding.ensureCurrent({ activeBoundary: true })).rejects.toThrow(/runtime configuration/i);

    expect(state.binding.generation()).toBe(1);
    expect(state.binding.skillPaths()).toEqual(["/paper/.easyresearch/skills/shared"]);
    expect(attached.observed().skills).toEqual(["/paper/.easyresearch/skills/shared"]);

    await state.binding.ensureCurrent({ activeBoundary: true });

    expect(state.binding.generation()).toBe(2);
    expect(attached.observed().skills).toEqual(["/agent/skills/shared"]);
  });

  it("redacts a failed active rollback and retains the candidate for teardown retry", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    state.models.setNext(model("metadata-v2"));
    state.live.publish([definition("v2")]);
    attached.session.failNextReload = new Error("apply failed");
    state.models.disposeError = new Error("SECRET rollback failure at /private/models.json");

    const failure = await state.binding.ensureCurrent({ activeBoundary: true }).catch((error) => error);
    const candidate = state.models.runtimes.at(-1)!;

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/runtime configuration/i);
    expect(failure.message).not.toContain("SECRET");
    expect(failure.message).not.toContain("/private/models.json");
    expect(candidate.disposeCalls).toBe(1);
    expect(state.binding.current().systemPrompt).toBe("Prompt v1");
    expect(attached.session.model).toBe(state.initialModel);

    state.models.disposeError = undefined;
    await state.binding.dispose();
    expect(candidate.disposeCalls).toBe(2);
  });

  it("applies registered configuration when availability refresh reports an error", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    state.models.setNext(model("metadata-v2"));
    state.models.refreshResult = {
      aborted: false,
      errors: new Map([["test-provider", new Error("SECRET stale metadata")]]),
    };
    state.live.publish([definition("v2")]);

    await state.binding.ensureCurrent({ activeBoundary: true });
    expect(state.binding.current().systemPrompt).toBe("Prompt v2");
    expect(attached.session.model?.name).toBe("metadata-v2");
    expect(attached.session.abortCalls).toBe(0);
  });

  it("awaits direct session abort before rejecting an active-boundary failure", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    state.models.setNext(model("metadata-v2"));
    state.models.createError = new Error("candidate creation failed");
    state.live.publish([definition("v2")]);
    let releaseAbort!: () => void;
    const abortGate = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    attached.session.abortImpl = () => abortGate;
    let settled = false;

    const applying = state.binding.ensureCurrent({ activeBoundary: true }).finally(() => {
      settled = true;
    });
    void applying.catch(() => {});
    await vi.waitFor(() => expect(attached.session.abortCalls).toBe(1));
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseAbort();

    await expect(applying).rejects.toThrow(/runtime configuration/i);
    expect(settled).toBe(true);
  });

  it("signals internal recovery only after a failed generation later applies coherently", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    state.onRuntimeCoherent.mockClear();
    attached.session.isIdle = false;
    state.models.setNext(model("metadata-v2"));
    attached.session.reloadFailures.push(
      new Error("candidate resource apply failed"),
      new Error("prior resource restoration failed"),
    );
    state.live.publish([definition("v2")]);

    await expect(state.binding.ensureCurrent({ activeBoundary: true })).rejects.toThrow(/runtime configuration/i);
    expect(state.onRuntimeCoherent).not.toHaveBeenCalled();

    await state.binding.ensureCurrent({ activeBoundary: true });

    expect(state.onRuntimeCoherent).toHaveBeenCalledOnce();
  });

  it("commits registered candidate metadata despite availability refresh failure", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    state.models.setNext(model("invalid-metadata"));
    state.models.refreshResult = {
      aborted: false,
      errors: new Map([["test-provider", new Error("invalid candidate")]]),
    };
    state.live.publish([definition("v2")]);

    await state.binding.ensureCurrent({ activeBoundary: true });

    expect(state.binding.modelRuntime().getModel("test-provider", "same-model")?.name).toBe("invalid-metadata");
    expect(attached.session.model?.name).toBe("invalid-metadata");
  });

  it("does not treat a runtime availability diagnostic as structural configuration failure", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    state.models.setNext(model("metadata-v2"));
    state.models.semanticError = "SECRET invalid provider at /private/models.json";
    state.live.publish([definition("v2")]);

    await state.binding.ensureCurrent({ activeBoundary: true });

    expect(state.binding.current().systemPrompt).toBe("Prompt v2");
    expect(attached.session.model?.name).toBe("metadata-v2");
  });

  it("delegates Automatic Research Assistant selection to the injected Pi-native resolver", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    const automatic = model("automatic-selected", "automatic-model");
    state.resolveAutomaticModel.mockResolvedValueOnce(automatic);
    state.models.setNext(model("metadata-v2"));
    state.live.publish([definition("v2", { model: undefined })]);

    await state.binding.ensureCurrent({ activeBoundary: true });

    expect(state.resolveAutomaticModel).toHaveBeenCalledTimes(1);
    expect(attached.session.model).toBe(automatic);
    expect(state.binding.current().model).toBeUndefined();
  });

  it("retries listener disposal after a transient unsubscribe failure", async () => {
    const state = createHarness();
    await state.binding.ensureCurrent();
    const session = new FakeSession();
    let unsubscribeCalls = 0;
    const baseSubscribe = state.live.subscribe.bind(state.live);
    state.live.subscribe = (listener) => {
      const unsubscribe = baseSubscribe(listener);
      return () => {
        unsubscribeCalls += 1;
        if (unsubscribeCalls === 1) throw new Error("unsubscribe failed");
        unsubscribe();
      };
    };
    await state.binding.attach(session);

    await expect(state.binding.dispose()).rejects.toThrow("unsubscribe failed");
    await state.binding.dispose();

    expect(unsubscribeCalls).toBe(2);
  });
});

describe("AgentRuntimeBinding real Pi next-turn integration", () => {
  it("applies one new generation before Pi prepares the tool-result follow-up request", async () => {
    const pi = await importPi();
    const { InMemoryCredentialStore, fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(
      "@earendil-works/pi-ai"
    );
    const { Type } = await import("typebox");
    const root = mkdtempSync(join(tmpdir(), "easyresearch-runtime-binding-"));
    const cwd = join(root, "paper");
    const agentDir = join(root, "agent");
    let binding: AgentRuntimeBinding | undefined;
    let session: Awaited<ReturnType<typeof pi.createAgentSession>>["session"] | undefined;
    let failed = false;
    let failure: unknown;
    try {
      mkdirSync(cwd);
      mkdirSync(agentDir);
      const initialSettings = {
        defaultProvider: "preserved-provider",
        defaultModel: "preserved-model",
        defaultThinkingLevel: "medium",
        easyresearch: {
          agentDefaults: {
            "research-assistant": {
              model: "test-provider/same-model",
              thinking: "low",
            },
          },
        },
      };
      const before = `${JSON.stringify(initialSettings, null, 2)}\n`;
      writeFileSync(join(agentDir, "settings.json"), before);
      const live = new FakeLiveConfiguration([definition("v1", {
        tools: ["tool-v1"],
        effectiveTools: ["tool-v1"],
        skills: undefined,
        effectiveSkills: [],
        effectiveSkillPaths: [],
      })]);
      const firstProvider = fauxProvider({
        provider: "test-provider",
        models: [{ id: "same-model", name: "metadata-v1", reasoning: true }],
      });
      const secondRequests: Array<{
        model: Model<any>;
        systemPrompt: string | undefined;
        tools: string[];
        descriptions: string[];
        thinking: unknown;
      }> = [];
      const secondProvider = fauxProvider({
        provider: "test-provider",
        models: [{ id: "same-model", name: "metadata-v2", reasoning: true }],
      });
      firstProvider.setResponses([
        fauxAssistantMessage(fauxToolCall("tool-v1", {}), { stopReason: "toolUse" }),
      ]);
      secondProvider.setResponses([
        (context, options, _state, requestModel) => {
          secondRequests.push({
            model: requestModel,
            systemPrompt: context.systemPrompt,
            tools: context.tools?.map((tool) => tool.name) ?? [],
            descriptions: context.tools?.map((tool) => tool.description) ?? [],
            thinking: options?.reasoning,
          });
          return fauxAssistantMessage("generation-v2 complete");
        },
      ]);
      const credentials = new InMemoryCredentialStore();
      const settings = pi.SettingsManager.create(cwd, agentDir);
      binding = createAgentRuntimeBinding({
        live,
        agentName: "research-assistant",
        cwd,
        createModelRuntime: async () => {
          const runtime = await pi.ModelRuntime.create({
            credentials,
            modelsPath: null,
            refreshOnCreate: false,
          });
          runtime.registerNativeProvider(
            live.generation === 1 ? firstProvider.provider : secondProvider.provider,
          );
          return runtime;
        },
        resolveAutomaticModel: async () => undefined,
        compaction: createCompactionPolicyBinding(settings),
      });
      await binding.ensureCurrent();
      const modelRuntime = binding.modelRuntime() as typeof pi.ModelRuntime.prototype;
      const resourceLoader = new pi.DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: settings,
        extensionFactories: [{
          name: "agent-definition",
          factory: createAgentDefinitionExtension(binding),
        }],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalSkillPaths: [],
        appendSystemPromptOverride: (base) => binding!.appendSystemPrompt(base),
      });
      await resourceLoader.reload({ resolveProjectTrust: async () => true });
      const sessionManager = pi.SessionManager.create(cwd, join(root, "sessions"));
      const created = await pi.createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        settingsManager: settings,
        sessionManager,
        resourceLoader,
        model: binding.model(),
        thinkingLevel: binding.thinking(),
        customTools: [
          {
            name: "tool-v1",
            label: "Tool V1",
            description: "schema-v1",
            parameters: Type.Object({}),
            execute: async () => {
              live.publish([definition("v2", {
                tools: ["tool-v2"],
                effectiveTools: ["tool-v2"],
                 skills: undefined,
                 effectiveSkills: [],
                 effectiveSkillPaths: [],
              })]);
              return { content: [{ type: "text" as const, text: "updated" }], details: {} };
            },
          },
          {
            name: "tool-v2",
            label: "Tool V2",
            description: "schema-v2",
            parameters: Type.Object({ value: Type.Optional(Type.String()) }),
            execute: async () => ({ content: [{ type: "text" as const, text: "v2" }], details: {} }),
          },
        ],
      });
      session = created.session;
      const persistedModelChangesBefore = sessionManager.getEntries()
        .filter((entry) => entry.type === "model_change").length;
      await session.bindExtensions({
        mode: "rpc",
        commandContextActions: {
          waitForIdle: () => session!.waitForIdle(),
          newSession: async () => ({ cancelled: true }),
          fork: async () => ({ cancelled: true }),
          switchSession: async () => ({ cancelled: true }),
          navigateTree: async () => ({ cancelled: false }),
          reload: () => session!.reload(),
        },
      });
      await attachPiSession(binding, session);

      await session.prompt("run the configured tool");

      expect(secondRequests).toHaveLength(1);
      expect(secondRequests[0]).toMatchObject({
        model: { provider: "test-provider", id: "same-model", name: "metadata-v2" },
        tools: ["tool-v2"],
        descriptions: ["schema-v2"],
        thinking: "high",
      });
      expect(secondRequests[0]?.systemPrompt).toContain("Prompt v2");
      expect(secondRequests[0]?.systemPrompt).not.toContain("Prompt v1");
      expect(session.model).toBe(secondProvider.getModel("same-model"));
      expect(session.thinkingLevel).toBe("high");
      expect(sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toHaveLength(
        persistedModelChangesBefore,
      );
      await settings.flush();
      expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(before);
      expect(settings.getDefaultProvider()).toBe("preserved-provider");
      expect(settings.getDefaultModel()).toBe("preserved-model");
      expect(settings.getDefaultThinkingLevel()).toBe("medium");
    } catch (error) {
      failed = true;
      failure = error;
    }

    const cleanupErrors: unknown[] = [];
    try {
      await binding?.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      session?.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }

    if (failed) throw failure;
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "real Pi next-turn test cleanup failed");
    }
  });

  it("stops before a follow-up provider request when turn-end configuration application fails", async () => {
    const pi = await importPi();
    const { InMemoryCredentialStore, fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(
      "@earendil-works/pi-ai"
    );
    const { Type } = await import("typebox");
    const live = new FakeLiveConfiguration([definition("v1", {
      tools: ["tool-v1"],
      effectiveTools: ["tool-v1"],
      skills: undefined,
      effectiveSkills: [],
      effectiveSkillPaths: [],
    })]);
    let providerRequests = 0;
    const provider = fauxProvider({
      provider: "test-provider",
      models: [{ id: "same-model", name: "metadata-v1", reasoning: true }],
    });
    provider.setResponses([
      () => {
        providerRequests += 1;
        return fauxAssistantMessage(fauxToolCall("tool-v1", {}), { stopReason: "toolUse" });
      },
      () => {
        providerRequests += 1;
        return fauxAssistantMessage("stale generation continued");
      },
    ]);
    const credentials = new InMemoryCredentialStore();
    const settings = pi.SettingsManager.inMemory();
    const binding = createAgentRuntimeBinding({
      live,
      agentName: "research-assistant",
      cwd: "/paper",
      createModelRuntime: async () => {
        const runtime = await pi.ModelRuntime.create({
          credentials,
          modelsPath: null,
          refreshOnCreate: false,
        });
        runtime.registerNativeProvider(provider.provider);
        return runtime;
      },
      resolveAutomaticModel: async () => undefined,
      compaction: createCompactionPolicyBinding(settings),
    });
    await binding.ensureCurrent();
    const modelRuntime = binding.modelRuntime() as typeof pi.ModelRuntime.prototype;
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: "/paper",
      agentDir: "/agent",
      settingsManager: settings,
      extensionFactories: [{
        name: "agent-definition",
        factory: createAgentDefinitionExtension(binding),
      }],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalSkillPaths: [],
      appendSystemPromptOverride: (base) => binding.appendSystemPrompt(base),
    });
    await resourceLoader.reload({ resolveProjectTrust: async () => true });
    let session: Awaited<ReturnType<typeof pi.createAgentSession>>["session"] | undefined;
    try {
      const created = await pi.createAgentSession({
        cwd: "/paper",
        agentDir: "/agent",
        modelRuntime,
        settingsManager: settings,
        sessionManager: pi.SessionManager.inMemory("/paper"),
        resourceLoader,
        model: binding.model(),
        thinkingLevel: binding.thinking(),
        customTools: [{
          name: "tool-v1",
          label: "Tool V1",
          description: "publishes an invalid model configuration",
          parameters: Type.Object({}),
          execute: async () => {
            live.publish([definition("v2", {
              model: "missing-provider/missing-model",
              tools: ["tool-v1"],
              effectiveTools: ["tool-v1"],
              skills: undefined,
              effectiveSkills: [],
              effectiveSkillPaths: [],
            })]);
            return { content: [{ type: "text" as const, text: "updated" }], details: {} };
          },
        }],
      });
      session = created.session;
      await session.bindExtensions({
        mode: "rpc",
        commandContextActions: {
          waitForIdle: () => session!.waitForIdle(),
          newSession: async () => ({ cancelled: true }),
          fork: async () => ({ cancelled: true }),
          switchSession: async () => ({ cancelled: true }),
          navigateTree: async () => ({ cancelled: false }),
          reload: () => session!.reload(),
        },
      });
      await attachPiSession(binding, session);

      await session.prompt("publish an invalid generation");

      expect(providerRequests).toBe(1);
    } finally {
      await binding.dispose();
      session?.dispose();
    }
  });

  it("directly aborts a stale-runner follow-up when candidate and restoration reload both fail", async () => {
    const pi = await importPi();
    const { InMemoryCredentialStore, fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(
      "@earendil-works/pi-ai"
    );
    const { Type } = await import("typebox");
    const live = new FakeLiveConfiguration([definition("v1", {
      tools: ["tool-v1"],
      effectiveTools: ["tool-v1"],
      skills: undefined,
      effectiveSkills: [],
      effectiveSkillPaths: [],
    })]);
    let providerRequests = 0;
    const provider = fauxProvider({
      provider: "test-provider",
      models: [{ id: "same-model", name: "metadata", reasoning: true }],
    });
    provider.setResponses([
      () => {
        providerRequests += 1;
        return fauxAssistantMessage(fauxToolCall("tool-v1", {}), { stopReason: "toolUse" });
      },
      () => {
        providerRequests += 1;
        return fauxAssistantMessage("poisoned stale runner continued");
      },
    ]);
    const credentials = new InMemoryCredentialStore();
    const settings = pi.SettingsManager.inMemory();
    const binding = createAgentRuntimeBinding({
      live,
      agentName: "research-assistant",
      cwd: "/paper",
      createModelRuntime: async () => {
        const runtime = await pi.ModelRuntime.create({
          credentials,
          modelsPath: null,
          refreshOnCreate: false,
        });
        runtime.registerNativeProvider(provider.provider);
        return runtime;
      },
      resolveAutomaticModel: async () => undefined,
      compaction: createCompactionPolicyBinding(settings),
    });
    await binding.ensureCurrent();
    const modelRuntime = binding.modelRuntime() as typeof pi.ModelRuntime.prototype;
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: "/paper",
      agentDir: "/agent",
      settingsManager: settings,
      extensionFactories: [{ name: "agent-definition", factory: createAgentDefinitionExtension(binding) }],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalSkillPaths: [],
      appendSystemPromptOverride: (base) => binding.appendSystemPrompt(base),
    });
    await resourceLoader.reload({ resolveProjectTrust: async () => true });
    let session: Awaited<ReturnType<typeof pi.createAgentSession>>["session"] | undefined;
    try {
      const created = await pi.createAgentSession({
        cwd: "/paper",
        agentDir: "/agent",
        modelRuntime,
        settingsManager: settings,
        sessionManager: pi.SessionManager.inMemory("/paper"),
        resourceLoader,
        model: binding.model(),
        thinkingLevel: binding.thinking(),
        customTools: [{
          name: "tool-v1",
          label: "Tool V1",
          description: "publishes a valid generation before reload failure",
          parameters: Type.Object({}),
          execute: async () => {
            live.publish([definition("v2", {
              tools: ["tool-v1"],
              effectiveTools: ["tool-v1"],
              skills: undefined,
              effectiveSkills: [],
              effectiveSkillPaths: [],
            })]);
            return { content: [{ type: "text" as const, text: "updated" }], details: {} };
          },
        }],
      });
      session = created.session;
      await session.bindExtensions({
        mode: "rpc",
        commandContextActions: {
          waitForIdle: () => session!.waitForIdle(),
          newSession: async () => ({ cancelled: true }),
          fork: async () => ({ cancelled: true }),
          switchSession: async () => ({ cancelled: true }),
          navigateTree: async () => ({ cancelled: false }),
          reload: () => session!.reload(),
        },
      });
      await attachPiSession(binding, session);
      const originalReload = resourceLoader.reload.bind(resourceLoader);
      let remainingReloadFailures = 2;
      vi.spyOn(resourceLoader, "reload").mockImplementation(async (...args) => {
        if (remainingReloadFailures > 0) {
          remainingReloadFailures -= 1;
          throw new Error("resource reload failed after runner invalidation");
        }
        await originalReload(...args);
      });
      const abort = vi.spyOn(session, "abort");

      await session.prompt("publish a valid generation and fail reload");

      expect(providerRequests).toBe(1);
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      await binding.dispose();
      session?.dispose();
    }
  });
});
