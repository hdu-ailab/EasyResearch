import { afterEach, expect, it, vi } from "vitest";
import { cancelBackgroundTask, getBackgroundTasks, promoteBackgroundTasks } from "./background";
import { requestJson, requestVoid } from "./transport";

afterEach(() => vi.unstubAllGlobals());

it.each(["json", "void"] as const)(
  "admits POST promotion through the real %s transport while GET listing waits for an ordinary body slot",
  async (transport) => {
    const encoder = new TextEncoder();
    const pending = new Map<string, { controller: ReadableStreamDefaultController<Uint8Array>; remaining: string }>();
    const started: string[] = [];
    let draining = false;
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${path}`;
      started.push(key);
      const text = key === "GET /api/sessions/root/background" ? '{"tasks":[]}' : '{"ok":true}';
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (draining) {
              controller.enqueue(encoder.encode(text));
              controller.close();
            } else pending.set(key, { controller, remaining: text });
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const finish = (key: string) => {
      const body = pending.get(key)!;
      pending.delete(key);
      body.controller.enqueue(encoder.encode(body.remaining));
      body.controller.close();
    };
    const ordinaryPaths = ["/api/models", "/api/agents", "/api/status"];
    const work: Promise<unknown>[] = ordinaryPaths.map((path) => requestJson(path, (value) => value));
    try {
      await vi.waitFor(() => expect(started).toHaveLength(3));
      // All response headers have arrived, but their bodies still own the slots.
      const listed = getBackgroundTasks("root");
      work.push(listed);
      const promoted =
        transport === "json"
          ? promoteBackgroundTasks("root")
          : requestVoid("/api/sessions/root/background", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });
      work.push(promoted);
      await vi.waitFor(() => expect(started).toContain("POST /api/sessions/root/background"));
      expect(started).not.toContain("GET /api/sessions/root/background");
      const cancelled = cancelBackgroundTask("root", "task");
      work.push(cancelled);
      const promotionBody = pending.get("POST /api/sessions/root/background")!;
      promotionBody.controller.enqueue(encoder.encode(promotionBody.remaining.slice(0, 6)));
      promotionBody.remaining = promotionBody.remaining.slice(6);
      await Promise.resolve();
      expect(started).not.toContain("POST /api/sessions/root/background/task/cancel");
      finish("POST /api/sessions/root/background");
      await promoted;
      await vi.waitFor(() => expect(started).toContain("POST /api/sessions/root/background/task/cancel"));
      expect(started).not.toContain("GET /api/sessions/root/background");
      finish("POST /api/sessions/root/background/task/cancel");
      await cancelled;
      await Promise.resolve();
      expect(started).not.toContain("GET /api/sessions/root/background");
      finish("GET /api/models");
      await vi.waitFor(() => expect(started).toContain("GET /api/sessions/root/background"));
      finish("GET /api/sessions/root/background");
      await expect(listed).resolves.toEqual({ tasks: [] });
      expect(
        fetch.mock.calls.filter(([path, init]) => path === "/api/sessions/root/background" && init?.method === "POST"),
      ).toHaveLength(1);
    } finally {
      draining = true;
      for (const key of pending.keys()) finish(key);
      await Promise.allSettled(work);
    }
  },
);
