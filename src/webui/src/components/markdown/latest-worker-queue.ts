export class SupersededError extends Error {
  constructor() {
    super("Worker request was superseded");
    this.name = "SupersededError";
  }
}

export class DisposedError extends Error {
  constructor() {
    super("Worker request was disposed");
    this.name = "DisposedError";
  }
}

interface Deferred {
  resolve(): void;
  reject(error: Error): void;
  settled: boolean;
}

interface Job<T> {
  request: T;
  deferred: Deferred;
}

interface Slot<T> {
  generation: number;
  active?: Job<T>;
  queued?: Job<T>;
  running?: Promise<void>;
}

export interface LatestWorkerQueue<T> {
  enqueue(request: T): Promise<void>;
  dispose(key: string, error?: Error): void;
  clear(error?: Error): void;
  idle(): Promise<void>;
  pending(): number;
}

function job<T>(request: T): { value: Job<T>; promise: Promise<void> } {
  const pending = Promise.withResolvers<void>();
  const deferred: Deferred = {
    settled: false,
    resolve() {
      if (deferred.settled) return;
      deferred.settled = true;
      pending.resolve();
    },
    reject(error) {
      if (deferred.settled) return;
      deferred.settled = true;
      pending.reject(error);
    },
  };
  return { value: { request, deferred }, promise: pending.promise };
}

export function createLatestWorkerQueue<T extends { key: string }>(input: {
  run(request: T): Promise<void>;
}): LatestWorkerQueue<T> {
  const slots = new Map<string, Slot<T>>();

  const start = (key: string, slot: Slot<T>, next: Job<T>) => {
    slot.active = next;
    const generation = slot.generation;
    const running = Promise.resolve()
      .then(() => input.run(next.request))
      .then(
        () => next.deferred.resolve(),
        (error: unknown) => next.deferred.reject(error instanceof Error ? error : new Error(String(error))),
      )
      .finally(() => {
        if (slot.running !== running) return;
        slot.running = undefined;
        slot.active = undefined;
        if (slot.generation !== generation) {
          const queued = slot.queued;
          slot.queued = undefined;
          if (queued) start(key, slot, queued);
          else slots.delete(key);
          return;
        }
        const queued = slot.queued;
        slot.queued = undefined;
        if (queued) start(key, slot, queued);
        else slots.delete(key);
      });
    slot.running = running;
  };

  const disposeSlot = (key: string, error: Error) => {
    const slot = slots.get(key);
    if (!slot) return;
    slot.generation += 1;
    slot.active?.deferred.reject(error);
    slot.queued?.deferred.reject(error);
    slot.queued = undefined;
    if (!slot.running) slots.delete(key);
  };

  return {
    enqueue(request) {
      const next = job(request);
      const slot = slots.get(request.key) ?? { generation: 0 };
      slots.set(request.key, slot);
      if (!slot.active) start(request.key, slot, next.value);
      else {
        slot.queued?.deferred.reject(new SupersededError());
        slot.queued = next.value;
      }
      return next.promise;
    },
    dispose(key, error = new DisposedError()) {
      disposeSlot(key, error);
    },
    clear(error = new DisposedError()) {
      for (const key of [...slots.keys()]) disposeSlot(key, error);
    },
    async idle() {
      for (;;) {
        const running = [...slots.values()].flatMap((slot) => (slot.running ? [slot.running] : []));
        if (running.length === 0) return;
        await Promise.allSettled(running);
      }
    },
    pending() {
      let count = 0;
      for (const slot of slots.values()) count += Number(Boolean(slot.active)) + Number(Boolean(slot.queued));
      return count;
    },
  };
}
