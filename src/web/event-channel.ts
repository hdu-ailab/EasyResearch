import { randomUUID } from "node:crypto";
import {
  parseEventSubscriptions,
  type EventChannelFrame,
  type EventSubscription,
} from "./event-channel-contract";

interface Subscription extends EventSubscription {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  task: Promise<void>;
}
interface Channel {
  id: string;
  revision: number;
  controller: ReadableStreamDefaultController<Uint8Array>;
  subscriptions: Map<string, Subscription>;
  timer: ReturnType<typeof setInterval>;
  closed: boolean;
}

/** Owns only transport readers and their watch leases, never Agent execution. */
export class EventChannels {
  private readonly channels = new Map<string, Channel>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly encoder = new TextEncoder();
  private closing = false;
  constructor(
    private readonly options: {
      bootId: string;
      open(path: string): Response;
      maxBytes?: number;
      heartbeatMs?: number;
    },
  ) {}
  private get maxBytes() {
    return this.options.maxBytes ?? 32 * 1024 * 1024;
  }

  open(): Response {
    if (this.closing) return new Response("Server is closing", { status: 503 });
    const id = randomUUID();
    let channel: Channel;
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          channel = {
            id,
            revision: -1,
            controller,
            subscriptions: new Map(),
            closed: false,
            timer: setInterval(
              () => this.frame(channel, { type: "heartbeat", id, bootId: this.options.bootId }),
              this.options.heartbeatMs ?? 15_000,
            ),
          };
          channel.timer.unref?.();
          this.channels.set(id, channel);
          this.frame(channel, { type: "connected", id, bootId: this.options.bootId });
        },
        cancel: () => this.closeChannel(channel),
      },
      { highWaterMark: this.maxBytes, size: (bytes) => bytes?.byteLength ?? 0 },
    );
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }

  async replace(id: string, value: unknown): Promise<{ applied: boolean; revision: number } | undefined> {
    const replacement = parseEventSubscriptions(value);
    const channel = this.channels.get(id);
    if (!channel || channel.closed) return undefined;
    if (replacement.revision <= channel.revision) return { applied: false, revision: channel.revision };
    channel.revision = replacement.revision;
    const desired = new Map(replacement.subscriptions.map((item) => [item.id, item]));
    const retiring: Promise<unknown>[] = [];
    for (const current of channel.subscriptions.values()) {
      if (desired.get(current.id)?.path === current.path) continue;
      channel.subscriptions.delete(current.id);
      retiring.push(this.retire(current));
    }
    // A boot's configuration snapshot must precede its new session data.
    const ordered = [...desired.values()].sort(
      (a, b) => Number(b.path === "/api/config/events") - Number(a.path === "/api/config/events"),
    );
    for (const item of ordered) {
      if (channel.closed || channel.subscriptions.has(item.id)) continue;
      try {
        const response = this.options.open(item.path);
        if (!response.ok || !response.body) throw new Error("Event source unavailable");
        const subscription: Subscription = {
          ...item,
          reader: response.body.getReader(),
          task: Promise.resolve(),
        };
        channel.subscriptions.set(item.id, subscription);
        subscription.task = this.pump(channel, subscription);
      } catch {
        this.frame(channel, { type: "stream-error", id: item.id, bootId: this.options.bootId });
      }
    }
    await Promise.all(retiring);
    return { applied: true, revision: channel.revision };
  }

  private async pump(channel: Channel, source: Subscription): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = "";
    const current = () => !channel.closed && channel.subscriptions.get(source.id) === source;
    try {
      while (current()) {
        const { done, value } = await source.reader.read();
        if (!current()) break;
        if (done) {
          this.frame(channel, { type: "end", id: source.id, bootId: this.options.bootId });
          break;
        }
        buffered += decoder.decode(value, { stream: true });
        if (this.encoder.encode(buffered).byteLength > this.maxBytes) throw new Error("Event source frame exceeds budget");
        let end: number;
        while ((end = buffered.indexOf("\n\n")) >= 0) {
          const lines = buffered.slice(0, end).split("\n");
          buffered = buffered.slice(end + 2);
          const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data && current())
            this.frame(channel, {
              type: "event",
              id: source.id,
              bootId: this.options.bootId,
              event: JSON.parse(data),
            });
        }
      }
    } catch {
      if (current())
        this.frame(channel, { type: "stream-error", id: source.id, bootId: this.options.bootId });
    } finally {
      if (channel.subscriptions.get(source.id) === source) channel.subscriptions.delete(source.id);
      await source.reader.cancel().catch(() => {});
      source.reader.releaseLock();
    }
  }

  private frame(channel: Channel, frame: EventChannelFrame): void {
    this.send(channel, `data: ${JSON.stringify(frame)}\n\n`);
  }
  private send(channel: Channel, text: string): void {
    if (channel.closed) return;
    const bytes = this.encoder.encode(text);
    if (bytes.byteLength > (channel.controller.desiredSize ?? 0)) {
      channel.controller.error(new Error("Event channel exceeded its pending-byte budget"));
      void this.closeChannel(channel);
      return;
    }
    channel.controller.enqueue(bytes);
  }
  private retire(source: Subscription): Promise<void> {
    const done = source.reader
      .cancel()
      .catch(() => {})
      .then(() => source.task);
    this.pending.add(done);
    void done.finally(() => this.pending.delete(done));
    return done;
  }
  private async closeChannel(channel: Channel): Promise<void> {
    if (channel.closed) return;
    channel.closed = true;
    clearInterval(channel.timer);
    this.channels.delete(channel.id);
    const sources = [...channel.subscriptions.values()];
    channel.subscriptions.clear();
    await Promise.all(sources.map((source) => this.retire(source)));
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(
      [...this.channels.values()].map((channel) => {
        channel.controller.close();
        return this.closeChannel(channel);
      }),
    );
    await Promise.all([...this.pending]);
  }
}
