import { admitBackgroundInput, pendingBackgroundInputs, preserveBackgroundInputsWithoutWake, type BackgroundInboxJournal, type BackgroundInput } from "../background/inbox";

interface DeliverySession {
  sessionId: string;
  readonly isIdle: boolean;
  readonly isStreaming: boolean;
  waitForIdle(): Promise<void>;
  sendCustomMessage(message: { customType: string; content: string; display: boolean; details: { inputID: string; ownerSessionID: string } },
    options: { deliverAs: "steer"; triggerTurn: boolean }): Promise<void>;
}

/** Durable admission is separate from the lifetime of a completion-woken Pi run. */
export class RootBackgroundDelivery {
  private closed = false;
  private admission = Promise.resolve();
  private readonly queued = new Set<string>();

  constructor(private readonly options: {
    journal: BackgroundInboxJournal;
    session: DeliverySession;
    acquire(): Promise<() => void>;
    ready(): Promise<void>;
    canWake(): boolean;
    stopped(): boolean;
    own(operation: Promise<void>): void;
    changed(): void;
    onError(error: unknown): void;
  }) {}

  async admit(input: BackgroundInput): Promise<void> {
    if (this.closed || this.options.stopped()) throw new Error("The background recipient is closing.");
    if (admitBackgroundInput(this.options.journal, input) === "delivered") return;
    this.options.changed();
    await this.drain();
  }

  hasPending(): boolean { return pendingBackgroundInputs(this.options.journal).length > 0; }
  hasWakePending(): boolean { return pendingBackgroundInputs(this.options.journal).some((input) => input.wake !== false); }

  observe(inputID: string): void { this.queued.delete(inputID); }

  drain(): Promise<void> {
    const next = this.admission.then(async () => {
      const { session } = this.options;
      if (this.closed || this.options.stopped()) return;
      if (!session.isIdle && !session.isStreaming) await session.waitForIdle();
      const release = await this.options.acquire();
      try {
        for (const input of pendingBackgroundInputs(this.options.journal)) {
          if (this.closed || this.options.stopped()) return;
          if (this.queued.has(input.id)) continue;
          const wake = input.wake !== false;
          if (wake && !this.options.canWake()) continue;
          if (wake && !session.isStreaming) await this.options.ready();
          if (this.closed || this.options.stopped() || (wake && !this.options.canWake())) return;
          this.queued.add(input.id);
          const operation = session.sendCustomMessage({
            customType: input.customType, content: input.content, display: false,
            details: { inputID: input.id, ownerSessionID: session.sessionId },
          }, { deliverAs: "steer", triggerTurn: wake });
          const owned = operation.catch((error) => {
            this.queued.delete(input.id);
            this.options.onError(error);
          }).finally(() => { this.options.changed(); });
          this.options.own(owned);
        }
      } finally { release(); }
    });
    this.admission = next.catch((error) => { this.options.onError(error); });
    return this.admission;
  }

  async close(options?: { terminal?: boolean }): Promise<void> {
    this.closed = true;
    await this.admission;
    if (options?.terminal) {
      if (!this.options.session.isIdle) throw new Error("Terminal inbox disposition requires native idle.");
      preserveBackgroundInputsWithoutWake(this.options.journal);
    }
    this.queued.clear();
  }
}
