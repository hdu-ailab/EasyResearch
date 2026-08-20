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
