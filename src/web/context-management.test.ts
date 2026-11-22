import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importPi } from "../runtime/pi-import";
import { CONTEXT_TEXT_PAGE_CHARS, FOLDED_CONTEXT_OUTPUT, RootContextManager, parseContextEditRequest, type ContextRuntime } from "./context-management";
import type { ContextEditDto, ContextSnapshotDto } from "./context-contracts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-context-"));
  for (const name of ["home", "agent", "project", "sessions"]) mkdirSync(join(root, name));
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("USERPROFILE", join(root, "home"));
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubGlobal("fetch", async () => { throw new Error("Network forbidden"); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const pi = await importPi();
  const ai = await import("@earendil-works/pi-ai");
  const provider = ai.fauxProvider({ provider: "context-test", models: [{ id: "test", contextWindow: 32_000, maxTokens: 1_000 }] });
  const manager = pi.SessionManager.create(join(root, "project"), join(root, "sessions"));
  let busy = false;
  let promptOverride: string | undefined;
  const notify = vi.fn();
  const runtime: ContextRuntime = {
    sessionId: manager.getSessionId(), sessionManager: manager, model: provider.getModel(), isIdle: true,
    get systemPrompt() { return promptOverride ?? ai.getCurrentSystemPrompt(manager.buildSessionProjection().messages); },
    set systemPrompt(value: string) { promptOverride = value; },
    agent: { state: { get tools() { return ai.getCurrentTools(manager.buildSessionProjection().messages); } } },
    getActiveToolNames: () => [], getAllTools: () => [], refreshContext: vi.fn(),
  };
  const controller = (source: SessionManager = manager) => new RootContextManager({ ...runtime, sessionManager: source }, pi, () => busy, notify, undefined, ai);
  const make = () => new RootContextManager(runtime, pi, () => busy, notify, undefined, ai);
  const context = make();
  manager.appendMessage({ role: "system", content: "Current system", timestamp: 1 });
  const user = manager.appendMessage({ role: "user", content: "Question", timestamp: 2 });
  const assistant = manager.appendMessage({ ...ai.fauxAssistantMessage([
    { type: "thinking", thinking: "Keep private reasoning" }, { type: "text", text: "Keep assistant prose" },
    { type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
    { type: "toolCall", id: "b", name: "read", arguments: { path: "b" } },
  ], { stopReason: "toolUse" }), provider: provider.getModel().provider, model: provider.getModel().id });
  const resultA = manager.appendMessage({ role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "RAW_A_".repeat(1000) }], isError: false, timestamp: 4 });
  const resultB = manager.appendMessage({ role: "toolResult", toolCallId: "b", toolName: "read", content: [{ type: "text", text: "RAW_B_".repeat(1000) }], isError: false, timestamp: 5 });
  manager.appendMessage({ ...ai.fauxAssistantMessage("Final response"), provider: provider.getModel().provider, model: provider.getModel().id });
  const edit = (snapshot: ContextSnapshotDto, edits: ContextEditDto[]) => ({ revision: snapshot.revision, edits });
  return { pi, ai, provider, manager, runtime, context, controller, make, notify, user, assistant, resultA, resultB, edit, setBusy: (value: boolean) => { busy = value; } };
}

