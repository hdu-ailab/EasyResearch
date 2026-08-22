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

const SAFE_APPLY_ERROR = "Agent runtime configuration could not be applied. Retry after fixing the configuration.";
const SAFE_MISSING_AGENT = "The configured Agent is not available in the current valid configuration.";

export interface AgentRuntimeModelRuntime {
  refresh(options: { allowNetwork: false }): Promise<unknown>;
  getModel(provider: string, modelId: string): Model<any> | undefined;
  getError(): string | undefined;
}

export interface AgentRuntimeBindingSession {
  readonly isIdle: boolean;
  readonly model: Model<any> | undefined;
  readonly thinkingLevel: ThinkingLevel;
  reload(): Promise<void>;
  setModel(model: Model<any>): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
}

export interface EnsureCurrentOptions {
  /** `turn_end` is active but is Pi's guaranteed pre-next-request boundary. */
  activeBoundary?: boolean;
}

export interface AgentRuntimeBinding {
  generation(): number;
  current(): AgentConfig;
  model(): Model<any> | undefined;
  modelRuntime(): AgentRuntimeModelRuntime;
  thinking(): ThinkingLevel;
  appendSystemPrompt(base: string[]): string[];
  skillPaths(): string[];
  attach(session: AgentRuntimeBindingSession): Promise<void>;
  ensureCurrent(options?: EnsureCurrentOptions): Promise<void>;
  dispose(): Promise<void>;
}

export interface AgentRuntimeBindingOptions {
  live: Pick<LiveConfiguration, "generation" | "synchronize" | "isCurrent" | "resolveAgents" | "subscribe">;
  agentName: string;
  cwd: string;
  createModelRuntime(): Promise<AgentRuntimeModelRuntime>;
  resolveAutomaticModel(modelRuntime: AgentRuntimeModelRuntime): Promise<Model<any> | undefined>;
  resolveSkillPaths(agent: AgentConfig): string[] | Promise<string[]>;
  onError?: (error: Error) => void;
}

interface AppliedRuntimeState {
  generation: number;
  definition: AgentConfig;
  model: Model<any> | undefined;
  thinking: ThinkingLevel;
  skillPaths: string[];
}

interface PreparedRuntimeState extends AppliedRuntimeState {
  modelRuntimeCandidate: ModelRuntimeCandidate<AgentRuntimeModelRuntime>;
}

