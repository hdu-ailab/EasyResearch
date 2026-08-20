export interface ModelRuntimeCandidate<T extends object> {
  readonly runtime: T;
  activate(): void;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ModelRuntimeTransaction<T extends object> {
  /** Stable object identity delegated to the currently committed runtime. */
  readonly runtime: T;
  prepare(): Promise<ModelRuntimeCandidate<T>>;
  dispose(): Promise<void>;
}

interface RuntimeOwner<T extends object> {
  runtime: T;
  disposed: boolean;
  disposePromise?: Promise<void>;
}

type CandidateState = "prepared" | "active" | "committed" | "rolled-back" | "discarded";

async function disposeOwner<T extends object>(owner: RuntimeOwner<T>): Promise<void> {
  if (owner.disposed) return;
  if (owner.disposePromise) return owner.disposePromise;
  const dispose = Reflect.get(owner.runtime, "dispose");
  owner.disposePromise = (async () => {
    if (typeof dispose === "function") await dispose.call(owner.runtime);
    owner.disposed = true;
  })().finally(() => {
    owner.disposePromise = undefined;
  });
  return owner.disposePromise;
}

export function createModelRuntimeTransaction<T extends object>(
  createRuntime: () => Promise<T>,
): ModelRuntimeTransaction<T> {
  const owners = new Set<RuntimeOwner<T>>();
  let current: RuntimeOwner<T> | undefined;
  let closing = false;
  let disposePromise: Promise<void> | undefined;

  const requireCurrent = (): T => {
    if (!current) throw new Error("No model runtime is active.");
    return current.runtime;
  };

  const runtime = new Proxy({} as T, {
    get(_target, property) {
      const target = requireCurrent();
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(_target, property, value) {
      const target = requireCurrent();
      return Reflect.set(target, property, value, target);
    },
    has(_target, property) {
      return Reflect.has(requireCurrent(), property);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(requireCurrent());
    },
  });

  const release = async (owner: RuntimeOwner<T>): Promise<void> => {
    await disposeOwner(owner);
    owners.delete(owner);
  };

  const prepare = async (): Promise<ModelRuntimeCandidate<T>> => {
    if (closing) throw new Error("Model runtime transaction has been disposed.");
    const owner: RuntimeOwner<T> = {
      runtime: await createRuntime(),
      disposed: false,
    };
    owners.add(owner);
    let previous: RuntimeOwner<T> | undefined;
    let state: CandidateState = "prepared";

    const rollback = async (): Promise<void> => {
      if (state === "prepared") {
        state = "discarded";
      } else if (state === "active") {
        if (current !== owner) throw new Error("Model runtime candidate is not active.");
        current = previous;
        state = "rolled-back";
      } else if (state === "committed") {
        return;
      }
      await release(owner);
    };

    return {
      runtime: owner.runtime,
      activate() {
        if (closing) throw new Error("Model runtime transaction has been disposed.");
        if (state !== "prepared") throw new Error("Model runtime candidate cannot be activated twice.");
        previous = current;
        current = owner;
        state = "active";
      },
      async commit() {
        if (state === "committed") return;
        if (state !== "active" || current !== owner) {
          throw new Error("Only the active model runtime candidate can be committed.");
        }
        state = "committed";
        if (previous) {
          try {
            await release(previous);
          } catch {
            // The transaction retains failed retired owners for disposal retry.
          }
        }
      },
      rollback,
      async dispose() {
        if (state === "committed") return;
        await rollback();
      },
    };
  };

  return {
    runtime,
    prepare,
    dispose() {
      if (disposePromise) return disposePromise;
      if (closing && owners.size === 0) return Promise.resolve();
      closing = true;
      current = undefined;
      disposePromise = (async () => {
        const failures: unknown[] = [];
        for (const owner of [...owners]) {
          try {
            await release(owner);
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Model runtime disposal failed");
      })().finally(() => {
        disposePromise = undefined;
      });
      return disposePromise;
    },
  };
}
