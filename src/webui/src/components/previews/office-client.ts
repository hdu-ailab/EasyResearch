import type {
  OfficeDocument,
  OfficeFrame,
  OfficeKind,
  OfficeReply,
  OfficeRequest,
  OfficeView,
} from "./office-protocol";

export interface OfficeWorkerPort {
  onmessage: ((event: MessageEvent<OfficeReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: OfficeRequest, transfer: Transferable[]): void;
  terminate(): void;
}
export interface OfficeClient {
  open(kind: OfficeKind, bytes: ArrayBuffer, signal: AbortSignal): Promise<OfficeDocument>;
  frame(view: OfficeView, signal: AbortSignal): Promise<OfficeFrame>;
  dispose(): void;
}
export class OfficePreviewError extends Error {}
const aborted = () => new DOMException("Preview closed", "AbortError");
// FontFace ownership is document-local, not a credential. A monotonically allocated
// owner keeps concurrent file Workers distinct on HTTP LAN origins too.
let nextFontOwner = 0;

/** One running operation and one latest waiting view; withdrawn synchronous WASM still has its deadline. */
export function createOfficeClient(
  worker: OfficeWorkerPort = new Worker(new URL("./office.worker.ts", import.meta.url), { type: "module" }),
  timeoutMs = 45_000,
): OfficeClient {
  type Pending = {
    request: OfficeRequest;
    signal: AbortSignal;
    resolve(reply: OfficeReply): void;
    reject(error: Error): void;
    unlisten(): void;
  };
  let nextId = 0;
  let active: Pending | undefined;
  let waiting: Pending | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let terminalError: Error | undefined;
  const stop = (error: Error) => {
    if (terminalError) return;
    terminalError = error;
    clearTimeout(timer);
    worker.terminate();
    worker.onmessage = worker.onerror = worker.onmessageerror = null;
    for (const pending of [active, waiting]) {
      pending?.unlisten();
      pending?.reject(error);
    }
    active = waiting = undefined;
  };
  const dispatch = (pending: Pending) => {
    active = pending;
    timer = setTimeout(() => stop(new OfficePreviewError("timeout")), timeoutMs);
    try {
      worker.postMessage(pending.request, pending.request.type === "open" ? [pending.request.bytes] : []);
    } catch {
      stop(new OfficePreviewError("worker"));
    }
  };
  worker.onerror = () => stop(new OfficePreviewError("worker"));
  worker.onmessageerror = () => stop(new OfficePreviewError("worker"));
  worker.onmessage = ({ data }) => {
    if (!active || data.id !== active.request.id || terminalError) return;
    clearTimeout(timer);
    const completed = active;
    active = undefined;
    completed.unlisten();
    if (!completed.signal.aborted) {
      if (data.type === "error") completed.reject(new OfficePreviewError(data.code));
      else completed.resolve(data);
    }
    const next = waiting;
    waiting = undefined;
    if (next) dispatch(next);
  };
  const request = (message: OfficeRequest, signal: AbortSignal): Promise<OfficeReply> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(aborted());
        return;
      }
      if (terminalError) {
        reject(terminalError);
        return;
      }
      const pending: Pending = {
        request: message,
        signal,
        resolve,
        reject,
        unlisten: () => signal.removeEventListener("abort", cancel),
      };
      const cancel = () => {
        reject(aborted());
        if (waiting === pending) {
          waiting = undefined;
          pending.unlisten();
        }
        // Keep active ownership/deadline until its reply, even after cancellation.
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (active) {
        waiting?.unlisten();
        waiting?.reject(aborted());
        waiting = pending;
      } else dispatch(pending);
    });
  return {
    async open(kind, bytes, signal) {
      const reply = await request(
        { id: ++nextId, type: "open", kind, bytes, fontPrefix: `EROffice-${++nextFontOwner}` },
        signal,
      );
      if (reply.type !== "opened") throw new OfficePreviewError("worker");
      return reply.document;
    },
    async frame(view, signal) {
      const reply = await request({ id: ++nextId, type: "frame", view }, signal);
      if (reply.type !== "frame") throw new OfficePreviewError("worker");
      return reply.frame;
    },
    dispose: () => stop(aborted()),
  };
}
