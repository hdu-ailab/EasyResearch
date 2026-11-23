import { expect, it, vi } from "vitest";
import { RequestBudget } from "./request-budget";

it.each(["promotion", "cancellation"] as const)(
  "reserves background %s capacity through response-body completion while task reads remain ordinary",
  async (first) => {
    const queue = new RequestBudget();
    const started: string[] = [];
    let releaseOrdinary!: () => void;
    const ordinaryGate = new Promise<void>((resolve) => {
      releaseOrdinary = resolve;
    });
    const ordinary = Array.from({ length: 3 }, (_, index) =>
      queue.run("/api/models", undefined, async () => {
        started.push(`ordinary-${index}`);
        await ordinaryGate;
      }),
    );
    await Promise.resolve();
    const list = queue.run("/api/sessions/root%2Fone/background", undefined, async () => {
      started.push("list");
    });
    const output = queue.run(
      "/api/sessions/root%2Fone/background/task%2Fone/output?offset=0",
      undefined,
      async () => {
        started.push("output");
      },
      "GET",
    );
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
        },
      }),
    );
    const path = (action: string) =>
      `/api/sessions/root%2Fone/background${action === "cancellation" ? "/task%2Fone/cancel" : ""}`;
    const second = first === "promotion" ? "cancellation" : "promotion";
    const control = queue.run(
      path(first),
      undefined,
      async () => {
        started.push(first);
        return response.json();
      },
      "POST",
    );
    const nextControl = queue.run(
      path(second),
      undefined,
      async () => {
        started.push(second);
      },
      "POST",
    );
    let bodyEnded = false;
    try {
      await Promise.resolve();
      expect([...started]).toEqual(["ordinary-0", "ordinary-1", "ordinary-2", first]);
      // Headers exist already; even a partial body cannot release the fourth slot.
      body.enqueue(new TextEncoder().encode('{"ok":'));
      await Promise.resolve();
      expect(started).not.toContain(second);
      expect(started).not.toContain("list");
      expect(started).not.toContain("output");
      body.enqueue(new TextEncoder().encode("true}"));
      body.close();
      bodyEnded = true;
      await expect(control).resolves.toEqual({ ok: true });
      await vi.waitFor(() => expect(started).toContain(second));
      await nextControl;
      expect(started).not.toContain("list");
      expect(started).not.toContain("output");
    } finally {
      if (!bodyEnded) {
        body.enqueue(new TextEncoder().encode('{"ok":true}'));
        body.close();
      }
      releaseOrdinary();
      await Promise.allSettled([...ordinary, list, output, control, nextControl]);
    }
    expect(started).toContain("list");
    expect(started).toContain("output");
  },
);

it.each(["abort", "retry", "background-output-watches/lease"])(
  "retains slots through complete operations and reserves %s admission",
  async (action) => {
    const queue = new RequestBudget();
    const started: string[] = [];
    const releases: (() => void)[] = [];
    const work = (name: string, method?: string) =>
      queue.run(
        name,
        undefined,
        async () => {
          started.push(name);
          await new Promise<void>((r) => releases.push(r));
        },
        method,
      );
    const tasks = [
      work("/api/entries?path=a"),
      work("/api/file?path=b"),
      work("/api/file?path=c"),
      work("/api/models"),
      work("/api/agents"),
    ];
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["/api/entries?path=a", "/api/file?path=b", "/api/models"]);
    const stop = work(`/api/sessions/s/${action}`, action.startsWith("background-output-watches/") ? "PUT" : "POST");
    await Promise.resolve();
    expect(started.at(-1)).toBe(`/api/sessions/s/${action}`);
    for (let i = 0; i < 10; i++) {
      releases.splice(0).forEach((r) => {
        r();
      });
      await Promise.resolve();
      await Promise.resolve();
    }
    await Promise.all([...tasks, stop]);
    expect(started).toContain("/api/file?path=c");
    expect(started).toContain("/api/agents");
  },
);

it("cancels queued requests before their operation can mutate state", async () => {
  const queue = new RequestBudget();
  const releases: (() => void)[] = [];
  const running = Array.from({ length: 3 }, () =>
    queue.run("/api/models", undefined, () => new Promise<void>((r) => releases.push(r))),
  );
  await Promise.resolve();
  const controller = new AbortController();
  let executed = false;
  const queued = queue.run("/api/agents", controller.signal, async () => {
    executed = true;
  });
  const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await rejected;
  releases.forEach((r) => {
    r();
  });
  await Promise.all(running);
  expect(executed).toBe(false);
  await expect(
    queue.run("/api/models", undefined, async () => {
      throw new Error("failed");
    }),
  ).rejects.toThrow("failed");
  await expect(queue.run("/api/models", undefined, async () => "recovered")).resolves.toBe("recovered");
});

it("admits update cancellation while ordinary requests occupy their budget", async () => {
  const queue = new RequestBudget();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reads = Array.from({ length: 3 }, () => queue.run("/api/models", undefined, () => gate));
  await Promise.resolve();
  let admitted = false;
  const cancel = queue.run(
    "/api/update/action",
    undefined,
    async () => {
      admitted = true;
    },
    "POST",
  );
  try {
    await Promise.resolve();
    expect(admitted).toBe(true);
  } finally {
    release();
    await Promise.all([...reads, cancel]);
  }
});
