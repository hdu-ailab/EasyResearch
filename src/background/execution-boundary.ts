import type { PrepareRequest } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { materializeNativeCustomInput, type ExecutionClaims } from "./execution-claims";

export interface ExecutionClaimBoundary {
  /** Wrap every owned prompt/continuation/custom-message run, including completion wakes. */
  observe<T>(operation: Promise<T> | (() => Promise<T>)): Promise<T>;
  /** Call before publishing an otherwise successful period result. */
  assertHealthy(): void;
  failure(): Error | undefined;
  /** Reattach after an external replacement of the public hook; native 1.6 reload retains it. */
  refresh(): void;
  dispose(): void;
}

/** Host-owned write-ahead boundary: extension runner error isolation cannot bypass it. */
export function installExecutionClaimBoundary(session: Pick<AgentSession, "agent" | "sessionFile" | "sessionManager" | "subscribe">, claims: ExecutionClaims): ExecutionClaimBoundary {
  let disposed = false;
  let failed: Error | undefined;
  let installed: PrepareRequest | undefined;
  let previous: PrepareRequest | undefined;
  const failure = () => failed ?? claims.failure();
  const assertHealthy = () => {
    const error = failure();
    if (error) throw error;
  };
  const remember = (error: unknown): Error => {
    failed ??= error instanceof Error ? error : new Error(String(error));
    return failed;
  };
  const assertOwned = () => {
    assertHealthy();
    try {
      if (!session.sessionFile) throw new Error("Execution requires a materialized native session file.");
      materializeNativeCustomInput(session.sessionManager, session.sessionFile);
      claims.start(session.sessionFile);
      claims.assertDurable(session.sessionFile);
    } catch (error) { throw remember(error); }
  };
  const refresh = () => {
    if (disposed) throw new Error("Execution claim boundary is disposed.");
    if (installed && session.agent.prepareRequest === installed) return;
    const prior = session.agent.prepareRequest;
    previous = prior;
    installed = async (request, signal) => {
      if (disposed) return (await prior?.call(session.agent, request, signal)) ?? undefined;
      assertOwned();
      // Forward untouched; Pi remains the sole projection/provider configuration owner.
      const result = await prior?.call(session.agent, request, signal);
      assertOwned();
      return result ?? undefined;
    };
    session.agent.prepareRequest = installed;
  };
  refresh();
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "agent_settled" || disposed || failure()) return;
    try { claims.settle(); }
    catch (error) {
      // Session subscriptions are synchronous; throwing here would skip Pi's idle
      // cleanup and later observers. Surface through owned results/state instead.
      remember(error);
    }
  });
  return {
    failure, assertHealthy, refresh,
    async observe<T>(operation: Promise<T> | (() => Promise<T>)): Promise<T> {
      if (typeof operation === "function") {
        refresh();
        assertHealthy();
        operation = operation();
      }
      try {
        const result = await operation;
        assertHealthy();
        return result;
      } catch (error) {
        const boundaryError = failure();
        if (boundaryError && boundaryError !== error) throw new AggregateError([boundaryError, error], boundaryError.message);
        throw error;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      if (session.agent.prepareRequest === installed) session.agent.prepareRequest = previous;
    },
  };
}
