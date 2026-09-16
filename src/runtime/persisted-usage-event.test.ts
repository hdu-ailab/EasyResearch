import { describe, expect, it } from "vitest";
import { AGENT_STATUS_TYPE } from "../subagent/notifications";
import { publishPersistedUsageEntry } from "./persisted-usage-event";

describe("persisted entry bridge", () => {
  it.each(["before", "after"])("locates the exact status entry when persistence occurs %s message_end", async (timing) => {
    const details = { batchId: "b0", outcomes: [{ launchId: "l0", agentId: "search_0", status: "error" }] };
    const message = { role: "custom", customType: AGENT_STATUS_TYPE, content: "control", display: false, details };
    const persisted = { ...message, type: "custom_message", id: "exact", timestamp: "2026-09-16T00:00:00.000Z" };
    const entries: unknown[] = [{ ...persisted, id: "stale", details: structuredClone(details) }];
    if (timing === "before") entries.push(persisted);
    const published: unknown[] = [];
    publishPersistedUsageEntry({ type: "message_end", message }, { getEntries: () => entries }, (event) => published.push(event));
    expect(published).toEqual([]);
    if (timing === "after") entries.push(persisted);
    await Promise.resolve();
    expect(published).toEqual([{ type: "entry_appended", entry: persisted }]);
  });

  it("does not mistake an older batch entry or unrelated hidden message for this delivery", async () => {
    const message = { role: "custom", customType: AGENT_STATUS_TYPE, content: "control", display: false, details: { batchId: "b0" } };
    const entries = [{ ...message, type: "custom_message", id: "old", details: { batchId: "b0" } }];
    const published: unknown[] = [];
    for (const candidate of [message, { ...message, customType: "other" }]) {
      publishPersistedUsageEntry({ type: "message_end", message: candidate }, { getEntries: () => entries }, (event) => published.push(event));
    }
    await Promise.resolve();
    expect(published).toEqual([]);
  });

  it("preserves usage-bearing message identity and isolates observational failures", async () => {
    const message = { role: "assistant", usage: { input: 1 } };
    const entry = { type: "message", id: "usage", message };
    const published: unknown[] = [];
    publishPersistedUsageEntry({ type: "message_end", message }, { getEntries: () => [entry] }, (event) => published.push(event));
    publishPersistedUsageEntry({ type: "message_end", message }, { getEntries: () => { throw new Error("unavailable"); } }, () => { throw new Error("observer"); });
    await Promise.resolve();
    expect(published).toEqual([{ type: "entry_appended", entry }]);
  });
});
