import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { resolveConfiguredThinking } from "../subagent/thinking-resolution";
import {
  RESEARCH_ASSISTANT_AGENT,
  type AgentConfig,
} from "../subagent/agents";
import {
  ConfigurationUnavailableError,
  type LiveConfiguration,
} from "./live-configuration";
import {
  createModelRuntimeTransaction,
  type ModelRuntimeCandidate,
} from "./model-runtime-transaction";
import type {
  CompactionPolicyBinding,
  EffectiveCompactionPolicy,
  GlobalCompactionPolicy,
} from "./compaction-policy";
import { DEFAULT_GLOBAL_COMPACTION_POLICY } from "./compaction-policy";

const SAFE_APPLY_ERROR = "Agent runtime configuration could not be applied. Retry after fixing the configuration.";
const SAFE_MISSING_AGENT = "The configured Agent is not available in the current valid configuration.";

export interface AgentRuntimeModelRuntime {
  refresh(options: { allowNetwork: false }): Promise<unknown>;
  getModel(provider: string, modelId: string): Model<any> | undefined;
  getAvailableSnapshot(): readonly { provider: string; id: string }[];
  getProvider(providerId: string): unknown;
  getProviderAuthStatus(providerId: string): { configured: boolean };
  getError(): string | undefined;
}

export interface AgentRuntimeBindingSession {
  readonly isIdle: boolean;
  readonly model: Model<any> | undefined;
  readonly thinkingLevel: ThinkingLevel;
  reload(): Promise<void>;
  abort(): Promise<void>;
  rebindModel(model: Model<any> | undefined): void;
  setThinkingLevel(level: ThinkingLevel): void;
}

export interface EnsureCurrentOptions {
  /** `turn_end` is active but is Pi's guaranteed pre-next-request boundary. */
  activeBoundary?: boolean;
  /** Pi reload/save rebuilt effective settings and discarded transient overrides. */
  recaptureCompactionBase?: boolean;
}

export interface AgentRuntimeBinding {
  generation(): number;
  current(): AgentConfig;
  model(): Model<any> | undefined;
  modelRuntime(): AgentRuntimeModelRuntime;
  thinking(): ThinkingLevel;
  compactionPolicy(): EffectiveCompactionPolicy;
  appendSystemPrompt(base: string[]): string[];
  skillPaths(): string[];
  attach(session: AgentRuntimeBindingSession): Promise<void>;
  ensureCurrent(options?: EnsureCurrentOptions): Promise<void>;
  reapplyCompaction(): Promise<void>;
  dispose(): Promise<void>;
}

export interface AgentRuntimeBindingOptions {
  live: Omit<Pick<
    LiveConfiguration,
    | "generation"
    | "availabilityEpoch"
    | "synchronize"
    | "acquireProject"
    | "isCurrent"
    | "resolveAgents"
    | "subscribe"
  >, "availabilityEpoch" | "synchronize"> & {
    readonly availabilityEpoch?: number;
    synchronize(options?: { projectCwds?: readonly string[] }): Promise<unknown>;
  } & Partial<Pick<LiveConfiguration, "compactionPolicy">>;
  agentName: string;
  cwd: string;
  createModelRuntime(): Promise<AgentRuntimeModelRuntime>;
  resolveAutomaticModel(modelRuntime: AgentRuntimeModelRuntime): Promise<Model<any> | undefined>;
  compaction: CompactionPolicyBinding;
  onCompactionPolicyChanged?: (policy: EffectiveCompactionPolicy) => void;
  onRuntimeCoherent?: () => void;
  onApplied?: (generation: number) => void;
  onError?: (error: Error) => void;
}

interface AppliedRuntimeState {
  generation: number;
  availabilityEpoch: number;
  definition: AgentConfig;
  model: Model<any> | undefined;
  thinking: ThinkingLevel;
  skillPaths: string[];
  compactionPolicy: GlobalCompactionPolicy;
}

interface PreparedRuntimeState extends AppliedRuntimeState {
  modelRuntimeCandidate: ModelRuntimeCandidate<AgentRuntimeModelRuntime>;
}

type RuntimeBindingStatus = "clean" | "applying" | "restoring" | "poisoned";