describe("native root context projection and edits", () => {
  it("resolves replaced system sections and removed tools once for raw text, estimates and cache", async () => {
    const h = await fixture();
    h.manager.appendMessage({ role: "system", content: "", sections: { instructions: "OBSOLETE_INSTRUCTIONS_".repeat(60) },
      toolsAdded: [{ name: "obsolete_tool", description: "Old tool", parameters: { type: "object" } }], timestamp: 40 });
    h.manager.appendMessage({ role: "system", content: "", sections: { instructions: "Current" }, toolsRemoved: [{ name: "obsolete_tool" }], timestamp: 41 });
    const projected = h.manager.buildSessionProjection().messages;
    const prompt = h.ai.getCurrentSystemPrompt(projected);
    Object.assign(h.runtime, { systemPrompt: prompt, isIdle: true, agent: { state: { tools: [] } } });
    const beforeReply = h.context.snapshot();
    const system = beforeReply.items.filter((item) => item.type === "system");
    expect(system).toHaveLength(1);
    const resolved = h.ai.createInitialSystemMessage(prompt, h.ai.getCurrentTools(projected))!;
    expect(system[0]!.tokens).toBe(h.pi.estimateTokens(resolved));
    for (const view of ["original", "current"] as const) {
      const raw = h.context.item(beforeReply.revision, system[0]!.id, view).text;
      expect(raw).toBe(prompt);
      expect(raw).not.toContain("OBSOLETE");
      expect(raw).not.toContain("obsolete_tool");
      expect(raw).not.toContain("[object Object]");
    }
    h.manager.appendMessage({ ...h.ai.fauxAssistantMessage("New answer"), provider: h.runtime.model!.provider, model: h.runtime.model!.id });
    const latest = h.context.snapshot();
    const estimate = h.context.preview(h.edit(latest, []));
    const resolvedInput = [resolved, ...projected.filter((message) => message.role !== "system")];
    const expected = resolvedInput.reduce((sum, message) => sum + (message.role === "assistant"
      ? message.content.reduce((subtotal, block) => subtotal + h.pi.estimateTokens({ ...message, content: [block] }), 0) : h.pi.estimateTokens(message)), 0);
    expect(estimate.cache.reusableTokens).toBe(expected);
    expect(estimate.cache.reusableTokens).toBe(beforeReply.totalTokens);
    expect(estimate.cache.hitRate).toBe(expected / latest.totalTokens);
  });

  it("reflects pending idle native prompt/tool changes and invalidates the prior request baseline", async () => {
    const h = await fixture();
    const before = h.context.snapshot();
    const tools = [{ name: "new_tool", description: "New current tool", parameters: { type: "object" }, constrainedSampling: false as const }];
    Object.assign(h.runtime, { systemPrompt: "Refreshed idle instructions", isIdle: true,
      agent: { state: { tools } }, getActiveToolNames: () => ["new_tool"], getAllTools: () => tools });
    const after = h.context.snapshot();
    const system = after.items.filter((item) => item.type === "system");
    expect(system).toHaveLength(1);
    const text = h.context.item(after.revision, system[0]!.id, "current").text;
    expect(text).toContain("Refreshed idle instructions");
    expect(text).toContain("new_tool");
    expect(text).not.toContain("Current system");
    expect(system[0]!.tokens).toBe(h.pi.estimateTokens(h.ai.createInitialSystemMessage(h.runtime.systemPrompt, tools)!));
    expect(h.context.preview(h.edit(after, [])).cache.hitRate).toBeNull();
    expect(() => h.context.item(before.revision, before.items[0]!.id, "current")).toThrow(expect.objectContaining({ code: "CONTEXT_STALE" }));
  });

  it("invalidates cache for an idle tool-only change with an unchanged system prompt", async () => {
    const h = await fixture();
    const before = h.context.snapshot();
    expect(h.context.preview(h.edit(before, [])).cache.hitRate).not.toBeNull();
    const tools = [{ name: "only_new_tool", description: "Changed declarations", parameters: { type: "object" } }];
    Object.assign(h.runtime, { agent: { state: { tools } } });
    const after = h.context.snapshot();
    expect(h.context.preview(h.edit(after, [])).cache.hitRate).toBeNull();
    expect(after.revision).not.toBe(before.revision);
    const system = after.items.find((item) => item.type === "system")!;
    expect(h.context.item(after.revision, system.id, "current").text).toContain("only_new_tool");
  });

  it.each([1, 20])("redacts recognized base64 argument fields regardless of payload length (repeat=%s)", async (repeat) => {
    const h = await fixture();
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1kAAAAASUVORK5CYII=".repeat(repeat);
    const source = h.manager.appendMessage(h.ai.fauxAssistantMessage({ type: "toolCall", id: "image-call", name: "image", arguments: {
      data: png, nested: { base64: png }, caption: "Retained caption",
    } }, { stopReason: "toolUse" }));
    const snapshot = h.context.snapshot();
    const item = snapshot.items.find((item) => item.id.startsWith(source))!;
    expect(item.preview).not.toContain(png);
    for (const view of ["original", "current"] as const) {
      const text = h.context.item(snapshot.revision, item.id, view).text;
      expect(text).not.toContain(png);
      expect(text).toContain("[binary data omitted]");
      expect(text).toContain("Retained caption");
    }
  });

  it("uses the last assistant message with all text blocks for overview, then falls back within that last message", async () => {
    const h = await fixture();
    const final = h.manager.appendMessage(h.ai.fauxAssistantMessage([
      { type: "thinking", thinking: "Last reasoning" }, { type: "text", text: "Last first block" },
      { type: "text", text: "Last second block" },
    ]));
    let snapshot = h.context.snapshot();
    const segment = snapshot.segments.find((segment) => segment.type === "assistant")!;
    expect(segment.preview).toBe("Last first block\n\nLast second block");
    expect(snapshot.items.some((item) => item.preview === "Keep assistant prose")).toBe(true);
    const finalText = snapshot.items.filter((item) => item.id.startsWith(final) && item.type === "assistant");
    snapshot = h.context.apply(h.edit(snapshot, finalText.map((item) => ({ target: "item", id: item.id, action: "delete" }))));
    expect(snapshot.segments.find((candidate) => candidate.id === segment.id)!.preview).toBe("Last reasoning");
    h.manager.appendMessage(h.ai.fauxAssistantMessage({ type: "toolCall", id: "last-call", name: "inspect", arguments: { path: "last" } }, { stopReason: "toolUse" }));
    snapshot = h.context.snapshot();
    expect(snapshot.segments.find((candidate) => candidate.id === segment.id)!.preview).toContain("inspect");
    expect(snapshot.segments.find((candidate) => candidate.id === segment.id)!.preview).not.toContain("Last reasoning");
  });

  it("deletes one call/result pair from mixed assistant content while preserving siblings and native history", async () => {
    const h = await fixture();
    const bytes = readFileSync(h.manager.getSessionFile()!);
    const before = h.context.snapshot();
    const result = before.items.find((item) => item.id.startsWith(h.resultA))!;
    const request = h.edit(before, [{ target: "item", id: result.id, action: "delete" }]);
    const prediction = h.context.preview(request);
    expect(readFileSync(h.manager.getSessionFile()!)).toEqual(bytes);
    expect(prediction.changes.map((change) => change.itemId).sort()).toEqual([result.id, ...result.relatedIds].sort());
    const after = h.context.apply(request);
    const projected = h.manager.buildSessionProjection().messages;
    const assistant = projected.find((message) => message.role === "assistant")!;
    expect(assistant).toMatchObject({ content: [
      { type: "thinking", thinking: "Keep private reasoning" }, { type: "text", text: "Keep assistant prose" },
      { type: "toolCall", id: "b" },
    ] });
    expect(projected.filter((message) => message.role === "toolResult").map((message) => message.toolCallId)).toEqual(["b"]);
    const siblingBefore = before.items.find((item) => item.type === "tool-call" && item.id !== result.relatedIds[0])!;
    expect(after.items.find((item) => item.id === siblingBefore.id)?.type).toBe("tool-call");
    expect(after.items.some((item) => result.relatedIds.includes(item.id))).toBe(false);
    expect(after.totalTokens).toBe(prediction.afterTokens);
    expect(after.totalTokens).toBe(after.items.reduce((sum, item) => sum + item.tokens, 0));
    expect(readFileSync(h.manager.getSessionFile()!).subarray(0, bytes.length)).toEqual(bytes);
    expect(h.manager.getEntries().filter((entry) => entry.type === "context_edit")).toHaveLength(2);
    expect(h.notify).toHaveBeenCalledOnce();
  });

  it("folds exactly, persists across reopen, and retains raw originals", async () => {
    const h = await fixture();
    const snapshot = h.context.snapshot();
    const result = snapshot.items.find((item) => item.id.startsWith(h.resultA))!;
    const after = h.context.apply(h.edit(snapshot, [{ target: "item", id: result.id, action: "fold" }]));
    expect(h.context.item(after.revision, result.id, "current").text).toBe(FOLDED_CONTEXT_OUTPUT);
    expect(h.context.item(after.revision, result.id, "original").text).toBe("RAW_A_".repeat(1000));
    const reopened = h.pi.SessionManager.open(h.manager.getSessionFile()!, join(root, "sessions"));
    const restored = h.controller(reopened).snapshot();
    expect(restored.items.find((item) => item.id === result.id)?.folded).toBe(true);
    expect(reopened.buildSessionProjection().messages.find((message) => message.role === "toolResult" && message.toolCallId === "a"))
      .toMatchObject({ content: [{ type: "text", text: FOLDED_CONTEXT_OUTPUT }] });
  });

  it("orders scope reset/fold/delete and consolidates each source once", async () => {
    const h = await fixture();
    const snapshot = h.context.snapshot();
    const segment = snapshot.segments.find((segment) => segment.type === "assistant")!;
    const call = snapshot.items.find((item) => item.type === "tool-call")!;
    const request = h.edit(snapshot, [
      { target: "segment", id: segment.id, action: "delete" },
      { target: "segment", id: segment.id, action: "fold" },
      { target: "item", id: call.id, action: "delete" },
      { target: "item", id: call.id, action: "reset" },
    ]);
    const prediction = h.context.preview(request);
    expect(prediction.changes).toEqual([{ itemId: snapshot.items.find((item) => item.id.startsWith(h.resultB))!.id, action: "fold" }]);
    const foldedAfterDelete = h.context.preview(h.edit(snapshot, [
      { target: "item", id: call.id, action: "delete" },
      { target: "item", id: call.relatedIds[0]!, action: "fold" },
    ]));
    expect(foldedAfterDelete.changes).toEqual([{ itemId: call.relatedIds[0]!, action: "fold" }]);
    const after = h.context.apply(h.edit(snapshot, [{ target: "segment", id: segment.id, action: "delete" }]));
    expect(after.items.every((item) => item.type === "system" || item.type === "user")).toBe(true);
    const edits = h.manager.getEntries().filter((entry) => entry.type === "context_edit");
    expect(new Set(edits.map((entry) => entry.targetId)).size).toBe(edits.length);
    expect(h.manager.getEntry(h.user)).toBeDefined();
  });

  it("uses only the canonical retained projection, excluding bookkeeping, retry controls and failed attempts", async () => {
    const h = await fixture();
    h.manager.appendCompaction("OLD SUMMARY", h.user, 50);
    const retained = h.manager.appendMessage({ role: "user", content: "Retained user", timestamp: 9 });
    h.manager.appendMessage(h.ai.fauxAssistantMessage("Retained answer"));
    h.manager.appendCompaction("CURRENT SUMMARY", retained, 40);
    h.manager.appendCustomEntry("title-usage", { text: "BOOKKEEPING" });
    h.manager.appendCustomMessageEntry("easyresearch:llm-retry", "RETRY WAKE", false);
    h.manager.appendMessage(h.ai.fauxAssistantMessage("FAILED ATTEMPT", { stopReason: "error" }));
    h.manager.appendMessage(h.ai.fauxAssistantMessage("ABORTED ATTEMPT", { stopReason: "aborted" }));
    const snapshot = h.context.snapshot();
    const text = snapshot.items.map((item) => h.context.item(snapshot.revision, item.id, "current").text).join("\n");
    expect(text).toContain("CURRENT SUMMARY");
    for (const excluded of ["OLD SUMMARY", "RAW_A_", "BOOKKEEPING", "RETRY WAKE", "FAILED ATTEMPT", "ABORTED ATTEMPT", "Keep assistant prose"]) expect(text).not.toContain(excluded);
    expect(snapshot.items.filter((item) => item.type === "summary")).toHaveLength(1);
    expect(snapshot.items.filter((item) => item.type === "system")).toHaveLength(1);
  });

  it("splits assistant intervals on human messages, preserving immutable user/system boundaries", async () => {
    const h = await fixture();
    h.manager.appendMessage({ role: "system", content: "A native declaration update", timestamp: 10 });
    const notification = h.manager.appendCustomMessageEntry("fixture-model-notification", "Model-visible notification", false);
    h.manager.appendMessage(h.ai.fauxAssistantMessage("Same interval"));
    const nextUser = h.manager.appendMessage({ role: "user", content: "Next boundary", timestamp: 11 });
    const nextAnswer = h.manager.appendMessage(h.ai.fauxAssistantMessage("Next interval"));
    const before = h.context.snapshot();
    const assistants = before.segments.filter((segment) => segment.type === "assistant");
    expect(assistants).toHaveLength(2);
    const same = before.items.find((item) => item.preview === "Same interval")!;
    expect(same.segmentId).toBe(assistants[0]!.id);
    const after = h.context.apply(h.edit(before, [{ target: "segment", id: assistants[0]!.id, action: "delete" }]));
    expect(after.items.some((item) => item.id.startsWith(nextUser))).toBe(true);
    expect(after.items.some((item) => item.id.startsWith(nextAnswer))).toBe(true);
    expect(after.items.some((item) => item.type === "system" && item.preview.includes("A native declaration update"))).toBe(true);
    expect(after.items.some((item) => item.id.startsWith(notification) && !item.canDelete)).toBe(true);
  });

  it("rejects oversized metadata recoverably instead of omitting entries", async () => {
    const h = await fixture();
    h.manager.appendMessage(h.ai.fauxAssistantMessage(Array.from({ length: 24_000 }, (_value, index) => ({ type: "text" as const, text: `${index}:` + "X".repeat(240) }))));
    const count = h.manager.getEntries().length;
    expect(() => h.context.snapshot()).toThrow(expect.objectContaining({ code: "CONTEXT_TOO_LARGE", status: 413 }));
    expect(h.manager.getEntries()).toHaveLength(count);
  });

  it("pages complete text without binary payloads and reports consistent native estimates and shares", async () => {
    const h = await fixture();
    const text = "x".repeat(CONTEXT_TEXT_PAGE_CHARS - 1) + "😀" + "正文".repeat(20_000);
    const source = h.manager.appendMessage({ role: "user", content: [{ type: "text", text }, { type: "image", mimeType: "image/png", data: "SECRET_BASE64" }], timestamp: 10 });
    const snapshot = h.context.snapshot();
    const item = snapshot.items.find((item) => item.id.startsWith(source))!;
    let offset: number | null = 0;
    let combined = "";
    while (offset !== null) {
      const page = h.context.item(snapshot.revision, item.id, "current", offset);
      expect(page.text.length).toBeLessThanOrEqual(CONTEXT_TEXT_PAGE_CHARS);
      expect(page.offset).toBe(offset);
      combined += page.text;
      offset = page.nextOffset;
    }
    expect(combined).toBe(`${text}\n\n[binary or non-text content omitted]`);
    expect(combined).not.toContain("SECRET_BASE64");
    expect(snapshot.items.every((item) => Array.from(item.preview).length <= 240)).toBe(true);
    for (const segment of snapshot.segments) {
      const members = snapshot.items.filter((item) => segment.itemIds.includes(item.id));
      expect(segment.tokens).toBe(members.reduce((sum, item) => sum + item.tokens, 0));
      expect(segment.percent).toBe(segment.tokens / snapshot.totalTokens * 100);
      for (const member of members) expect(member.segmentPercent).toBe(member.tokens / segment.tokens * 100);
    }
  });

  it("rejects stale, busy, immutable, unknown and ambiguous targets without writing", async () => {
    const h = await fixture();
    const snapshot = h.context.snapshot();
    const result = snapshot.items.find((item) => item.type === "tool-result")!;
    const request = h.edit(snapshot, [{ target: "item", id: result.id, action: "fold" }]);
    const count = h.manager.getEntries().length;
    h.setBusy(true);
    expect(() => h.context.apply(request)).toThrow(expect.objectContaining({ code: "CONTEXT_BUSY" }));
    h.setBusy(false);
    for (const target of [snapshot.items.find((item) => item.type === "user")!.id, "missing"]) {
      expect(() => h.context.apply(h.edit(snapshot, [{ target: "item", id: target, action: "delete" }]))).toThrow(expect.objectContaining({ code: "CONTEXT_INVALID" }));
    }
    expect(h.manager.getEntries()).toHaveLength(count);
    Object.assign(h.runtime, { systemPrompt: "Changed prompt" });
    expect(() => h.context.preview(request)).toThrow(expect.objectContaining({ code: "CONTEXT_STALE" }));
    expect(() => h.context.item(snapshot.revision, result.id, "current")).toThrow(expect.objectContaining({ code: "CONTEXT_STALE" }));
    expect(() => h.context.apply(request)).toThrow(expect.objectContaining({ code: "CONTEXT_STALE" }));
    h.manager.appendMessage({ role: "toolResult", toolCallId: "a", toolName: "read", content: [], isError: false, timestamp: 20 });
    const ambiguous = h.context.snapshot();
    expect(ambiguous.items.find((item) => item.id === result.id)?.canDelete).toBe(false);
    expect(() => h.context.apply(h.edit(ambiguous, [{ target: "item", id: result.id, action: "delete" }]))).toThrow(expect.objectContaining({ code: "CONTEXT_INVALID" }));
  });

  it("invalidates revisions and refreshes actual context on a partial native append failure", async () => {
    const h = await fixture();
    const snapshot = h.context.snapshot();
    const result = snapshot.items.find((item) => item.type === "tool-result")!;
    const original = h.manager.appendContextEdit.bind(h.manager);
    let count = 0;
    vi.spyOn(h.manager, "appendContextEdit").mockImplementation((...args) => {
      if (++count === 2) throw new Error("private IO path");
      return original(...args);
    });
    expect(() => h.context.apply(h.edit(snapshot, [{ target: "item", id: result.id, action: "delete" }]))).toThrow(expect.objectContaining({ code: "CONTEXT_UNAVAILABLE" }));
    expect(h.runtime.refreshContext).toHaveBeenCalledOnce();
    expect(h.context.snapshot().revision).not.toBe(snapshot.revision);
    expect(h.manager.getEntries().filter((entry) => entry.type === "context_edit")).toHaveLength(1);
  });

  it("compares a native pre-response baseline and returns unavailable after a summary or model/prompt change", async () => {
    const h = await fixture();
    const before = h.context.snapshot();
    const result = before.items.find((item) => item.id.startsWith(h.resultA))!;
    const plain = h.context.preview(h.edit(before, []));
    const folded = h.context.preview(h.edit(before, [{ target: "item", id: result.id, action: "fold" }]));
    expect(plain.cache.hitRate).not.toBeNull();
    expect(folded.cache.reusableTokens!).toBeLessThan(plain.cache.reusableTokens!);
    expect(folded.cache.hitRate).toBeGreaterThanOrEqual(0);
    expect(folded.cache.hitRate).toBeLessThanOrEqual(1);
    h.manager.appendCompaction("Summary", null, before.totalTokens);
    const compacted = h.context.snapshot();
    expect(h.context.preview(h.edit(compacted, [])).cache.hitRate).toBeNull();
  });

  it("reconstructs a prior input containing native context edits rather than resurrecting its raw sources", async () => {
    const h = await fixture();
    const first = h.context.snapshot();
    h.context.apply(h.edit(first, [{ target: "item", id: first.items.find((item) => item.id.startsWith(h.resultA))!.id, action: "fold" }]));
    h.manager.appendMessage({ role: "user", content: "Next question", timestamp: 30 });
    const input = h.context.snapshot();
    h.manager.appendMessage({ ...h.ai.fauxAssistantMessage("New response"), provider: h.runtime.model!.provider, model: h.runtime.model!.id });
    const current = h.context.snapshot();
    expect(h.context.preview(h.edit(current, [])).cache.reusableTokens).toBe(input.totalTokens);
    Object.assign(h.runtime, { model: { ...h.runtime.model, id: "other-model" } });
    const changed = h.context.snapshot();
    expect(h.context.preview(h.edit(changed, [])).cache.hitRate).toBeNull();
    expect(() => h.context.apply(h.edit(current, []))).toThrow(expect.objectContaining({ code: "CONTEXT_STALE" }));
  });

  it("validates strict ordered request shapes", () => {
    expect(() => parseContextEditRequest({ revision: "a", edits: [], extra: true })).toThrow();
    expect(() => parseContextEditRequest({ revision: "a", edits: [{ target: "item", id: "x", action: "replace" }] })).toThrow();
    expect(parseContextEditRequest({ revision: "a", edits: [] })).toEqual({ revision: "a", edits: [] });
  });

  it("native compaction consumes edits and never reintroduces omitted or folded content", async () => {
    const h = await fixture();
    let captured: AgentMessage[] = [];
    const loader = new h.pi.DefaultResourceLoader({ cwd: join(root, "project"), agentDir: join(root, "agent"),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
      extensionFactories: [(api) => { api.on("session_before_compact", (event) => {
        captured = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
        return { compaction: { summary: "Edited context summary", firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore } };
      }); }],
    });
    await loader.reload();
    const modelRuntime = await h.pi.ModelRuntime.create({ credentials: new h.ai.InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
    modelRuntime.registerNativeProvider(h.provider.provider);
    const { session } = await h.pi.createAgentSession({ cwd: join(root, "project"), agentDir: join(root, "agent"),
      sessionManager: h.manager, resourceLoader: loader, modelRuntime, model: h.provider.getModel(), noTools: "all",
      settingsManager: h.pi.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 5 }, retry: { enabled: false } }) });
    await session.bindExtensions({});
    try {
      const context = new RootContextManager(session, h.pi, () => !session.isIdle, () => {}, undefined, h.ai);
      const before = context.snapshot();
      context.apply(h.edit(before, [
        { target: "item", id: before.items.find((item) => item.id.startsWith(h.resultA))!.id, action: "delete" },
        { target: "item", id: before.items.find((item) => item.id.startsWith(h.resultB))!.id, action: "fold" },
      ]));
      h.manager.appendMessage({ role: "user", content: "Keep newest question", timestamp: 30 });
      h.manager.appendMessage(h.ai.fauxAssistantMessage("Newest answer"));
      session.refreshContext();
      await session.compact();
      expect(JSON.stringify(captured)).toContain(FOLDED_CONTEXT_OUTPUT);
      expect(JSON.stringify(captured)).not.toContain("RAW_A_");
      expect(JSON.stringify(captured)).not.toContain("RAW_B_");
      const reopened = h.pi.SessionManager.open(h.manager.getSessionFile()!, join(root, "sessions"));
      const final = JSON.stringify(reopened.buildSessionProjection().messages);
      expect(final).toContain("Edited context summary");
      expect(final).not.toContain("RAW_A_");
      expect(final).not.toContain("RAW_B_");
    } finally { session.dispose(); }
  });
});
