import { describe, expect, it } from "vitest";
import { createLatestWorkerQueue, DisposedError, SupersededError } from "./latest-worker-queue";

describe("createLatestWorkerQueue", () => {
  it("keeps only the newest queued request for an active key", async () => {
    const started: string[] = [];
    const gates = new Map<string, PromiseWithResolvers<void>>();
    const queue = createLatestWorkerQueue<{ key: string; value: string }>({
      run: async (request) => {
        started.push(request.value);
        const gate = Promise.withResolvers<void>();
        gates.set(request.value, gate);
        await gate.promise;
      },
    });
    const one = queue.enqueue({ key: "m", value: "one" });
    const two = queue.enqueue({ key: "m", value: "two" });
    const three = queue.enqueue({ key: "m", value: "three" });
    await Promise.resolve();
    gates.get("one")!.resolve();
    await expect(two).rejects.toBeInstanceOf(SupersededError);
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["one", "three"]);
    gates.get("three")!.resolve();
    await Promise.all([one, three]);
    expect(queue.pending()).toBe(0);
  });

  it("runs different keys independently", async () => {
    const gates = new Map<string, PromiseWithResolvers<void>>();
    const started: string[] = [];
    const queue = createLatestWorkerQueue<{ key: string }>({
      run: async (request) => {
        started.push(request.key);
        const gate = Promise.withResolvers<void>();
        gates.set(request.key, gate);
        await gate.promise;
      },
    });
    const left = queue.enqueue({ key: "left" });
    const right = queue.enqueue({ key: "right" });
    await Promise.resolve();
    expect(started.sort()).toEqual(["left", "right"]);
    gates.get("left")!.resolve();
    gates.get("right")!.resolve();
    await Promise.all([left, right]);
  });

  it("disposes queued and active ownership without launching stale work", async () => {
    const gate = Promise.withResolvers<void>();
    const queue = createLatestWorkerQueue<{ key: string; value: number }>({ run: () => gate.promise });
    const active = queue.enqueue({ key: "m", value: 1 });
    const queued = queue.enqueue({ key: "m", value: 2 });
    queue.dispose("m");
    await expect(active).rejects.toBeInstanceOf(DisposedError);
    await expect(queued).rejects.toBeInstanceOf(DisposedError);
    gate.resolve();
    await queue.idle();
    expect(queue.pending()).toBe(0);
  });
});
