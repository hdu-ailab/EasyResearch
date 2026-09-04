import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureMarkdownWorkerFactoryForTests,
  getMarkdownRuntimeMetrics,
  type MarkdownWorkerLike,
  requestMarkdown,
  resetMarkdownRuntimeForTests,
} from "./client";
import type { MarkdownParseRequest, MarkdownWorkerResponse } from "./protocol";

class FakeWorker implements MarkdownWorkerLike {
  requests: MarkdownParseRequest[] = [];
  terminated = false;
  readonly listeners = {
    message: new Set<(event: MessageEvent<unknown>) => void>(),
    error: new Set<() => void>(),
    messageerror: new Set<() => void>(),
  };

  postMessage(request: MarkdownParseRequest) {
    this.requests.push(request);
  }

  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener) {
    this.listeners[type].add(listener as never);
  }

  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener) {
    this.listeners[type].delete(listener as never);
  }

  terminate() {
    this.terminated = true;
  }

  respond(response: MarkdownWorkerResponse) {
    for (const listener of this.listeners.message) listener({ data: response } as MessageEvent<unknown>);
  }

  fail() {
    for (const listener of this.listeners.error) listener();
  }
}

afterEach(() => resetMarkdownRuntimeForTests());

describe("Markdown worker client", () => {
  it("creates the worker lazily and resolves matching identity", async () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    configureMarkdownWorkerFactoryForTests(factory);
    expect(factory).not.toHaveBeenCalled();
    const request = requestMarkdown({ scope: "s", key: "k", source: "hello" });
    await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.requests).toHaveLength(1);
    const sent = worker.requests[0]!;
    worker.respond({ ...sent, type: "parsed", blocks: [] });
    await expect(request.promise).resolves.toMatchObject({ source: "hello", revision: sent.revision });
  });

  it("supersedes the queued revision and ignores stale responses", async () => {
    const worker = new FakeWorker();
    configureMarkdownWorkerFactoryForTests(() => worker);
    const first = requestMarkdown({ scope: "s", key: "k", source: "one" });
    const second = requestMarkdown({ scope: "s", key: "k", source: "two" });
    const third = requestMarkdown({ scope: "s", key: "k", source: "three" });
    await expect(second.promise).rejects.toMatchObject({ name: "SupersededError" });
    await Promise.resolve();
    const sentFirst = worker.requests[0]!;
    worker.respond({ ...sentFirst, type: "parsed", blocks: [] });
    await first.promise;
    await Promise.resolve();
    const sentThird = worker.requests[1]!;
    worker.respond({ ...sentFirst, type: "parsed", blocks: [] });
    worker.respond({ ...sentThird, type: "parsed", blocks: [] });
    await expect(third.promise).resolves.toMatchObject({ source: "three" });
    expect(getMarkdownRuntimeMetrics().stale).toBe(1);
  });

  it("cancels one key without affecting another", async () => {
    const worker = new FakeWorker();
    configureMarkdownWorkerFactoryForTests(() => worker);
    const left = requestMarkdown({ scope: "s", key: "left", source: "left" });
    const right = requestMarkdown({ scope: "s", key: "right", source: "right" });
    await Promise.resolve();
    left.cancel();
    await expect(left.promise).rejects.toMatchObject({ name: "DisposedError" });
    const sentRight = worker.requests.find((request) => request.key === "right")!;
    worker.respond({ ...sentRight, type: "parsed", blocks: [] });
    await expect(right.promise).resolves.toMatchObject({ key: "right" });
  });

  it("degrades once after a worker failure", async () => {
    const worker = new FakeWorker();
    const factory = vi.fn(() => worker);
    configureMarkdownWorkerFactoryForTests(factory);
    const first = requestMarkdown({ scope: "s", key: "k", source: "one" });
    await Promise.resolve();
    worker.fail();
    await expect(first.promise).rejects.toMatchObject({ name: "MarkdownWorkerUnavailableError" });
    expect(worker.terminated).toBe(true);
    const later = requestMarkdown({ scope: "s", key: "later", source: "later" });
    await expect(later.promise).rejects.toMatchObject({ name: "MarkdownWorkerUnavailableError" });
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
