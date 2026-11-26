import type { MarkdownWorkerLike } from "../components/markdown/client";
import { parseMarkdownBlocks } from "../components/markdown/parse";
import type { MarkdownParseRequest, MarkdownWorkerResponse } from "../components/markdown/protocol";

/** Real parser with deterministic response delivery, including replies after
 * a newer source is queued. It exercises the production queue and protocol. */
export class ControlledMarkdownWorker implements MarkdownWorkerLike {
  readonly pending: MarkdownParseRequest[] = [];
  readonly requests: MarkdownParseRequest[] = [];
  readonly message = new Set<(event: MessageEvent<unknown>) => void>();
  readonly errors = new Set<(event: Event) => void>();

  postMessage(request: MarkdownParseRequest) {
    this.requests.push(request);
    this.pending.push(request);
  }

  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener) {
    if (type === "message") this.message.add(listener as (event: MessageEvent<unknown>) => void);
    else this.errors.add(listener);
  }

  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener) {
    if (type === "message") this.message.delete(listener as (event: MessageEvent<unknown>) => void);
    else this.errors.delete(listener);
  }

  terminate() {}

  async respond() {
    await Promise.resolve();
    const request = this.pending.shift();
    if (!request) throw new Error("No pending Markdown parse");
    const blocks = await parseMarkdownBlocks(request.source);
    const response: MarkdownWorkerResponse = { ...request, type: "parsed", blocks };
    for (const listener of this.message) listener({ data: response } as MessageEvent<unknown>);
    return request;
  }

  fail() {
    for (const listener of this.errors) listener(new Event("error"));
  }
}
