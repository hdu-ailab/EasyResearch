import { describe, expect, it, vi } from "vitest";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../subagent/agents";
import type { ConfigurationEvent, ConfigurationUpdatedEvent } from "../web/contracts";
import { createAgentDefinitionExtension } from "../extensions/agent-definition";
import { createSessionSettingsFacade } from "./session-settings-facade";
import { createCompactionPolicyBinding } from "./compaction-policy";
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
  error: string | null = null;
  compactionPolicy = { triggerPercent: 70, globalEnabled: true, globalKeepRecentTokens: 20_000 };
  synchronizeCalls = 0;
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

  async synchronize(): Promise<void> {
    this.synchronizeCalls += 1;
    await this.synchronizeImpl?.();
  }

  isCurrent(generation: number): boolean {
    const current = this.authoritative && !this.closed && this.validationClean && generation === this.generation;
    this.onCurrentCheck?.();
    return current;
  }

  async resolveAgents(): Promise<AgentConfig[]> {
    return this.agents.map((agent) => ({
      ...agent,
      tools: agent.tools ? [...agent.tools] : undefined,
      effectiveTools: [...agent.effectiveTools],
      subagents: agent.subagents ? [...agent.subagents] : agent.subagents,
      skills: agent.skills ? [...agent.skills] : undefined,
      effectiveSkills: [...agent.effectiveSkills],
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
    };
    for (const listener of [...this.listeners]) listener(event);
  }

  signalCurrent(): void {
    const event: ConfigurationUpdatedEvent = {
      type: "config.updated",
      generation: this.generation,
      agentsChanged: true,
      modelsChanged: true,
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
  readonly runtimes: FakeModelRuntime[] = [];

  async create(): Promise<FakeModelRuntime> {
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
  modelCalls: Model<any>[] = [];
  thinkingCalls: ThinkingLevel[] = [];
  failNextReload: Error | undefined;
  failNextModel: Error | undefined;
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
    const error = this.failNextReload;
    this.failNextReload = undefined;
    if (error) throw error;
    this.onReload?.();
  }

  async setModel(next: Model<any>): Promise<void> {
    this.modelCalls.push(next);
    const error = this.failNextModel;
    this.failNextModel = undefined;
    if (error) throw error;
    this.model = next;
  }

  setThinkingLevel(next: ThinkingLevel): void {
    this.thinkingCalls.push(next);
    this.thinkingLevel = next;
  }
}

function createHarness(
  initial = definition("v1"),
  onCompactionPolicyChanged = vi.fn(),
  initialModel: Model<any> = model("metadata-v1"),
) {
  const live = new FakeLiveConfiguration([initial]);
  const models = new FakeModelRuntimeFactory();
  models.setNext(initialModel);
  const resolveAutomaticModel = vi.fn(async () => model("automatic", "automatic-model"));
  const settings = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  });
  const compaction = createCompactionPolicyBinding(settings);
  const binding = createAgentRuntimeBinding({
    live,
    agentName: "research-assistant",
    cwd: "/paper",
    createModelRuntime: () => models.create(),
    resolveAutomaticModel,
    resolveSkillPaths: (agent) => agent.effectiveSkills.map((name) => `/skills/${name}`),
    compaction,
    onCompactionPolicyChanged,
  });
  return { live, models, binding, resolveAutomaticModel, initialModel, settings, compaction, onCompactionPolicyChanged };
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

describe("AgentRuntimeBinding safe boundaries", () => {
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

  it("retains the prior generation when Pi reports a local model refresh error", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    state.models.setNext(model("metadata-v2"));
    state.models.refreshResult = {
      aborted: false,
      errors: new Map([["test-provider", new Error("SECRET stale metadata")]]),
    };
    state.live.publish([definition("v2")]);

    const failure = await state.binding.ensureCurrent({ activeBoundary: true }).catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/runtime configuration/i);
    expect(failure.message).not.toContain("SECRET");
    expect(state.binding.current().systemPrompt).toBe("Prompt v1");
    expect(attached.session.reloadCalls).toBe(0);

    state.models.refreshResult = { aborted: false, errors: new Map() };
    await state.binding.ensureCurrent({ activeBoundary: true });
    expect(state.binding.current().systemPrompt).toBe("Prompt v2");
  });

  it("keeps the accepted model runtime unchanged when candidate refresh validation fails", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    state.models.setNext(model("invalid-metadata"));
    state.models.refreshResult = {
      aborted: false,
      errors: new Map([["test-provider", new Error("invalid candidate")]]),
    };
    state.live.publish([definition("v2")]);

    await expect(state.binding.ensureCurrent({ activeBoundary: true })).rejects.toThrow(/runtime configuration/i);

    expect(state.binding.modelRuntime().getModel("test-provider", "same-model")).toBe(state.initialModel);
    expect(attached.session.model).toBe(state.initialModel);
  });

  it("rejects a refreshed model catalog with a semantic runtime error", async () => {
    const state = createHarness();
    const attached = await attachHarness(state);
    attached.session.isIdle = false;
    state.models.setNext(model("metadata-v2"));
    state.models.semanticError = "SECRET invalid provider at /private/models.json";
    state.live.publish([definition("v2")]);

    const failure = await state.binding.ensureCurrent({ activeBoundary: true }).catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/runtime configuration/i);
    expect(failure.message).not.toContain("SECRET");
    expect(failure.message).not.toContain("/private/models.json");
    expect(state.binding.current().systemPrompt).toBe("Prompt v1");
    expect(attached.session.reloadCalls).toBe(0);
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
    const live = new FakeLiveConfiguration([definition("v1", {
      tools: ["tool-v1"],
      effectiveTools: ["tool-v1"],
      skills: undefined,
      effectiveSkills: [],
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
    const settings = createSessionSettingsFacade(pi.SettingsManager.inMemory());
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
        runtime.registerNativeProvider(
          live.generation === 1 ? firstProvider.provider : secondProvider.provider,
        );
        return runtime;
      },
      resolveAutomaticModel: async () => undefined,
      resolveSkillPaths: () => [],
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
      await binding.attach(session);

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
    } finally {
      await binding.dispose();
      session?.dispose();
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
    const settings = createSessionSettingsFacade(pi.SettingsManager.inMemory());
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
      resolveSkillPaths: () => [],
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
      await binding.attach(session);

      await session.prompt("publish an invalid generation");

      expect(providerRequests).toBe(1);
    } finally {
      await binding.dispose();
      session?.dispose();
    }
  });
});
