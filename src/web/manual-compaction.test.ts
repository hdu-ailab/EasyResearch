import { describe, expect, it, vi } from "vitest";
import {
  createManualCompactionExtension,
  ManualCompactionController,
  type ManualCompactionSession,
} from "./manual-compaction";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeCompactionSession implements ManualCompactionSession {
  isStreaming = false;
  isCompacting = false;
  compactCalls: Array<string | undefined> = [];
  abortCalls = 0;
  abortCompactionCalls = 0;
  compactImpl: () => Promise<void> = async () => {};
  priorStop = vi.fn(async () => false);
  agent = {
    shouldStopAfterTurn: this.priorStop as ManualCompactionSession["agent"]["shouldStopAfterTurn"],
  };

  async compact(customInstructions?: string): Promise<void> {
    this.compactCalls.push(customInstructions);
    await this.abort();
    this.isCompacting = true;
    try {
      await this.compactImpl();
    } finally {
      this.isCompacting = false;
    }
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
  }

  abortCompaction(): void {
    this.abortCompactionCalls += 1;
  }
}

describe("ManualCompactionController", () => {
  it("starts idle native compaction without waiting for its completion", async () => {
    const gate = deferred<void>();
    const session = new FakeCompactionSession();
    session.compactImpl = () => gate.promise;
    const controller = new ManualCompactionController();
    controller.attach(session);

    expect(controller.request("Keep experiment decisions")).toEqual({ state: "running" });
    expect(session.compactCalls).toEqual(["Keep experiment decisions"]);
    expect(session.abortCalls).toBe(1);
    expect(controller.state()).toBe("running");

    gate.resolve();
    await vi.waitFor(() => expect(controller.state()).toBe("idle"));
  });

  it("uses the latest queued instructions at the completed turn boundary", async () => {
    const session = new FakeCompactionSession();
    session.isStreaming = true;
    const controller = new ManualCompactionController();
    const states: string[] = [];
    controller.subscribe((state) => states.push(state));
    controller.attach(session);

    expect(controller.request("Old focus")).toEqual({ state: "queued" });
    expect(controller.request("Latest focus")).toEqual({ state: "queued" });
    expect(session.compactCalls).toEqual([]);
    expect(await session.agent.shouldStopAfterTurn?.({})).toBe(true);

    await controller.onAgentEnd();

    expect(session.compactCalls).toEqual(["Latest focus"]);
    expect(session.abortCalls).toBe(0);
    expect(states).toEqual(["queued", "queued", "running", "idle"]);
    expect(await session.agent.shouldStopAfterTurn?.({})).toBe(false);
    expect(session.priorStop).toHaveBeenCalledOnce();
  });

  it("cancels pending and running work without starting another compaction", async () => {
    const session = new FakeCompactionSession();
    session.isStreaming = true;
    const controller = new ManualCompactionController();
    controller.attach(session);
    controller.request("Queued");

    await controller.cancel();

    expect(controller.state()).toBe("idle");
    expect(await session.agent.shouldStopAfterTurn?.({})).toBe(false);
    expect(session.compactCalls).toEqual([]);

    const gate = deferred<void>();
    session.isStreaming = false;
    session.compactImpl = () => gate.promise;
    controller.request("Running");
    const cancelling = controller.cancel();
    expect(session.abortCompactionCalls).toBe(1);
    gate.resolve();
    await cancelling;
    expect(controller.state()).toBe("idle");
  });

  it("owns native compaction state that started outside the controller", () => {
    const session = new FakeCompactionSession();
    const controller = new ManualCompactionController();
    controller.attach(session);

    controller.observeNativeCompaction("start");
    session.isCompacting = true;

    expect(controller.state()).toBe("running");
    expect(controller.hasWork()).toBe(true);
    expect(controller.request("Later")).toEqual({ state: "running" });
    expect(session.compactCalls).toEqual([]);

    session.isCompacting = false;
    controller.observeNativeCompaction("end");
    expect(controller.state()).toBe("idle");
    expect(controller.hasWork()).toBe(false);
  });

  it("keeps external native compaction owned until cancellation reaches compaction_end", async () => {
    const session = new FakeCompactionSession();
    const controller = new ManualCompactionController();
    controller.attach(session);
    session.isCompacting = true;
    controller.observeNativeCompaction("start");

    let settled = false;
    const cancellation = controller.cancel().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(session.abortCompactionCalls).toBe(1);
    expect(settled).toBe(false);
    expect(controller.state()).toBe("running");
    expect(controller.hasWork()).toBe(true);

    session.isCompacting = false;
    controller.observeNativeCompaction("end");
    await cancellation;

    expect(controller.state()).toBe("idle");
    expect(controller.hasWork()).toBe(false);
  });

  it("returns to queued state when external native compaction ends with a pending request", () => {
    const session = new FakeCompactionSession();
    session.isStreaming = true;
    const controller = new ManualCompactionController();
    controller.attach(session);
    controller.request("Keep the pending request");

    controller.observeNativeCompaction("start");
    controller.observeNativeCompaction("end");

    expect(controller.state()).toBe("queued");
    expect(controller.hasWork()).toBe(true);
  });

  it("restores the prior turn hook when disposed", async () => {
    const session = new FakeCompactionSession();
    const prior = session.agent.shouldStopAfterTurn;
    const controller = new ManualCompactionController();
    controller.attach(session);

    await controller.dispose();

    expect(session.agent.shouldStopAfterTurn).toBe(prior);
  });
});

it("registers an awaited agent-end handler for the safe compaction boundary", async () => {
  const onAgentEnd = vi.fn(async () => {});
  const handlers = new Map<string, () => Promise<void>>();
  const extension = createManualCompactionExtension({ onAgentEnd });
  extension({
    on: (event: string, handler: () => Promise<void>) => handlers.set(event, handler),
  } as never);

  await handlers.get("agent_end")?.();

  expect(onAgentEnd).toHaveBeenCalledOnce();
  expect(handlers.has("turn_end")).toBe(false);
  expect(handlers.has("agent_settled")).toBe(false);
  expect(handlers.has("session_tree")).toBe(false);
  expect(handlers.has("session_compact")).toBe(false);
  expect(handlers.has("model_select")).toBe(false);
});
