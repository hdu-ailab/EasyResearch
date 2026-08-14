import type { AuthFlowEventDto } from "./contracts";
import type { PromptKind } from "./auth-gateway-logic";

export interface AuthFlowRecord {
  flowId: string;
  bufferedNotifies: AuthFlowEventDto[];
  pendingPrompt: AuthFlowEventDto | null;
  /** Terminal `done`/`error` event, set once by `terminate`. Replayed to late SSE clients. */
  terminalEvent: AuthFlowEventDto | null;
  resolveRespond: ((value: string) => void) | null;
  rejectRespond: ((err: Error) => void) | null;
  abortController: AbortController;
  terminated: boolean;
  subscribers: Set<(event: AuthFlowEventDto) => void>;
  externalSignal?: AbortSignal;
}

export interface AuthFlowStore {
  create(flowId: string, signal: AbortSignal): AuthFlowRecord;
  get(flowId: string): AuthFlowRecord | undefined;
  emit(flowId: string, event: AuthFlowEventDto): void;
  emitPrompt(flowId: string, prompt: AuthFlowEventDto): void;
  awaitRespond(flowId: string): Promise<string>;
  resolveRespond(flowId: string, value: string): boolean;
  rejectRespond(flowId: string, err: Error): void;
  cancel(flowId: string): void;
  terminate(flowId: string, finalEvent: AuthFlowEventDto): AuthFlowEventDto[];
  subscribe(flowId: string, onEvent: (event: AuthFlowEventDto) => void): () => void;
  pendingKind(flowId: string): PromptKind | null;
  list(): string[];
}

/**
 * In-process registry of auth-login flows keyed by `flowId`. Pure: no Pi
 * imports, no fetch. Owns:
 *
 * - buffered notifies emitted before any SSE client connects (replayed on
 *   first subscribe),
 * - at most one outstanding prompt awaiting `respond`,
 * - a deferred that `awaitRespond` returns and that `respond`/`cancel`/
 *   `rejectRespond` settle,
 * - the flow's `AbortController` (cancelled by `cancel`/external abort) and
 * - a live subscriber set forwarded each emitted/prompted/terminated event.
 *
 * The store never touches secrets (they live only in the deferred value
 * string, never in buffered events).
 */
export function createAuthFlowStore(): AuthFlowStore {
  const flows = new Map<string, AuthFlowRecord>();

  const ensure = (flowId: string): AuthFlowRecord | undefined => flows.get(flowId);

  const broadcast = (rec: AuthFlowRecord, event: AuthFlowEventDto): void => {
    for (const s of [...rec.subscribers]) s(event);
  };

  const kindOf = (prompt: AuthFlowEventDto | null): PromptKind | null => {
    if (!prompt || prompt.type !== "prompt") return null;
    return prompt.kind;
  };

  return {
    create(flowId, signal) {
      const abortController = new AbortController();
      if (signal) {
        if (signal.aborted) abortController.abort();
        else signal.addEventListener("abort", () => abortController.abort(), { once: true });
      }
      const rec: AuthFlowRecord = {
        flowId,
        bufferedNotifies: [],
        pendingPrompt: null,
        terminalEvent: null,
        resolveRespond: null,
        rejectRespond: null,
        abortController,
        terminated: false,
        subscribers: new Set(),
        externalSignal: signal,
      };
      flows.set(flowId, rec);
      return rec;
    },
    get: ensure,
    emit(flowId, event) {
      const rec = ensure(flowId);
      if (!rec || rec.terminated) return;
      rec.bufferedNotifies.push(event);
      broadcast(rec, event);
    },
    emitPrompt(flowId, prompt) {
      const rec = ensure(flowId);
      if (!rec || rec.terminated) return;
      rec.pendingPrompt = prompt;
      broadcast(rec, prompt);
    },
    awaitRespond(flowId) {
      const rec = ensure(flowId);
      if (!rec || rec.terminated) return Promise.reject(new Error("flow terminated or unknown"));
      return new Promise<string>((resolve, reject) => {
        rec.resolveRespond = resolve;
        rec.rejectRespond = reject;
        if (rec.abortController.signal.aborted) {
          reject(new DOMException("aborted", "AbortError"));
        } else {
          rec.abortController.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }
      });
    },
    resolveRespond(flowId, value) {
      const rec = ensure(flowId);
      if (!rec || rec.terminated || !rec.resolveRespond) return false;
      const resolve = rec.resolveRespond;
      rec.resolveRespond = null;
      rec.rejectRespond = null;
      rec.pendingPrompt = null;
      resolve(value);
      return true;
    },
    rejectRespond(flowId, err) {
      const rec = ensure(flowId);
      if (!rec || !rec.rejectRespond) return;
      const rej = rec.rejectRespond;
      rec.resolveRespond = null;
      rec.rejectRespond = null;
      rec.pendingPrompt = null;
      rej(err);
    },
    cancel(flowId) {
      const rec = ensure(flowId);
      if (!rec || rec.terminated) return;
      rec.abortController.abort();
      this.rejectRespond(flowId, new DOMException("aborted", "AbortError"));
    },
    terminate(flowId, finalEvent) {
      const rec = ensure(flowId);
      if (!rec) return [finalEvent];
      const ordered: AuthFlowEventDto[] = [];
      const hadLiveSubscriber = rec.subscribers.size > 0;
      if (!hadLiveSubscriber) {
        for (const e of rec.bufferedNotifies) ordered.push(e);
        if (rec.pendingPrompt) ordered.push(rec.pendingPrompt);
      }
      ordered.push(finalEvent);
      rec.terminalEvent = finalEvent;
      rec.terminated = true;
      broadcast(rec, finalEvent);
      rec.subscribers.clear();
      return ordered;
    },
    subscribe(flowId, onEvent) {
      const rec = ensure(flowId);
      if (!rec) return () => {};
      // Replay buffered notifies, any pending prompt, then the terminal event
      // (when the flow already terminated) so a late client is loss-free.
      for (const e of rec.bufferedNotifies) onEvent(e);
      if (rec.pendingPrompt) onEvent(rec.pendingPrompt);
      if (rec.terminalEvent) onEvent(rec.terminalEvent);
      if (rec.terminated) return () => {};
      rec.subscribers.add(onEvent);
      return () => {
        rec.subscribers.delete(onEvent);
      };
    },
    pendingKind: (flowId) => kindOf(ensure(flowId)?.pendingPrompt ?? null),
    list: () => [...flows.keys()],
  };
}