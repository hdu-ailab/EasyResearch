import { isEventSubscriptionPath } from "../../../web/event-channel-contract";
import { EventConnection, type EventListener } from "./event-connection";

export interface EventPort {
  onmessage: ((event: MessageEvent) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage(value: unknown): void;
  start(): void;
  close(): void;
}
export type Delivery = { id: string; type: "event"; event: unknown } | { id: string; type: "error" };
interface Peer {
  port: EventPort;
  prefix: string;
  seen: number;
  subscriptions: Map<string, () => void>;
  pending: { message: Delivery; bytes: number }[];
  bytes: number;
  sequence: number;
  waiting: boolean;
}

/** Browser SharedWorker scope; no session state or authentication store. */
export function createEventWorkerBroker(
  options: {
    connection?: Pick<EventConnection, "subscribe" | "close" | "reconnect">;
    now?: () => number;
    maxBytes?: number;
    maxPending?: number;
  } = {},
) {
  const connection = options.connection ?? new EventConnection();
  const now = options.now ?? Date.now;
  const encoder = new TextEncoder();
  const peers = new Set<Peer>();
  let sequence = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  function drop(peer: Peer) {
    if (!peers.delete(peer)) return;
    for (const unsubscribe of peer.subscriptions.values()) unsubscribe();
    peer.subscriptions.clear();
    peer.pending.length = 0;
    try {
      peer.port.postMessage({ type: "disconnected" });
    } catch {
      /* already gone */
    }
    peer.port.onmessage = null;
    peer.port.onmessageerror = null;
    peer.port.close();
    if (!peers.size) {
      clearInterval(timer);
      timer = undefined;
    }
  }
  function flush(peer: Peer) {
    if (peer.waiting || !peer.pending.length || !peers.has(peer)) return;
    const items = peer.pending.splice(0, 32);
    peer.bytes -= items.reduce((n, item) => n + item.bytes, 0);
    peer.waiting = true;
    try {
      peer.port.postMessage({ type: "batch", sequence: ++peer.sequence, items: items.map((item) => item.message) });
    } catch {
      drop(peer);
    }
  }
  function enqueue(peer: Peer, item: Delivery) {
    if (!peers.has(peer)) return;
    const bytes = encoder.encode(JSON.stringify(item)).byteLength;
    if (
      peer.pending.length >= (options.maxPending ?? 2048) ||
      peer.bytes + bytes > (options.maxBytes ?? 32 * 1024 * 1024)
    ) {
      drop(peer);
      return;
    }
    peer.pending.push({ message: item, bytes });
    peer.bytes += bytes;
    flush(peer);
  }
  function attach(port: EventPort) {
    const peer: Peer = {
      port,
      prefix: `p${++sequence}`,
      seen: now(),
      subscriptions: new Map(),
      pending: [],
      bytes: 0,
      sequence: 0,
      waiting: false,
    };
    peers.add(peer);
    port.onmessage = ({ data }) => {
      if (!peers.has(peer) || !data || typeof data !== "object") return;
      peer.seen = now();
      if (data.type === "pong") return;
      if (data.type === "bye") {
        drop(peer);
        return;
      }
      if (data.type === "ack" && data.sequence === peer.sequence) {
        peer.waiting = false;
        flush(peer);
        return;
      }
      if (typeof data.id !== "string" || !/^[\w-]{1,64}$/.test(data.id)) return;
      if (data.type === "unsubscribe") {
        peer.subscriptions.get(data.id)?.();
        peer.subscriptions.delete(data.id);
        return;
      }
      if (data.type !== "subscribe" || !isEventSubscriptionPath(data.path) || peer.subscriptions.has(data.id)) return;
      if (peer.subscriptions.size >= 64) {
        drop(peer);
        return;
      }
      const listener: EventListener = {
        onEvent: (event) => enqueue(peer, { type: "event", id: data.id, event }),
        onError: () => enqueue(peer, { type: "error", id: data.id }),
      };
      peer.subscriptions.set(data.id, connection.subscribe(`${peer.prefix}-${data.id}`, data.path, listener));
    };
    port.onmessageerror = () => drop(peer);
    port.start();
    port.postMessage({ type: "ready" });
    timer ??= setInterval(() => {
      for (const peer of peers) {
        if (now() - peer.seen > 90_000) {
          drop(peer);
          continue;
        }
        try {
          peer.port.postMessage({ type: "ping" });
        } catch {
          drop(peer);
        }
      }
    }, 15_000);
    return () => drop(peer);
  }
  return {
    attach,
    close() {
      for (const peer of peers) drop(peer);
      connection.close();
    },
  };
}
