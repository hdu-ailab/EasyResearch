import { createLatestWorkerQueue, DisposedError, type LatestWorkerQueue, SupersededError } from "./latest-worker-queue";
import {
  isMarkdownWorkerResponse,
  type MarkdownParseRequest,
  type MarkdownParseSuccess,
  type MarkdownWorkerResponse,
} from "./protocol";

type WorkerListener = (event: Event | MessageEvent<unknown>) => void;

export interface MarkdownWorkerLike {
  postMessage(request: MarkdownParseRequest): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: WorkerListener): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: WorkerListener): void;
  terminate(): void;
}

export interface MarkdownRuntimeMetrics {
  requests: number;
  responses: number;
  superseded: number;
  stale: number;
  failures: number;
  cacheHits: number;
  cacheMisses: number;
  evictions: number;
}

interface ClientJob {
  key: string;
  request: MarkdownParseRequest;
  result?: MarkdownParseSuccess;
}

interface ResponseGate {
  composite: string;
  resolve(response: MarkdownWorkerResponse): void;
  reject(error: Error): void;
}

export class MarkdownWorkerUnavailableError extends Error {
  constructor(message = "Markdown worker is unavailable") {
    super(message);
    this.name = "MarkdownWorkerUnavailableError";
  }
}

export class MarkdownParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownParseError";
  }
}

const emptyMetrics = (): MarkdownRuntimeMetrics => ({
  requests: 0,
  responses: 0,
  superseded: 0,
  stale: 0,
  failures: 0,
  cacheHits: 0,
  cacheMisses: 0,
  evictions: 0,
});

let metrics = emptyMetrics();
let customFactory = false;
let factory: () => MarkdownWorkerLike = () =>
  new Worker(new URL("./markdown.worker.ts", import.meta.url), { type: "module" }) as MarkdownWorkerLike;
let worker: MarkdownWorkerLike | undefined;
let queue: LatestWorkerQueue<ClientJob> | undefined;
let degraded: MarkdownWorkerUnavailableError | undefined;
const revisions = new Map<string, number>();
const responses = new Map<string, ResponseGate>();

const compositeKey = (scope: string, key: string) => `${scope}\0${key}`;
const requestKey = (request: Omit<MarkdownParseRequest, "type">) =>
  `${compositeKey(request.scope, request.key)}\0${request.revision}`;

function rejectResponses(error: Error, composite?: string) {
  for (const [key, gate] of responses) {
    if (composite !== undefined && gate.composite !== composite) continue;
    responses.delete(key);
    gate.reject(error);
  }
}

function degrade(error: unknown) {
  if (degraded) return degraded;
  degraded = new MarkdownWorkerUnavailableError(error instanceof Error ? error.message : String(error));
  metrics.failures += 1;
  rejectResponses(degraded);
  queue?.clear(degraded);
  worker?.terminate();
  worker = undefined;
  return degraded;
}

const onMessage: WorkerListener = (event) => {
  if (!("data" in event) || !isMarkdownWorkerResponse(event.data)) return;
  metrics.responses += 1;
  const key = requestKey(event.data);
  const gate = responses.get(key);
  if (!gate) {
    metrics.stale += 1;
    return;
  }
  responses.delete(key);
  gate.resolve(event.data);
};

const onFailure: WorkerListener = () => {
  degrade(new Error("Markdown worker failed"));
};

function getWorker(): MarkdownWorkerLike {
  if (degraded) throw degraded;
  if (worker) return worker;
  try {
    worker = factory();
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onFailure);
    worker.addEventListener("messageerror", onFailure);
    return worker;
  } catch (error) {
    throw degrade(error);
  }
}

function waitForResponse(request: MarkdownParseRequest): Promise<MarkdownWorkerResponse> {
  const pending = Promise.withResolvers<MarkdownWorkerResponse>();
  const key = requestKey(request);
  responses.set(key, {
    composite: compositeKey(request.scope, request.key),
    resolve: pending.resolve,
    reject: pending.reject,
  });
  try {
    metrics.requests += 1;
    getWorker().postMessage(request);
  } catch (error) {
    responses.delete(key);
    pending.reject(error);
  }
  return pending.promise;
}

function getQueue(): LatestWorkerQueue<ClientJob> {
  if (queue) return queue;
  queue = createLatestWorkerQueue<ClientJob>({
    async run(job) {
      const response = await waitForResponse(job.request);
      if (response.type === "error") throw new MarkdownParseError(response.message);
      job.result = response;
    },
  });
  return queue;
}

export function requestMarkdown(input: { scope: string; key: string; source: string }): {
  revision: number;
  promise: Promise<MarkdownParseSuccess>;
  cancel(): void;
} {
  const composite = compositeKey(input.scope, input.key);
  const revision = (revisions.get(composite) ?? 0) + 1;
  revisions.set(composite, revision);
  if (degraded) return { revision, promise: Promise.reject(degraded), cancel() {} };
  const request: MarkdownParseRequest = { type: "parse", ...input, revision };
  const job: ClientJob = { key: composite, request };
  const promise = getQueue()
    .enqueue(job)
    .then(() => {
      if (!job.result) throw new Error("Markdown worker completed without a result");
      return job.result;
    })
    .catch((error: unknown) => {
      if (error instanceof SupersededError) metrics.superseded += 1;
      throw error;
    });
  return {
    revision,
    promise,
    cancel() {
      cancelMarkdown(input.scope, input.key);
    },
  };
}

export function canUseMarkdownWorker(): boolean {
  return degraded === undefined && (customFactory || typeof Worker !== "undefined");
}

export function cancelMarkdown(scope: string, key: string): void {
  const composite = compositeKey(scope, key);
  const error = new DisposedError();
  queue?.dispose(composite, error);
  rejectResponses(error, composite);
}

export function recordMarkdownRuntimeMetric(key: "cacheHits" | "cacheMisses" | "evictions"): void {
  metrics[key] += 1;
}

export function getMarkdownRuntimeMetrics(): MarkdownRuntimeMetrics {
  return { ...metrics };
}

export function configureMarkdownWorkerFactoryForTests(next: () => MarkdownWorkerLike): void {
  resetMarkdownRuntimeForTests();
  factory = next;
  customFactory = true;
}

export function resetMarkdownRuntimeForTests(): void {
  const error = new DisposedError();
  rejectResponses(error);
  queue?.clear(error);
  queue = undefined;
  worker?.removeEventListener("message", onMessage);
  worker?.removeEventListener("error", onFailure);
  worker?.removeEventListener("messageerror", onFailure);
  worker?.terminate();
  worker = undefined;
  degraded = undefined;
  revisions.clear();
  metrics = emptyMetrics();
  customFactory = false;
  factory = () =>
    new Worker(new URL("./markdown.worker.ts", import.meta.url), { type: "module" }) as MarkdownWorkerLike;
}