function sameModel(left: Model<any> | undefined, right: Model<any> | undefined): boolean {
  return left === right || (
    left !== undefined &&
    right !== undefined &&
    left.provider === right.provider &&
    left.id === right.id
  );
}

export function createAgentRuntimeBinding(options: AgentRuntimeBindingOptions): AgentRuntimeBinding {
  const modelRuntimes = createModelRuntimeTransaction(options.createModelRuntime);
  let applied: AppliedRuntimeState | undefined;
  let session: AgentRuntimeBindingSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let applyPromise: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;
  let eventApplyRequested = false;
  let activeBoundaryRequested = false;
  let recaptureCompactionBaseRequested = false;
  let abortOnActiveFailureRequested = false;
  let applyingRuntimeModel = false;
  let notifiedCompactionSignature: string | undefined;
  let projectRegistration: Awaited<ReturnType<LiveConfiguration["acquireProject"]>> | undefined;
  let runtimeStatus: RuntimeBindingStatus = "clean";
  let pendingRuntimeGeneration: number | undefined;
  let projectedGeneration = 0;
  let disposed = false;
  let modelRuntimeDisposed = false;

  const requireApplied = (): AppliedRuntimeState => {
    if (runtimeStatus === "poisoned") throw new Error(SAFE_APPLY_ERROR);
    if (!applied) throw new ConfigurationUnavailableError();
    return applied;
  };

  const markRuntimePending = (generation: number): void => {
    pendingRuntimeGeneration = Math.max(pendingRuntimeGeneration ?? 0, generation);
  };

  const markRuntimeApplied = (generation: number): void => {
    if (pendingRuntimeGeneration !== undefined && pendingRuntimeGeneration <= generation) {
      pendingRuntimeGeneration = undefined;
    }
    runtimeStatus = "clean";
  };

  const projectAppliedGeneration = (): void => {
    const generation = applied?.generation;
    if (runtimeStatus !== "clean" || generation === undefined || generation <= projectedGeneration) return;
    projectedGeneration = generation;
    try {
      options.onApplied?.(generation);
    } catch {
      // The public generation projection is observational to binding state.
    }
  };

  const projectAfterCurrentTransaction = (): void => {
    const transaction = applyPromise;
    if (!transaction) {
      projectAppliedGeneration();
      return;
    }
    void transaction.then(projectAppliedGeneration, () => {});
  };

  const applyCompaction = (recaptureBase = false): EffectiveCompactionPolicy => {
    const current = requireApplied();
    const model = session?.model ?? current.model;
    const policy = options.compaction.apply(current.compactionPolicy, model, { recaptureBase });
    const signature = `${policy.triggerPercent}:${policy.enabled}:${model?.contextWindow ?? "none"}`;
    if (!applyingRuntimeModel && signature !== notifiedCompactionSignature) {
      notifiedCompactionSignature = signature;
      options.onCompactionPolicyChanged?.(policy);
    }
    return policy;
  };

  const prepareCandidate = async (): Promise<PreparedRuntimeState | undefined> => {
    const observedGeneration = options.live.generation;
    if (applied && observedGeneration > applied.generation) markRuntimePending(observedGeneration);
    if (!projectRegistration) {
      projectRegistration = await options.live.acquireProject(options.cwd);
    }
    if (disposed) throw new Error("Agent runtime binding has been disposed.");
    for (;;) {
      let modelRuntimeCandidate: ModelRuntimeCandidate<AgentRuntimeModelRuntime> | undefined;
      const discardModelRuntimeCandidate = async (): Promise<void> => {
        const candidate = modelRuntimeCandidate;
        modelRuntimeCandidate = undefined;
        await candidate?.dispose();
      };
      try {
        await options.live.synchronize({ projectCwds: [options.cwd] });
        if (disposed) throw new Error("Agent runtime binding has been disposed.");
        const generation = options.live.generation;
        const availabilityEpoch = options.live.availabilityEpoch ?? 0;
        if (
          applied &&
          generation <= applied.generation &&
          availabilityEpoch <= applied.availabilityEpoch &&
          pendingRuntimeGeneration === undefined &&
          runtimeStatus !== "poisoned"
        ) return undefined;

        const agents = await options.live.resolveAgents(options.cwd);
        if (generation !== options.live.generation) continue;
        const definition = agents.find((agent) => agent.name === options.agentName);
        if (!definition) throw new Error(SAFE_MISSING_AGENT);
        const researchAssistant = agents.find((agent) => agent.name === RESEARCH_ASSISTANT_AGENT);

        modelRuntimeCandidate = await modelRuntimes.prepare();
        const candidateRuntime = modelRuntimeCandidate.runtime;
        try {
          await candidateRuntime.refresh({ allowNetwork: false });
        } catch {
          // Credential/availability refresh failures do not invalidate registered configuration.
        }
        if (disposed) throw new Error("Agent runtime binding has been disposed.");
        if (generation !== options.live.generation) {
          await discardModelRuntimeCandidate();
          continue;
        }

        const resolveExplicitModel = (reference: string): Model<any> => {
          const separator = reference.indexOf("/");
          if (separator <= 0 || separator === reference.length - 1) throw new Error(SAFE_APPLY_ERROR);
          const model = candidateRuntime.getModel(
            reference.slice(0, separator),
            reference.slice(separator + 1),
          );
          if (!model) throw new Error(SAFE_APPLY_ERROR);
          return model;
        };
        const researchAssistantModel = researchAssistant?.model
          ? resolveExplicitModel(researchAssistant.model)
          : await options.resolveAutomaticModel(candidateRuntime);
        const selectedModel = definition.name === RESEARCH_ASSISTANT_AGENT
          ? researchAssistantModel
          : definition.model
            ? resolveExplicitModel(definition.model)
            : researchAssistantModel;
        const researchAssistantThinking = resolveConfiguredThinking(
          researchAssistant ?? {},
          undefined,
          researchAssistantModel,
        );
        const selectedThinking = definition.name === RESEARCH_ASSISTANT_AGENT
          ? researchAssistantThinking
          : resolveConfiguredThinking(definition, researchAssistantThinking, selectedModel);
        if (disposed) throw new Error("Agent runtime binding has been disposed.");
        if (generation !== options.live.generation) {
          await discardModelRuntimeCandidate();
          continue;
        }

        await options.live.synchronize({ projectCwds: [options.cwd] });
        if (disposed) throw new Error("Agent runtime binding has been disposed.");
        if (!options.live.isCurrent(generation)) {
          await discardModelRuntimeCandidate();
          if (generation !== options.live.generation) continue;
          throw new Error(SAFE_APPLY_ERROR);
        }
        return {
          generation,
          availabilityEpoch,
          definition,
          model: selectedModel,
          thinking: selectedThinking,
          skillPaths: [...definition.effectiveSkillPaths],
          compactionPolicy: {
            ...(options.live.compactionPolicy ?? DEFAULT_GLOBAL_COMPACTION_POLICY),
          },
          modelRuntimeCandidate,
        };
      } catch (error) {
        try {
          await discardModelRuntimeCandidate();
        } catch {
          // The transaction retains failed candidate cleanup for disposal retry.
        }
        throw error;
      }
    }
  };

  const restoreSession = async (
    previous: AppliedRuntimeState | undefined,
    previousModel: Model<any> | undefined,
    previousThinking: ThinkingLevel,
  ): Promise<boolean> => {
    applied = previous;
    runtimeStatus = "restoring";
    if (!session || !previous) {
      runtimeStatus = "poisoned";
      return false;
    }
    let restored = true;
    try {
      await session.reload();
    } catch {
      restored = false;
    }
    applyingRuntimeModel = true;
    try {
      session.rebindModel(previousModel);
    } catch {
      restored = false;
    } finally {
      applyingRuntimeModel = false;
    }
    try {
      session.setThinkingLevel(previousThinking);
    } catch {
      restored = false;
    }
    try {
      applyCompaction();
    } catch {
      restored = false;
    }
    runtimeStatus = restored ? "clean" : "poisoned";
    return restored;
  };

  const applyLatest = async (activeBoundary: boolean): Promise<boolean> => {
    for (;;) {
      let candidate: PreparedRuntimeState | undefined;
      try {
        candidate = await prepareCandidate();
      } catch (error) {
        if (error instanceof ConfigurationUnavailableError) throw error;
        throw new Error(error instanceof Error && error.message === SAFE_MISSING_AGENT ? SAFE_MISSING_AGENT : SAFE_APPLY_ERROR);
      }
      if (!candidate) return false;
      if (!options.live.isCurrent(candidate.generation)) {
        try {
          await candidate.modelRuntimeCandidate.dispose();
        } catch {
          throw new Error(SAFE_APPLY_ERROR);
        }
        if (candidate.generation !== options.live.generation) continue;
        throw new Error(SAFE_APPLY_ERROR);
      }

      const attached = session;
      if (attached && !attached.isIdle && !activeBoundary) {
        try {
          await candidate.modelRuntimeCandidate.dispose();
        } catch {
          throw new Error(SAFE_APPLY_ERROR);
        }
        return false;
      }
      const previous = applied;
      const { modelRuntimeCandidate, ...next } = candidate;
      const availabilityOnly = previous !== undefined && candidate.generation === previous.generation;
      modelRuntimeCandidate.activate();
      applied = next;
      runtimeStatus = "applying";
      if (!attached) {
        await modelRuntimeCandidate.commit();
        markRuntimeApplied(candidate.generation);
        return true;
      }
      const previousModel = attached.model;
      const previousThinking = attached.thinkingLevel;
      try {
        if (availabilityOnly) {
          if (!sameModel(previousModel, candidate.model)) attached.rebindModel(candidate.model);
          if (previousThinking !== candidate.thinking) attached.setThinkingLevel(candidate.thinking);
          await modelRuntimeCandidate.commit();
          markRuntimeApplied(candidate.generation);
          return true;
        }
        await attached.reload();
        if (disposed) throw new Error(SAFE_APPLY_ERROR);
        // Host configuration rebinding is non-persisting and bypasses Pi's
        // interactive auth gate. Request preflight remains authoritative.
        applyingRuntimeModel = true;
        try {
          attached.rebindModel(candidate.model);
        } finally {
          applyingRuntimeModel = false;
        }
        attached.setThinkingLevel(candidate.thinking);
        await modelRuntimeCandidate.commit();
        markRuntimeApplied(candidate.generation);
      } catch {
        try {
          await modelRuntimeCandidate.rollback();
        } catch {
          // The prior delegate is already restored; failed cleanup stays retryable.
        }
        await restoreSession(previous, previousModel, previousThinking);
        markRuntimePending(candidate.generation);
        throw new Error(SAFE_APPLY_ERROR);
      }
      return true;
    }
  };

  const ensureCurrent = (ensureOptions: EnsureCurrentOptions = {}): Promise<void> => {
    if (disposed) return Promise.reject(new Error("Agent runtime binding has been disposed."));
    if (ensureOptions.activeBoundary === true) {
      activeBoundaryRequested = true;
      abortOnActiveFailureRequested = true;
    }
    if (ensureOptions.recaptureCompactionBase === true) recaptureCompactionBaseRequested = true;
    if (session && !session.isIdle && ensureOptions.activeBoundary !== true) return Promise.resolve();
    if (applyPromise) return applyPromise;

    let operation: Promise<void>;
    operation = Promise.resolve().then(async () => {
      let runtimeApplied = false;
      try {
        let activeBoundary = false;
        do {
          eventApplyRequested = false;
          if (activeBoundaryRequested) {
            activeBoundary = true;
            activeBoundaryRequested = false;
          }
          const recaptureCompactionBase = recaptureCompactionBaseRequested;
          recaptureCompactionBaseRequested = false;
          const runtimeChanged = await applyLatest(activeBoundary);
          runtimeApplied ||= runtimeChanged;
          if (applied) {
            try {
              applyCompaction(runtimeChanged || recaptureCompactionBase);
            } catch {
              runtimeStatus = "poisoned";
              markRuntimePending(options.live.generation);
              throw new Error(SAFE_APPLY_ERROR);
            }
          }
          projectAppliedGeneration();
        } while (
          !disposed &&
          (
            activeBoundaryRequested ||
            recaptureCompactionBaseRequested ||
            (eventApplyRequested && (session === undefined || session.isIdle || activeBoundary))
          )
        );
        abortOnActiveFailureRequested = false;
        if (runtimeApplied && runtimeStatus === "clean") {
          try {
            options.onRuntimeCoherent?.();
          } catch {
            // Runtime recovery notification is observational to binding state.
          }
        }
      } catch (error) {
        const shouldAbort = abortOnActiveFailureRequested;
        abortOnActiveFailureRequested = false;
        activeBoundaryRequested = false;
        if (shouldAbort && session) {
          try {
            await session.abort();
          } catch {
            // Preserve the safe configuration failure after the abort attempt.
          }
        }
        throw error;
      } finally {
        if (applyPromise === operation) applyPromise = undefined;
      }
    });
    applyPromise = operation;
    return operation;
  };

  return {
    generation() {
      return requireApplied().generation;
    },
    current() {
      return requireApplied().definition;
    },
    model() {
      return requireApplied().model;
    },
    modelRuntime() {
      requireApplied();
      return modelRuntimes.runtime;
    },
    thinking() {
      return requireApplied().thinking;
    },
    compactionPolicy() {
      requireApplied();
      return options.compaction.current();
    },
    appendSystemPrompt(base) {
      return [...base, requireApplied().definition.systemPrompt];
    },
    skillPaths() {
      return [...requireApplied().skillPaths];
    },
    async attach(attached) {
      if (disposed) throw new Error("Agent runtime binding has been disposed.");
      if (session) throw new Error("Agent runtime binding is already attached.");
      const current = requireApplied();
      const acceptedGeneration = options.live.generation;
      if (acceptedGeneration > current.generation) markRuntimePending(acceptedGeneration);
      session = attached;
      if (!sameModel(attached.model, current.model)) attached.rebindModel(current.model);
      unsubscribe = options.live.subscribe((event) => {
        if (event.type !== "config.updated") return;
        if (
          event.availabilityChanged
          && event.availabilityEpoch !== undefined
          && event.availabilityEpoch > (applied?.availabilityEpoch ?? 0)
        ) {
          if (applyPromise) eventApplyRequested = true;
          if (!attached.isIdle) return;
          void ensureCurrent().catch((error: unknown) => {
            options.onError?.(error instanceof Error ? error : new Error(SAFE_APPLY_ERROR));
          });
          return;
        }
        const appliedGeneration = applied?.generation ?? 0;
        if (event.runtimeChanged) {
          if (applyPromise) eventApplyRequested = true;
          if (event.generation <= Math.max(appliedGeneration, pendingRuntimeGeneration ?? 0)) return;
          markRuntimePending(event.generation);
          if (!attached.isIdle) return;
          void ensureCurrent().catch((error: unknown) => {
            options.onError?.(error instanceof Error ? error : new Error(SAFE_APPLY_ERROR));
          });
          return;
        }
        if (event.generation <= appliedGeneration) return;
        if (pendingRuntimeGeneration !== undefined || runtimeStatus !== "clean") {
          if (applyPromise) eventApplyRequested = true;
          return;
        }
        applied = { ...applied!, generation: event.generation };
        projectAfterCurrentTransaction();
      });
      await ensureCurrent();
    },
    ensureCurrent,
    async reapplyCompaction() {
      if (disposed) throw new Error("Agent runtime binding has been disposed.");
      if (applyingRuntimeModel) return;
      try {
        applyCompaction();
      } catch {
        runtimeStatus = "poisoned";
        markRuntimePending(options.live.generation);
        throw new Error(SAFE_APPLY_ERROR);
      }
    },
    dispose() {
      if (disposePromise) return disposePromise;
      if (
        disposed &&
        !unsubscribe &&
        !session &&
        !applyPromise &&
        modelRuntimeDisposed &&
        !projectRegistration
      ) return Promise.resolve();
      disposed = true;
      disposePromise = (async () => {
        const errors: unknown[] = [];
        try {
          unsubscribe?.();
          unsubscribe = undefined;
        } catch (error) {
          errors.push(error);
        }
        try {
          await applyPromise;
        } catch {
          // The owner is tearing down; the apply path already restored what it could.
        }
        session = undefined;
        try {
          await modelRuntimes.dispose();
          modelRuntimeDisposed = true;
        } catch (error) {
          errors.push(error);
        }
        const registration = projectRegistration;
        if (registration) {
          try {
            await registration.release();
            if (projectRegistration === registration) projectRegistration = undefined;
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "Agent runtime binding disposal failed");
      })().finally(() => {
        disposePromise = undefined;
      });
      return disposePromise;
    },
  };
}
