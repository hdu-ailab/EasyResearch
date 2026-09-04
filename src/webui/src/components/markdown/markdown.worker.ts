/// <reference lib="webworker" />

import { parseMarkdownBlocks } from "./parse";
import { type MarkdownWorkerBlock, type MarkdownWorkerResponse, parseMarkdownWorkerRequest } from "./protocol";

type Parser = (source: string) => Promise<MarkdownWorkerBlock[]>;

export function createMarkdownWorkerHandler(
  post: (response: MarkdownWorkerResponse) => void,
  parse: Parser = parseMarkdownBlocks,
) {
  return async (value: unknown): Promise<void> => {
    const request = parseMarkdownWorkerRequest(value);
    if (!request) return;
    const { type: _type, ...identity } = request;
    try {
      post({ ...identity, type: "parsed", blocks: await parse(request.source) });
    } catch (error) {
      post({
        ...identity,
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

const scope = globalThis as unknown as {
  document?: unknown;
  onmessage?: (event: MessageEvent<unknown>) => void;
  postMessage?: (response: MarkdownWorkerResponse) => void;
};

if (scope.document === undefined && typeof scope.postMessage === "function") {
  const handle = createMarkdownWorkerHandler((response) => scope.postMessage?.(response));
  scope.onmessage = (event) => void handle(event.data);
}