function modelRefreshFailed(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const refresh = result as { aborted?: unknown; errors?: { size?: unknown } };
  return refresh.aborted === true || (
    typeof refresh.errors === "object" &&
    refresh.errors !== null &&
    typeof refresh.errors.size === "number" &&
    refresh.errors.size > 0
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
  let disposed = false;
  let modelRuntimeDisposed = false;

  const requireApplied = (): AppliedRuntimeState => {
    if (!applied) throw new ConfigurationUnavailableError();
    return applied;
  };

  const prepareCandidate = async (): Promise<PreparedRuntimeState | undefined> => {
    for (;;) {
      let modelRuntimeCandidate: ModelRuntimeCandidate<AgentRuntimeModelRuntime> | undefined;
      const discardModelRuntimeCandidate = async (): Promise<void> => {
        const candidate = modelRuntimeCandidate;
        modelRuntimeCandidate = undefined;
        await candidate?.dispose();
      };
      try {
        await options.live.synchronize();
        if (disposed) throw new Error("Agent runtime binding has been disposed.");
        const generation = options.live.generation;
        if (applied && generation <= applied.generation) return undefined;

        const agents = await options.live.resolveAgents(options.cwd);
        if (generation !== options.live.generation) continue;
        const definition = agents.find((agent) => agent.name === options.agentName);
        if (!definition) throw new Error(SAFE_MISSING_AGENT);
        const researchAssistant = agents.find((agent) => agent.name === RESEARCH_ASSISTANT_AGENT);

        modelRuntimeCandidate = await modelRuntimes.prepare();
        const candidateRuntime = modelRuntimeCandidate.runtime;
        const refresh = await candidateRuntime.refresh({ allowNetwork: false });
        if (modelRefreshFailed(refresh)) throw new Error(SAFE_APPLY_ERROR);
        if (candidateRuntime.getError()) throw new Error(SAFE_APPLY_ERROR);
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

        const skillPaths = await options.resolveSkillPaths(definition);
        if (disposed) throw new Error("Agent runtime binding has been disposed.");
        if (generation !== options.live.generation) {
          await discardModelRuntimeCandidate();
          continue;
        }
        await options.live.synchronize();
        if (disposed) throw new Error("Agent runtime binding has been disposed.");
        if (!options.live.isCurrent(generation)) {
          await discardModelRuntimeCandidate();
          if (generation !== options.live.generation) continue;
          throw new Error(SAFE_APPLY_ERROR);
        }
        return {
          generation,
          definition,
          model: selectedModel,
          thinking: selectedThinking,
          skillPaths: [...skillPaths],
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
  ): Promise<void> => {
    applied = previous;
    if (!session || !previous) return;
    try {
      await session.reload();
    } catch {
      // The prior binding remains authoritative and a later boundary retries.
    }
    if (previousModel) {
      try {
        await session.setModel(previousModel);
      } catch {
        // Best effort: the prior model object can outlive a removed catalog row.
      }
    }
    try {
      session.setThinkingLevel(previousThinking);
    } catch {
      // Best effort after restoring the prior resource binding.
    }
  };

  const applyLatest = async (activeBoundary: boolean): Promise<void> => {
    for (;;) {
      let candidate: PreparedRuntimeState | undefined;
      try {
        candidate = await prepareCandidate();
      } catch (error) {
        if (error instanceof ConfigurationUnavailableError) throw error;
        throw new Error(error instanceof Error && error.message === SAFE_MISSING_AGENT ? SAFE_MISSING_AGENT : SAFE_APPLY_ERROR);
      }
      if (!candidate) return;
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
        return;
      }
      const previous = applied;
      const { modelRuntimeCandidate, ...next } = candidate;
      modelRuntimeCandidate.activate();
      applied = next;
      if (!attached) {
        await modelRuntimeCandidate.commit();
        return;
      }
      const previousModel = attached.model;
      const previousThinking = attached.thinkingLevel;
      try {
        await attached.reload();
        if (disposed) throw new Error(SAFE_APPLY_ERROR);
        if (candidate.model) {
          // Always rebind, including equal provider/id metadata replacements.
          await attached.setModel(candidate.model);
        } else if (attached.model) {
          throw new Error(SAFE_APPLY_ERROR);
        }
        attached.setThinkingLevel(candidate.thinking);
        await modelRuntimeCandidate.commit();
      } catch {
        try {
          await modelRuntimeCandidate.rollback();
        } catch {
          // The prior delegate is already restored; failed cleanup stays retryable.
        }
        await restoreSession(previous, previousModel, previousThinking);
        throw new Error(SAFE_APPLY_ERROR);
      }
      return;
    }
  };

  const ensureCurrent = (ensureOptions: EnsureCurrentOptions = {}): Promise<void> => {
    if (disposed) return Promise.reject(new Error("Agent runtime binding has been disposed."));
    if (ensureOptions.activeBoundary === true) activeBoundaryRequested = true;
    if (session && !session.isIdle && ensureOptions.activeBoundary !== true) return Promise.resolve();
    if (applyPromise) return applyPromise;

    let operation: Promise<void>;
    operation = Promise.resolve().then(async () => {
      try {
        let activeBoundary = false;
        do {
          eventApplyRequested = false;
          if (activeBoundaryRequested) {
            activeBoundary = true;
            activeBoundaryRequested = false;
          }
          await applyLatest(activeBoundary);
        } while (
          !disposed &&
          (
            activeBoundaryRequested ||
            (eventApplyRequested && (session === undefined || session.isIdle || activeBoundary))
          )
        );
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
    appendSystemPrompt(base) {
      return [...base, requireApplied().definition.systemPrompt];
    },
    skillPaths() {
      return [...requireApplied().skillPaths];
    },
    async attach(attached) {
      if (disposed) throw new Error("Agent runtime binding has been disposed.");
      if (session) throw new Error("Agent runtime binding is already attached.");
      requireApplied();
      session = attached;
      unsubscribe = options.live.subscribe((event) => {
        if (event.type !== "config.updated" || event.generation <= requireApplied().generation) return;
        if (applyPromise) eventApplyRequested = true;
        if (!attached.isIdle) return;
        void ensureCurrent().catch((error: unknown) => {
          options.onError?.(error instanceof Error ? error : new Error(SAFE_APPLY_ERROR));
        });
      });
      await ensureCurrent();
    },
    ensureCurrent,
    dispose() {
      if (disposePromise) return disposePromise;
      if (disposed && !unsubscribe && !session && !applyPromise && modelRuntimeDisposed) return Promise.resolve();
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
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "Agent runtime binding disposal failed");
      })().finally(() => {
        disposePromise = undefined;
      });
      return disposePromise;
    },
  };
}
