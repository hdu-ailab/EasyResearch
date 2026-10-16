import { EventConnection, type EventListener } from "./event-connection";
import type { Delivery } from "./event-worker-broker";

interface Listener extends EventListener {
  path: string;
}
function reportError(listener: EventListener) {
  try {
    listener.onError();
  } catch {
    /* A detached view must not block other subscribers. */
  }
}
class BrowserEvents {
  readonly listeners = new Map<string, Listener>();
  private sequence = 0;
  private port?: MessagePort;
  private fallback?: EventConnection;
  private fallbackUnsubscribers = new Map<string, () => void>();
  private ready = false;
  private suspended = false;
  private handshake?: ReturnType<typeof setTimeout>;
  private lastSeen = Date.now();
  private readonly hide = () => {
    this.suspended = true;
    this.disconnect();
  };
  private readonly show = () => {
    this.suspended = false;
    this.connect();
  };
  private readonly foreground = () => {
    if (document.visibilityState === "visible" && Date.now() - this.lastSeen > 45_000) {
      this.disconnect();
      this.connect();
    }
  };

  constructor() {
    window.addEventListener("pagehide", this.hide);
    window.addEventListener("pageshow", this.show);
    window.addEventListener("online", this.foreground);
    document.addEventListener("visibilitychange", this.foreground);
  }
  subscribe(path: string, listener: EventListener): () => void {
    const id = String(++this.sequence);
    this.listeners.set(id, { ...listener, path });
    if (!this.port && !this.fallback) this.connect();
    else this.add(id);
    return () => {
      this.listeners.delete(id);
      this.port?.postMessage({ type: "unsubscribe", id });
      this.fallbackUnsubscribers.get(id)?.();
      this.fallbackUnsubscribers.delete(id);
      if (!this.listeners.size) this.close();
    };
  }
  private add(id: string) {
    const listener = this.listeners.get(id);
    if (!listener || this.suspended) return;
    if (this.fallback) this.fallbackUnsubscribers.set(id, this.fallback.subscribe(id, listener.path, listener));
    else if (this.ready) this.port?.postMessage({ type: "subscribe", id, path: listener.path });
  }
  private connect() {
    if (this.suspended || this.port || this.fallback || !this.listeners.size) return;
    if (typeof SharedWorker === "undefined") {
      this.startFallback();
      return;
    }
    try {
      const worker = new SharedWorker(new URL("./event-worker.ts", import.meta.url), {
        type: "module",
      });
      const port = worker.port;
      this.port = port;
      this.handshake = setTimeout(() => {
        if (this.port === port) this.startFallback();
      }, 3000);
      worker.onerror = () => {
        if (this.port === port) this.startFallback();
      };
      port.onmessageerror = () => {
        if (this.port === port) this.startFallback();
      };
      port.onmessage = ({ data }) => {
        if (this.port !== port) return;
        this.lastSeen = Date.now();
        if (data?.type === "ready") {
          clearTimeout(this.handshake);
          this.ready = true;
          for (const id of this.listeners.keys()) this.add(id);
        } else if (data?.type === "ping") port.postMessage({ type: "pong" });
        else if (data?.type === "disconnected") {
          this.disconnect();
          for (const listener of this.listeners.values()) reportError(listener);
          this.connect();
        } else if (data?.type === "batch" && Array.isArray(data.items)) {
          try {
            for (const item of data.items as Delivery[]) {
              const listener = this.listeners.get(item.id);
              if (!listener) continue;
              try {
                if (item.type === "event") listener.onEvent(item.event);
                else reportError(listener);
              } catch {
                reportError(listener);
              }
            }
          } finally {
            port.postMessage({ type: "ack", sequence: data.sequence });
          }
        }
      };
      port.start();
    } catch {
      this.startFallback();
    }
  }
  private startFallback() {
    this.disconnect();
    if (this.suspended || !this.listeners.size) return;
    this.fallback = new EventConnection();
    for (const id of this.listeners.keys()) this.add(id);
  }
  private disconnect() {
    clearTimeout(this.handshake);
    if (this.port) {
      try {
        this.port.postMessage({ type: "bye" });
      } catch {
        /* failed worker */
      }
      this.port.close();
      this.port = undefined;
    }
    this.ready = false;
    this.fallback?.close();
    this.fallback = undefined;
    this.fallbackUnsubscribers.clear();
  }
  private close() {
    this.disconnect();
    window.removeEventListener("pagehide", this.hide);
    window.removeEventListener("pageshow", this.show);
    window.removeEventListener("online", this.foreground);
    document.removeEventListener("visibilitychange", this.foreground);
    if (browserEvents === this) browserEvents = undefined;
  }
}

let browserEvents: BrowserEvents | undefined;
export function subscribeSharedEvents(path: string, listener: EventListener): () => void {
  browserEvents ??= new BrowserEvents();
  return browserEvents.subscribe(path, listener);
}
