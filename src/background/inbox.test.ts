import { describe, expect, it, vi } from "vitest";
import { admitBackgroundInput, pendingBackgroundInputs, preserveBackgroundInputsWithoutWake } from "./inbox";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPi } from "../runtime/pi-import";

function journal(id = "root") {
  const entries: unknown[] = [];
  return { entries, getSessionId: () => id, getEntries: () => entries,
    appendCustomEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); return String(entries.length); } };
}
const input = { id: "notice-a", customType: "easyresearch:background_result", content: "result" };

describe("native background inbox admission", () => {
  it("persists once and recognizes queued and native-delivered notification ids", () => {
    const store = journal();
    expect(admitBackgroundInput(store, input)).toBe("pending");
    expect(admitBackgroundInput(store, input)).toBe("pending");
    expect(store.entries).toHaveLength(1);
    expect(pendingBackgroundInputs(store)).toEqual([input]);
    store.entries.push({ type: "custom_message", customType: input.customType, content: input.content,
      details: { inputID: input.id, ownerSessionID: "root" } });
    expect(admitBackgroundInput(store, input)).toBe("delivered");
    expect(pendingBackgroundInputs(store)).toEqual([]);
  });

  it("rejects payload conflicts without acknowledging the pending result", () => {
    const store = journal();
    admitBackgroundInput(store, input);
    expect(() => admitBackgroundInput(store, { ...input, content: "different" })).toThrow("conflict");
    expect(pendingBackgroundInputs(store)).toEqual([input]);
  });

  it("does not replay another native session's inherited queue", () => {
    const source = journal();
    admitBackgroundInput(source, input);
    const fork = journal("fork");
    fork.entries.push(...source.entries);
    expect(pendingBackgroundInputs(fork)).toEqual([]);
  });
  it("preserves the first persisted wake policy without making it part of input identity", () => {
    const store = journal();
    admitBackgroundInput(store, { ...input, wake: false });
    expect(admitBackgroundInput(store, { ...input, wake: true })).toBe("pending");
    expect(store.entries).toHaveLength(1);
    expect(pendingBackgroundInputs(store)).toEqual([{ ...input, wake: false }]);
    expect(() => admitBackgroundInput(store, { ...input, content: "conflict", wake: false })).toThrow("conflict");
    const legacy = journal();
    admitBackgroundInput(legacy, input);
    admitBackgroundInput(legacy, { ...input, wake: false });
    expect(pendingBackgroundInputs(legacy)).toEqual([input]);
  });
  it("retains terminal disposition progress across a failed native append without replaying a wake", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inbox-disposition-"));
    vi.stubEnv("HOME", directory); vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", directory);
    try {
      const pi = await importPi(); const manager = pi.SessionManager.create(directory, directory);
      manager.appendMessage({ role: "user", content: "accepted root input", timestamp: Date.now() });
      admitBackgroundInput(manager, { ...input, wake: true });
      admitBackgroundInput(manager, { ...input, id: "notice-b", content: "second", wake: true });
      const append = manager.appendCustomMessageEntry.bind(manager);
      const fault = vi.spyOn(manager, "appendCustomMessageEntry").mockImplementation((type, content, display, details) => {
        if (content === "second") throw new Error("disk full");
        return append(type, content, display, details);
      });
      expect(() => preserveBackgroundInputsWithoutWake(manager)).toThrow("disk full");
      expect(pendingBackgroundInputs(manager).map((entry) => entry.id)).toEqual(["notice-b"]);
      fault.mockRestore();
      const reopened = pi.SessionManager.open(manager.getSessionFile()!);
      preserveBackgroundInputsWithoutWake(reopened);
      preserveBackgroundInputsWithoutWake(reopened);
      expect(reopened.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(2);
      expect(pendingBackgroundInputs(reopened)).toEqual([]);
      expect(admitBackgroundInput(reopened, { ...input, wake: true })).toBe("delivered");
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("rejects buffered custom-only native admission and replays passive policy from disk", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inbox-durability-"));
    try {
      const pi = await importPi();
      const manager = pi.SessionManager.create(directory, directory);
      expect(() => admitBackgroundInput(manager, { ...input, wake: false })).toThrow(/materialized/i);
      expect(pendingBackgroundInputs(manager)).toEqual([]);
      manager.appendMessage({ role: "user", content: "actual accepted input", timestamp: Date.now() });
      expect(admitBackgroundInput(manager, { ...input, wake: false })).toBe("pending");
      const reopened = pi.SessionManager.open(manager.getSessionFile()!);
      expect(pendingBackgroundInputs(reopened)).toEqual([{ ...input, wake: false }]);
      expect(admitBackgroundInput(reopened, { ...input, wake: true })).toBe("pending");
      reopened.appendCustomMessageEntry(input.customType, input.content, false, { ownerSessionID: reopened.getSessionId(), inputID: input.id });
      expect(admitBackgroundInput(reopened, { ...input, wake: true })).toBe("delivered");
      expect(pendingBackgroundInputs(reopened)).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
