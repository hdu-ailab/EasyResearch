import type { EventChannelFrame } from "../../../web/event-channel-contract";

export interface EventListener {
  onEvent(event: unknown): void;
  onError(): void;
}
export interface EventSourceLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}
interface Subscription extends EventListener {
  path: string;
  ended: boolean;
}

/** One physical SSE, with independently owned logical view subscriptions. */
export class EventConnection {
  private readonly subscriptions = new Map<string, Subscription>();
  private source?: EventSourceLike;
  private channel?: { id: string; bootId: string };
  private epoch = 0;
  private revision = 0;
  private desired = 0;
  private syncing = false;
  private request?: AbortController;
  private retry?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly options: {
      source?: () => EventSourceLike;
      fetch?: (url: string, init: RequestInit) => Promise<Response>;
      retryMs?: number;
      idleMs?: number;
    } = {},
  ) {}

  subscribe(id: string, path: string, listener: EventListener): () => void {
    if (this.subscriptions.has(id)) throw new Error("Duplicate event subscription");
    const subscription = { ...listener, path, ended: false };
    this.subscriptions.set(id, subscription);
    this.desired += 1;
    if (!this.source && !this.retry) this.start();
    this.scheduleSync();
    return () => {
      if (this.subscriptions.get(id) !== subscription) return;
      this.subscriptions.delete(id);
      this.desired += 1;
      if (!this.subscriptions.size) this.stop();
      else this.scheduleSync();
    };
  }

  private start(): void {
    if (!this.subscriptions.size) return;
    let source: EventSourceLike;
    try {
      source = (this.options.source ?? (() => new EventSource("/api/events")))();
    } catch {
      this.reconnect();
      return;
    }
    this.source = source;
    const epoch = ++this.epoch;
    this.touch();
    source.onerror = () => {
      if (this.source === source) this.reconnect();
    };
    source.onmessage = (message) => {
      if (this.source !== source || this.epoch !== epoch) return;
      try {
        const frame = JSON.parse(message.data) as EventChannelFrame;
        if (!frame || typeof frame.id !== "string" || typeof frame.bootId !== "string")
          throw new Error("Invalid event channel frame");
        this.touch();
        if (frame.type === "connected") {
          this.channel = { id: frame.id, bootId: frame.bootId };
          this.revision = 0;
          for (const subscription of this.subscriptions.values()) subscription.ended = false;
          this.scheduleSync();
          return;
        }
        if (!this.channel || frame.bootId !== this.channel.bootId) throw new Error("Event channel identity changed");
        if (frame.type === "heartbeat") return;
        const subscription = this.subscriptions.get(frame.id);
        if (!subscription || subscription.ended) return;
        if (frame.type === "event") {
          try {
            subscription.onEvent(frame.event);
          } catch {
            subscription.onError();
          }
        } else if (frame.type === "end" || frame.type === "stream-error") {
          subscription.ended = true;
          if (frame.type === "stream-error") subscription.onError();
        } else throw new Error("Invalid event channel frame");
      } catch {
        this.reconnect();
      }
    };
  }

  private touch(): void {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.reconnect(), this.options.idleMs ?? 45_000);
  }
  private scheduleSync(): void {
    queueMicrotask(() => {
      void this.sync();
    });
  }
  private async sync(): Promise<void> {
    if (!this.channel || this.syncing || !this.source) return;
    const channel = this.channel;
    const epoch = this.epoch;
    const desired = this.desired;
    const request = new AbortController();
    this.request = request;
    this.syncing = true;
    const timeout = setTimeout(() => request.abort(), 10_000);
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(`/api/events/${channel.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        signal: request.signal,
        body: JSON.stringify({
          revision: ++this.revision,
          subscriptions: [...this.subscriptions]
            .filter(([, sub]) => !sub.ended)
            .map(([id, sub]) => ({ id, path: sub.path })),
        }),
      });
      if (!response.ok) throw new Error("Event subscription synchronization failed");
      await response.json();
    } catch {
      if (epoch === this.epoch) this.reconnect();
    } finally {
      clearTimeout(timeout);
      if (epoch === this.epoch) {
        this.request = undefined;
        this.syncing = false;
        if (desired !== this.desired) this.scheduleSync();
      }
    }
  }

  private stop(): void {
    this.epoch += 1;
    this.source?.close();
    this.source = undefined;
    this.channel = undefined;
    this.request?.abort();
    this.request = undefined;
    this.syncing = false;
    clearTimeout(this.retry);
    clearTimeout(this.watchdog);
    this.retry = undefined;
    this.watchdog = undefined;
  }
  reconnect(): void {
    this.stop();
    for (const subscription of this.subscriptions.values()) {
      try {
        subscription.onError();
      } catch {
        /* isolate a detached view */
      }
    }
    if (this.subscriptions.size)
      this.retry = setTimeout(() => {
        this.retry = undefined;
        this.start();
      }, this.options.retryMs ?? 1000);
  }
  close(): void {
    this.subscriptions.clear();
    this.stop();
  }
}
