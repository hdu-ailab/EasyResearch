import type { LiveConfiguration } from "../runtime/live-configuration";
import { ConfigurationUnavailableError } from "../runtime/live-configuration";
import {
  PAPER_ASSISTANT_AGENT,
  type AgentConfig,
} from "./agents";

export type DispatchLiveConfiguration = Pick<
  LiveConfiguration,
  "generation" | "synchronize" | "isCurrent" | "resolveAgents" | "subscribe"
>;

export interface CurrentAgentCatalog {
  generation: number;
  agents: AgentConfig[];
}

export interface AgentAuthorizationOptions {
  signal?: AbortSignal;
  maxGenerationRetries?: number;
}

export const AGENT_AUTHORIZATION_ABORTED_MESSAGE = "Agent authorization was cancelled.";

export class AgentAuthorizationAbortedError extends Error {
  constructor() {
    super(AGENT_AUTHORIZATION_ABORTED_MESSAGE);
    this.name = "AgentAuthorizationAbortedError";
  }
}

export class AgentConfigurationChangedError extends Error {
  constructor() {
    super("Agent configuration changed during authorization. Retry the request.");
    this.name = "AgentConfigurationChangedError";
  }
}

export function throwIfAuthorizationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentAuthorizationAbortedError();
}

async function awaitAuthorizationOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAuthorizationAborted(signal);
  if (!signal) return operation;

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new AgentAuthorizationAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function filterAgentsByAllowlist(
  agents: readonly AgentConfig[],
  allowlist?: readonly string[],
  callerAgent?: string,
): AgentConfig[] {
  const eligible = agents.filter((agent) =>
    agent.enabled && agent.name !== PAPER_ASSISTANT_AGENT && agent.name !== callerAgent
  );
  if (allowlist === undefined) return eligible;
  const allowed = new Set(allowlist);
  return eligible.filter((agent) => allowed.has(agent.name));
}

export function availableSubagentsForCaller(
  agents: readonly AgentConfig[],
  callerAgent?: string,
): AgentConfig[] {
  if (!callerAgent) return filterAgentsByAllowlist(agents);
  const caller = agents.find((agent) => agent.name === callerAgent);
  if (!caller?.enabled) return [];
  return filterAgentsByAllowlist(agents, caller.subagents, callerAgent);
}

/** Resolve one validation-clean generation and invoke the consumer without an
 * await gap after the final authority check. The consumer must perform its
 * protected side effect synchronously before returning a promise. */
export async function withCurrentAgentCatalog<T>(
  live: DispatchLiveConfiguration,
  cwd: string,
  consume: (catalog: CurrentAgentCatalog) => T | Promise<T>,
  options: AgentAuthorizationOptions = {},
): Promise<T> {
  let generationRetries = 0;
  const retryGeneration = () => {
    if (generationRetries >= (options.maxGenerationRetries ?? 1)) {
      throw new AgentConfigurationChangedError();
    }
    generationRetries += 1;
  };

  for (;;) {
    throwIfAuthorizationAborted(options.signal);
    await awaitAuthorizationOperation(live.synchronize(), options.signal);
    throwIfAuthorizationAborted(options.signal);
    const generation = live.generation;
    const agents = await awaitAuthorizationOperation(live.resolveAgents(cwd), options.signal);
    throwIfAuthorizationAborted(options.signal);
    if (generation !== live.generation) {
      retryGeneration();
      continue;
    }

    await awaitAuthorizationOperation(live.synchronize(), options.signal);
    throwIfAuthorizationAborted(options.signal);
    if (generation !== live.generation) {
      retryGeneration();
      continue;
    }
    const authoritative = live.isCurrent(generation);
    throwIfAuthorizationAborted(options.signal);
    if (generation !== live.generation) {
      retryGeneration();
      continue;
    }
    if (!authoritative) throw new ConfigurationUnavailableError();

    throwIfAuthorizationAborted(options.signal);
    return await consume({ generation, agents });
  }
}
