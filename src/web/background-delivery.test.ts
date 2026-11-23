import { describe, expect, it } from "vitest";
import { RootBackgroundDelivery } from "./background-delivery";

function fixture() {
  const entries: unknown[] = [];
  const sent: string[] = [];
  let resolveRun!: () => void;
  const run = new Promise<void>((resolve) => { resolveRun = resolve; });
  const operations: Promise<void>[] = [];
  let paused = false;
  const session = {
    sessionId: "root", isIdle: true, isStreaming: false, waitForIdle: async () => {},
    sendCustomMessage: async (message: { content: string; customType: string; details: unknown }) => {
      sent.push(message.content);
      entries.push({ type: "custom_message", ...message });
      session.isStreaming = true;
      await run;
    },
  };
  const delivery = new RootBackgroundDelivery({
    journal: { getSessionId: () => "root", getEntries: () => entries,
      appendCustomEntry(customType, data) { entries.push({ type: "custom", customType, data }); return String(entries.length); } },
    session,
    acquire: async () => () => {}, ready: async () => {}, canWake: () => !paused,
    stopped: () => false, own: (operation) => { operations.push(operation); }, changed: () => {},
    onError: (error) => { throw error; },
  });
  return { delivery, entries, sent, operations, resolveRun, pause: (value: boolean) => { paused = value; } };
}

describe("root background notification delivery", () => {
  it("admits later notices without waiting for an earlier completion-woken model run", async () => {
    const f = fixture();
    await f.delivery.admit({ id: "one", customType: "background", content: "first" });
    await f.delivery.admit({ id: "two", customType: "background", content: "second" });
    await f.delivery.drain();
    expect(f.sent).toEqual(["first", "second"]);
    await f.delivery.admit({ id: "one", customType: "background", content: "first" });
    expect(f.sent).toEqual(["first", "second"]);
    f.resolveRun();
    await Promise.all(f.operations);
    await f.delivery.close();
  });

  it("retains durable input through a paused caller and resumes once coherent", async () => {
    const f = fixture();
    f.pause(true);
    await f.delivery.admit({ id: "one", customType: "background", content: "first" });
    expect(f.sent).toEqual([]);
    expect(f.delivery.hasPending()).toBe(true);
    f.pause(false);
    await f.delivery.drain();
    expect(f.sent).toEqual(["first"]);
    f.resolveRun();
    await Promise.all(f.operations);
    await f.delivery.close();
  });
});
