import type { BrowserContext } from "@playwright/test";

/** UI-only fixtures keep their existing per-topic mock data. Real channel/worker
 * acceptance uses the compiled daemon, never this adapter. No API can escape the
 * caller's route fixtures through an unmocked SharedWorker request.
 */
export async function installBrowserEventFixture(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(window, "SharedWorker", { value: undefined, configurable: true });
    const NativeSource = window.EventSource;
    const nativeFetch = window.fetch;
    let current: FixtureSource | undefined;
    class FixtureSource {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      sources = new Map<string, { path: string; source: EventSource }>();
      closed = false;
      constructor() {
        current = this;
        queueMicrotask(() => this.emit({ type: "connected", id: "fixture", bootId: "fixture" }));
      }
      emit(frame: unknown) {
        if (!this.closed) this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
      }
      close() {
        this.closed = true;
        for (const { source } of this.sources.values()) source.close();
        this.sources.clear();
      }
      replace(subscriptions: { id: string; path: string }[]) {
        const desired = new Map(subscriptions.map((item) => [item.id, item.path]));
        for (const [id, entry] of this.sources) {
          if (desired.get(id) === entry.path) continue;
          entry.source.close();
          this.sources.delete(id);
        }
        for (const { id, path } of subscriptions) {
          if (this.sources.has(id)) continue;
          const source = new NativeSource(path);
          this.sources.set(id, { path, source });
          source.onmessage = (event) =>
            this.emit({ type: "event", id, bootId: "fixture", event: JSON.parse(event.data) });
          // route.fulfill supplies a finite fixture, not an actual disconnected daemon.
          source.onerror = () => {};
        }
      }
    }
    window.EventSource = new Proxy(NativeSource, {
      construct(target, args) {
        if (new URL(String(args[0]), location.href).pathname === "/api/events") return new FixtureSource();
        return Reflect.construct(target, args);
      },
    });
    window.fetch = (async (resource: RequestInfo | URL, init?: RequestInit) => {
      const url = resource instanceof Request ? resource.url : String(resource);
      if (new URL(url, location.href).pathname === "/api/events/fixture") {
        const body = JSON.parse(String(init?.body));
        current?.replace(body.subscriptions);
        return Response.json({ applied: true, revision: body.revision });
      }
      return nativeFetch(resource, init);
    }) as typeof fetch;
  });
}
