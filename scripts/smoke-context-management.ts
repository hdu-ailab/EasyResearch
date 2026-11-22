import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextEditDto, ContextItemTextDto, ContextPreviewDto, ContextSnapshotDto } from "../src/web/context-contracts";
import type { SessionSnapshotDto } from "../src/web/contracts";
import { smokeAgentText, type SmokeAgentRequest } from "./smoke-agent-scenario";
import { requestSmokeJsonBeforeDeadline } from "./smoke-release-support";

/** Deterministic provider fixture; all inspection/editing runs in the candidate daemon. */
export function createContextManagementSmoke(runId: string) {
  const marker = `CONTEXT_ACCEPTANCE_${runId}`;
  const foldMarker = `ORIGINAL_FOLD_${runId}`;
  const deleteMarker = `ORIGINAL_DELETE_${runId}`;
  const foldText = `${foldMarker}\n${"Bounded context evidence 中文. ".repeat(1000)}\nFOLD_FILE_END`;
  const deleteText = `${deleteMarker}\nSibling output to delete.`;
  const calls = { fold: "context_fold_read", delete: "context_delete_read" };
  const requests: SmokeAgentRequest[] = [];
  let issued = false;
  let gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const matches = (request: SmokeAgentRequest) => request.messages?.some(message => smokeAgentText(message.content).includes(marker));
  return {
    marker, foldMarker, deleteMarker, foldText, deleteText, calls, requests, matches,
    hold() { assert(!gate); gate = Promise.withResolvers<void>(); },
    release() { gate?.resolve(); gate = undefined; },
    async respond(request: SmokeAgentRequest) {
      requests.push(structuredClone(request));
      const held = gate;
      if (held) await held.promise;
      const summary = request.messages?.some(message => smokeAgentText(message.content).includes(`${marker}:compact`));
      const delta = !issued && !summary ? {
        role: "assistant", content: "Keep this sibling assistant text.",
        tool_calls: ["fold", "delete"].map((name, index) => ({ index, id: calls[name as keyof typeof calls], type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: `${name}.txt` }) } })),
      } : { role: "assistant", content: summary ? `${marker}:summary` : `${marker}:answer` };
      const reason = !issued && !summary ? "tool_calls" : "stop";
      issued = true;
      return new Response(`data: ${JSON.stringify({ id: "context-fixture", object: "chat.completion.chunk", created: 1,
        choices: [{ index: 0, delta, finish_reason: reason }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } });
    },
  };
}

export async function runContextManagementSmoke(options: {
  base: string; root: string; deadline: number; fixture: ReturnType<typeof createContextManagementSmoke>;
}) {
  const { base, root, deadline, fixture } = options;
  const project = join(root, "context-management-project");
  mkdirSync(join(project, ".easyresearch"), { recursive: true });
  writeFileSync(join(project, ".easyresearch", "settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 24 } }));
  writeFileSync(join(project, "fold.txt"), fixture.foldText);
  writeFileSync(join(project, "delete.txt"), fixture.deleteText);
  const json = <T>(path: string, body?: unknown) => requestSmokeJsonBeforeDeadline({ url: base + path, deadline,
    label: `context ${path}`, init: body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } }) as Promise<T>;
  const created = await json<{ id: string }>("/api/sessions", { cwd: project });
  const path = `/api/sessions/${created.id}`;
  const context = () => json<ContextSnapshotDto>(`${path}/context`);
  const idle = async (minimumRequests: number) => {
    for (;;) {
      assert(Date.now() < deadline, "Context fixture did not settle");
      const snapshot = await json<SessionSnapshotDto>(`${path}/snapshot`);
      if (fixture.requests.length >= minimumRequests && snapshot.session.status === "ready" && snapshot.compactionState === "idle") return snapshot;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  const error = async (suffix: string, body: unknown, code: string) => {
    const response = await fetch(base + path + suffix, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))) });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, code);
  };
  try {
    const commands = await json<{ commands: Array<{ name: string }> }>(`${path}/commands`);
    assert(commands.commands.some(command => command.name === "context"));
    assert(commands.commands.some(command => command.name === "settings"));
    await json(`${path}/messages`, { message: fixture.marker });
    const initialHistory = await idle(2);
    const file = initialHistory.session.sessionFile;
    assert(file);
    const original = readFileSync(file);
    const initial = await context();
    assert(initial.items.some(item => item.type === "system"));
    assert.equal(initial.segments.find(segment => segment.type === "assistant")?.preview, `${fixture.marker}:answer`, "Overview must preview the last assistant reply, not its first tool-calling message");
    assert.equal(initial.items.reduce((sum, item) => sum + item.tokens, 0), initial.totalTokens);
    assert.equal(initial.segments.reduce((sum, segment) => sum + segment.tokens, 0), initial.totalTokens);
    for (const item of initial.items) assert(Math.abs(item.percent - item.tokens / initial.totalTokens * 100) < 0.11);
    assert(!initialHistory.timeline.some(entry => entry.kind === "message" && entry.message.role === "system"));
    const fold = initial.items.find(item => item.type === "tool-result" && item.preview.includes(fixture.foldMarker));
    const remove = initial.items.find(item => item.type === "tool-result" && item.preview.includes(fixture.deleteMarker));
    assert(fold && remove, "Real native read results missing from effective context");
    assert.equal(fold.relatedIds.length, 1);
    assert.equal(remove.relatedIds.length, 1);
    let raw = "";
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      const page: ContextItemTextDto = await json<ContextItemTextDto>(`${path}/context/item?${new URLSearchParams({ revision: initial.revision, itemId: fold.id, view: "original", offset: String(offset) })}`);
      assert.equal(page.offset, offset);
      assert(page.nextOffset === null || page.nextOffset === offset + page.text.length);
      raw += page.text; offset = page.nextOffset; pages++;
      assert(pages < 20);
    }
    assert(pages > 1 && raw.includes("FOLD_FILE_END"), "Raw source must page without losing its tail");
    const edits: ContextEditDto[] = [{ target: "item", id: fold.id, action: "fold" }, { target: "item", id: remove.id, action: "delete" }];
    const body = { revision: initial.revision, edits };
    const preview = await json<ContextPreviewDto>(`${path}/context/preview`, body);
    assert(preview.afterTokens < preview.beforeTokens);
    assert.equal(preview.cache.basis, "unchanged-prefix");
    assert(preview.cache.hitRate === null || preview.cache.hitRate >= 0 && preview.cache.hitRate <= 1);
    assert.deepEqual(new Set(preview.changes.filter(change => change.action === "delete").map(change => change.itemId)), new Set([remove.id, ...remove.relatedIds]));
    const reset = await json<ContextPreviewDto>(`${path}/context/preview`, { revision: initial.revision,
      edits: [...edits, { target: "item", id: fold.id, action: "reset" }, { target: "item", id: remove.id, action: "reset" }] });
    assert.equal(reset.afterTokens, initial.totalTokens);
    assert.deepEqual(reset.changes, []);
    const applied = await json<ContextSnapshotDto>(`${path}/context/apply`, body);
    assert.notEqual(applied.revision, initial.revision);
    assert.equal(applied.totalTokens, preview.afterTokens);
    assert.deepEqual(applied.items.filter(item => item.type === "user").map(item => item.id), initial.items.filter(item => item.type === "user").map(item => item.id));
    assert(applied.items.some(item => item.type === "assistant" && item.preview.includes("Keep this sibling")));
    assert(!applied.items.some(item => item.id === remove.id || remove.relatedIds.includes(item.id)));
    assert(applied.items.some(item => item.type === "tool-result" && item.preview === "已折叠的工具输出"));
    await error("/context/apply", body, "CONTEXT_STALE");
    const afterEdit = readFileSync(file);
    assert.deepEqual(afterEdit.subarray(0, original.length), original, "Context edits rewrote original history bytes");
    assert(afterEdit.subarray(original.length).toString("utf8").includes('"context_edit"'));
    fixture.hold();
    const count = fixture.requests.length;
    // Short final user turn fits the native retained-tail budget as a full turn.
    await json(`${path}/messages`, { message: "Next" });
    while (fixture.requests.length === count) {
      assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 30));
    }
    const actual = JSON.stringify(fixture.requests.at(-1)!.messages);
    assert(actual.includes("已折叠的工具输出") && actual.includes("Keep this sibling assistant text."));
    assert(!actual.includes(fixture.foldMarker) && !actual.includes(fixture.deleteMarker) && !actual.includes(fixture.calls.delete));
    assert(actual.includes(fixture.calls.fold));
    const busy = await context();
    assert(busy.busy);
    const busyItem = busy.items.find(item => item.canDelete);
    assert(busyItem);
    await error("/context/apply", { revision: busy.revision, edits: [{ target: "item", id: busyItem.id, action: "delete" }] }, "CONTEXT_BUSY");
    fixture.release();
    await idle(count + 1);
    await json(`${path}/compact`, { customInstructions: `${fixture.marker}:compact` });
    await idle(count + 2);
    const summaryRequest = JSON.stringify(fixture.requests.at(-1)!.messages);
    assert(summaryRequest.includes("已折叠的工具输出"), "Native compaction did not consume edited context");
    assert(!summaryRequest.includes(fixture.foldMarker) && !summaryRequest.includes(fixture.deleteMarker));
    const compacted = await context();
    assert(compacted.items.some(item => item.type === "summary" && item.preview.includes(`${fixture.marker}:summary`)));
    assert(!JSON.stringify(compacted).includes(fixture.foldMarker) && !JSON.stringify(compacted).includes(fixture.deleteMarker));
    assert.deepEqual(readFileSync(file).subarray(0, original.length), original);
    await json(`${path}/stop`, {});
    await json("/api/sessions/open", { path: file });
    const reopened = await context();
    assert(reopened.items.some(item => item.type === "summary"));
    assert(!JSON.stringify(reopened).includes(fixture.foldMarker));
    return { id: created.id, file, pages, beforeTokens: initial.totalTokens, afterTokens: applied.totalTokens, requests: fixture.requests.length };
  } finally {
    fixture.release();
    await requestSmokeJsonBeforeDeadline({ url: `${base}${path}/stop`, deadline: Date.now() + 15_000,
      label: "context cleanup", init: { method: "POST" } });
  }
}
