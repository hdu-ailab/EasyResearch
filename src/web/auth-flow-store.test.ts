import { describe, it, expect } from "vitest";
import { createAuthFlowStore } from "./auth-flow-store";
import type { AuthFlowEventDto } from "./contracts";

const promptSecret: AuthFlowEventDto = {
  type: "prompt",
  kind: "secret",
  message: "API key",
};
const notifyInfo: AuthFlowEventDto = {
  type: "notify",
  event: { kind: "info", message: "hi" },
};
const notifyProgress: AuthFlowEventDto = {
  type: "notify",
  event: { kind: "progress", message: "x" },
};

describe("auth-flow-store", () => {
  it("replays buffered notifies and a pending prompt to a late subscriber", () => {
    const store = createAuthFlowStore();
    store.create("f1", new AbortController().signal);
    store.emit("f1", notifyInfo);
    store.emit("f1", notifyProgress);
    store.emitPrompt("f1", promptSecret);
    const received: AuthFlowEventDto[] = [];
    const unsub = store.subscribe("f1", (e) => received.push(e));
    expect(received).toEqual([notifyInfo, notifyProgress, promptSecret]);
    unsub();
  });

  it("forwards live events to an existing subscriber after subscribe replay", () => {
    const store = createAuthFlowStore();
    store.create("f1", new AbortController().signal);
    const received: AuthFlowEventDto[] = [];
    const unsub = store.subscribe("f1", (e) => received.push(e));
    store.emit("f1", notifyInfo);
    store.emitPrompt("f1", promptSecret);
    expect(received).toEqual([notifyInfo, promptSecret]);
    unsub();
  });

  it("awaitRespond resolves with the posted value", async () => {
    const store = createAuthFlowStore();
    store.create("f1", new AbortController().signal);
    const pending = store.awaitRespond("f1");
    expect(store.resolveRespond("f1", "sk-abc")).toBe(true);
    await expect(pending).resolves.toBe("sk-abc");
    expect(store.get("f1")?.pendingPrompt).toBeNull();
  });

  it("awaitRespond on an unknown flow rejects immediately", async () => {
    const store = createAuthFlowStore();
    await expect(store.awaitRespond("nope")).rejects.toThrow();
  });

  it("cancel rejects pending awaitRespond and aborts the controller", async () => {
    const store = createAuthFlowStore();
    store.create("f1", new AbortController().signal);
    const pending = store.awaitRespond("f1");
    store.cancel("f1");
    await expect(pending).rejects.toThrow();
    expect(store.get("f1")?.abortController.signal.aborted).toBe(true);
  });

  it("terminate marks terminated and returns buffer + pending + final event", () => {
    const store = createAuthFlowStore();
    store.create("f1", new AbortController().signal);
    store.emit("f1", notifyInfo);
    store.emitPrompt("f1", { type: "prompt", kind: "text", message: "?" });
    const replay = store.terminate("f1", { type: "done", credential: { type: "api_key" } });
    expect(replay.map((e) => e.type)).toEqual(["notify", "prompt", "done"]);
    expect(store.get("f1")?.terminated).toBe(true);
  });

  it("terminate on an unknown flow returns just the final event", () => {
    const store = createAuthFlowStore();
    const replay = store.terminate("missing", { type: "error", message: "x" });
    expect(replay).toEqual([{ type: "error", message: "x" }]);
  });

  it("resolveRespond returns false when no prompt pending", () => {
    const store = createAuthFlowStore();
    store.create("f1", new AbortController().signal);
    expect(store.resolveRespond("f1", "x")).toBe(false);
  });

  it("pendingKind reports the current prompt kind or null", async () => {
    const store = createAuthFlowStore();
    store.create("f1", new AbortController().signal);
    expect(store.pendingKind("f1")).toBeNull();
    store.emitPrompt("f1", promptSecret);
    expect(store.pendingKind("f1")).toBe("secret");
    const pending = store.awaitRespond("f1");
    store.resolveRespond("f1", "x");
    await pending;
    expect(store.pendingKind("f1")).toBeNull();
  });

  it("list shows current flows", () => {
    const store = createAuthFlowStore();
    store.create("f1", new AbortController().signal);
    store.create("f2", new AbortController().signal);
    expect(store.list().sort()).toEqual(["f1", "f2"]);
  });

  it("rejectRespond rejects a pending prompt", async () => {
    const store = createAuthFlowStore();
    store.create("f1", new AbortController().signal);
    const pending = store.awaitRespond("f1");
    store.rejectRespond("f1", new Error("boom"));
    await expect(pending).rejects.toThrow("boom");
    expect(store.pendingKind("f1")).toBeNull();
  });
});