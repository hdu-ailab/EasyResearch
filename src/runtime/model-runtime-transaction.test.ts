import { describe, expect, it } from "vitest";
import { createModelRuntimeTransaction } from "./model-runtime-transaction";

class FakeRuntime {
  disposeCalls = 0;

  constructor(readonly name: string) {}

  currentName(): string {
    return this.name;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

describe("createModelRuntimeTransaction", () => {
  it("keeps an acquired owner alive across replacement and waits for its release on disposal", async () => {
    const first = new FakeRuntime("first");
    const second = new FakeRuntime("second");
    const candidates = [first, second];
    const transaction = createModelRuntimeTransaction(async () => candidates.shift()!);
    const initial = await transaction.prepare();
    initial.activate();
    await initial.commit();
    const lease = transaction.acquire();
    const next = await transaction.prepare();
    next.activate();
    const committing = next.commit();
    let disposed = false;
    const disposing = transaction.dispose().then(() => { disposed = true; });
    try {
      await Promise.resolve();
      expect(first.disposeCalls).toBe(0);
      expect(lease.runtime.currentName()).toBe("first");
      expect(disposed).toBe(false);
    } finally {
      lease.release();
      lease.release();
      await Promise.all([committing, disposing]);
    }
    expect(first.disposeCalls).toBe(1);
    expect(second.disposeCalls).toBe(1);
  });

  it("commits and rolls back isolated candidates without double-disposing runtimes", async () => {
    const first = new FakeRuntime("first");
    const rolledBack = new FakeRuntime("rolled-back");
    const committed = new FakeRuntime("committed");
    const runtimes = [first, rolledBack, committed];
    const transaction = createModelRuntimeTransaction(async () => {
      const runtime = runtimes.shift();
      if (!runtime) throw new Error("no candidate");
      return runtime;
    });

    const initialCandidate = await transaction.prepare();
    initialCandidate.activate();
    await initialCandidate.commit();
    expect(transaction.runtime.currentName()).toBe("first");

    const rejectedCandidate = await transaction.prepare();
    rejectedCandidate.activate();
    expect(transaction.runtime.currentName()).toBe("rolled-back");
    await rejectedCandidate.rollback();
    await rejectedCandidate.dispose();
    expect(transaction.runtime.currentName()).toBe("first");
    expect(rolledBack.disposeCalls).toBe(1);

    const acceptedCandidate = await transaction.prepare();
    acceptedCandidate.activate();
    await acceptedCandidate.commit();
    await acceptedCandidate.dispose();
    expect(transaction.runtime.currentName()).toBe("committed");
    expect(first.disposeCalls).toBe(1);
    expect(committed.disposeCalls).toBe(0);

    await transaction.dispose();
    await transaction.dispose();
    expect(committed.disposeCalls).toBe(1);
  });
});
