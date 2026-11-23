import { describe, expect, it, vi } from "vitest";
import { ExecutionClaims, materializeNativeCustomInput, readExecutionClaim } from "./execution-claims";
import fs, { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPi } from "../runtime/pi-import";

function journal(id = "root") {
  const entries: unknown[] = [];
  let fail = false;
  return {
    entries,
    failNext() { fail = true; },
    getSessionId: () => id,
    getEntries: () => entries,
    appendCustomEntry(customType: string, data: unknown) {
      if (fail) { fail = false; throw new Error("disk full"); }
      entries.push({ type: "custom", customType, data });
      return String(entries.length);
    },
  };
}

describe("durable execution claims", () => {
  it("preserves a suspended period across reconstruction and releases user cancellation", () => {
    const store = journal();
    const first = new ExecutionClaims(store);
    first.start();
    const period = readExecutionClaim(store.entries, "root")!.periodId;
    first.suspend();
    first.settle();
    const next = new ExecutionClaims(store);
    expect(next.prepareResume()).toBe(true);
    next.start();
    expect(readExecutionClaim(store.entries, "root")).toMatchObject({ periodId: period, attempts: 1, pending: true });
    next.cancel();
    expect(new ExecutionClaims(store).prepareResume()).toBe(false);
  });

  it("charges ten restart attempts before running and resets only for a new period", () => {
    const store = journal();
    new ExecutionClaims(store).start();
    for (let attempt = 1; attempt <= 10; attempt++) {
      const restarted = new ExecutionClaims(store);
      expect(restarted.prepareResume()).toBe(true);
      restarted.start();
      expect(readExecutionClaim(store.entries, "root")?.attempts).toBe(attempt);
    }
    expect(new ExecutionClaims(store).prepareResume()).toBe(false);
    expect(readExecutionClaim(store.entries, "root")).toMatchObject({ pending: false, outcome: "exhausted" });
    const explicit = new ExecutionClaims(store);
    explicit.start();
    explicit.settle();
    explicit.start();
    expect(readExecutionClaim(store.entries, "root")).toMatchObject({ pending: true, attempts: 0 });
  });

  it("never grants inherited fork entries or malformed records resume authority", () => {
    const store = journal();
    new ExecutionClaims(store).start();
    expect(readExecutionClaim(store.entries, "fork")).toBeUndefined();
    expect(readExecutionClaim([{ type: "custom", customType: "easyresearch:execution", data: { sessionId: "root", pending: true } }], "root")).toBeUndefined();
  });

  it("does not consume a restart attempt or clear a claim when append fails", () => {
    const store = journal();
    const owner = new ExecutionClaims(store);
    owner.start();
    store.failNext();
    expect(() => owner.prepareResume()).toThrow("disk full");
    expect(readExecutionClaim(store.entries, "root")).toMatchObject({ pending: true, attempts: 0 });
    store.failNext();
    expect(() => owner.cancel()).toThrow("disk full");
    expect(readExecutionClaim(store.entries, "root")?.pending).toBe(true);
  });
  it("does not admit a native custom-only claim before the real conversation materializes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claim-durability-"));
    try {
      const pi = await importPi();
      const store = pi.SessionManager.create(directory, directory);
      const claim = { version: 1, sessionId: store.getSessionId(), periodId: "period", attempts: 0, pending: true };
      store.appendCustomEntry("easyresearch:execution", claim);
      expect(existsSync(store.getSessionFile()!)).toBe(false);
      const owner = new ExecutionClaims(store);
      expect(() => owner.prepareResume()).toThrow(/materialized|durab/i);
      store.appendMessage({ role: "user", content: "accepted user input", timestamp: Date.now() });
      owner.start();
      expect(owner.current()).toMatchObject({ periodId: "period", attempts: 0, pending: true });
      expect(store.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "easyresearch:execution")).toHaveLength(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("leaves metadata-only native sessions unmaterialized", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claim-metadata-"));
    try {
      const pi = await importPi();
      const store = pi.SessionManager.create(directory, directory);
      store.appendCustomEntry("test:metadata", { value: "not model input" });
      expect(materializeNativeCustomInput(store, store.getSessionFile()!)).toBe(false);
      store.appendCustomMessageEntry("test:empty", "   ", false);
      expect(materializeNativeCustomInput(store, store.getSessionFile()!)).toBe(false);
      expect(existsSync(store.getSessionFile()!)).toBe(false);
      expect(() => new ExecutionClaims(store).start()).toThrow(/materialized/i);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("materializes exact native bytes and preserves a non-tail active leaf and projection through public rebinding", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claim-custom-"));
    try {
      const pi = await importPi();
      const store = pi.SessionManager.create(directory, directory);
      const custom = store.appendCustomMessageEntry("test:accepted", "actual accepted custom input", false);
      store.appendCustomEntry("test:other-branch", { value: true });
      store.branch(custom);
      const before = [store.getHeader(), ...store.getEntries()].map((entry) => `${JSON.stringify(entry)}\n`).join("");
      const projection = store.buildSessionProjection().messages;
      const branch = store.getBranch();
      const path = store.getSessionFile()!;
      expect(materializeNativeCustomInput(store, path)).toBe(true);
      expect(store.getSessionFile()).toBe(path);
      expect(store.getLeafId()).toBe(custom);
      expect(store.getBranch()).toEqual(branch);
      expect(store.buildSessionProjection().messages).toEqual(projection);
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(materializeNativeCustomInput(store, path)).toBe(false);
      expect(readFileSync(path, "utf8")).toBe(before);
      const claims = new ExecutionClaims(store);
      claims.start();
      expect(new ExecutionClaims(pi.SessionManager.open(path)).current()?.pending).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("cleans only its unpublished staging file after write failure without changing native state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "claim-custom-write-"));
    try {
      const pi = await importPi();
      const store = pi.SessionManager.create(directory, directory);
      const leaf = store.appendCustomMessageEntry("test:accepted", "actual custom input", false);
      const entries = store.getEntries();
      const stub = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => { throw new Error("write failed"); });
      try { expect(() => materializeNativeCustomInput(store, store.getSessionFile()!)).toThrow("write failed"); }
      finally { stub.mockRestore(); }
      expect(existsSync(store.getSessionFile()!)).toBe(false);
      expect(readdirSync(directory)).toEqual([]);
      expect(store.getLeafId()).toBe(leaf);
      expect(store.getEntries()).toEqual(entries);
      expect(materializeNativeCustomInput(store, store.getSessionFile()!)).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
