import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { LlmRecoveryDto, SessionSnapshotDto } from "../web/contracts";
import { createLlmRetryFixture, llmRetryFixtureResponse, RetryFixtureLane } from "../../scripts/smoke-llm-retry-fixture";
import { assertCounterOnce, captureRetryEvidence, retryStateInFrame } from "../../scripts/smoke-llm-retry";
import type { SmokeAgentRequest } from "../../scripts/smoke-agent-scenario";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory() { const root = mkdtempSync(join(tmpdir(), "llm-retry-harness-")); roots.push(root); return root; }

function completedContext(lane: RetryFixtureLane): SmokeAgentRequest {
  return { tools: [{ function: { name: "bash" } }], messages: [
    { role: "user", content: "original task" },
    { role: "assistant", content: "completed call" },
    { role: "tool", tool_call_id: lane.callId, content: lane.marker },
  ] };
}

describe("LLM retry acceptance provider", () => {
  it("requires a completed tool result on every automatic/manual request and owns a held response", async () => {
    const lane = new RetryFixtureLane("root", "done", "counter", { name: "bash", command: "append-counter" }, 5);
    const request = completedContext(lane);
    expect(await lane.select({ tools: request.tools, messages: request.messages!.slice(0, 1) })).toMatchObject({ kind: "tool", id: lane.callId });
    const first = await lane.select(request);
    expect(first.kind).toBe("failure");
    expect((await lane.select(request)).kind).toBe("failure");
    const gate = lane.holdNext();
    let settled = false;
    const pending = lane.select(request).then(value => { settled = true; return value; });
    await Promise.resolve();
    expect(gate.hit).toBe(true);
    expect(settled).toBe(false);
    lane.release();
    expect((await pending).kind).toBe("failure");
    expect((await lane.select(request)).kind).toBe("failure");
    expect((await lane.select(request)).kind).toBe("failure");
    expect(await lane.select(request)).toEqual({ kind: "text", text: "done" });
    expect(lane.requests).toHaveLength(7);
    await expect(lane.select(request)).rejects.toThrow("after completion");
  });

  it.each(["missing", "duplicate", "new-user", "failed-assistant", "control"])("rejects %s evidence instead of silently issuing success", async kind => {
    const lane = new RetryFixtureLane("leaf", "done", "counter", { name: "bash", command: "append-counter" }, 5);
    const original = completedContext(lane);
    await lane.select({ tools: original.tools, messages: original.messages!.slice(0, 1) });
    await lane.select(original);
    const bad = structuredClone(original);
    if (kind === "missing") bad.messages!.pop();
    if (kind === "duplicate") bad.messages!.push(bad.messages!.at(-1)!);
    if (kind === "new-user") bad.messages!.push({ role: "user", content: "Retry please" });
    if (kind === "failed-assistant") bad.messages!.push({ role: "assistant", content: "Failed partial response" });
    if (kind === "control") bad.messages!.push({ role: "assistant", content: "easyresearch:llm-retry" });
    await expect(lane.select(bad)).rejects.toThrow();
    expect(lane.failures).toBe(1);
  });

  it("emits real HTTP failures and protocol-correct streamed text/tool responses", async () => {
    const failure = llmRetryFixtureResponse({ kind: "failure", message: "503 service unavailable" });
    expect(failure.status).toBe(503);
    expect(await failure.json()).toMatchObject({ error: { message: "503 service unavailable" } });
    const tool = llmRetryFixtureResponse({ kind: "tool", id: "append", name: "bash", arguments: '{"command":"append"}' });
    const body = await tool.text();
    expect(body).toContain('"tool_calls"');
    expect(body).toContain('"id":"append"');
    expect(body).toContain("data: [DONE]");
  });

  it("routes the latest native user turn and explicit summary instructions ahead of quoted older tasks", () => {
    const fixture = createLlmRetryFixture({ runId: "test", directory: directory() });
    const history = fixture.addText("summary_history", "history");
    const tail = fixture.addText("summary_tail", "tail");
    const summary = fixture.addSummary("summary");
    expect(fixture.laneFor({ messages: [{ role: "user", content: fixture.prompt("summary_history") }] })).toBe(history);
    expect(fixture.laneFor({ messages: [{ role: "user", content: fixture.prompt("summary_history") },
      { role: "user", content: fixture.prompt("summary_tail") }] })).toBe(tail);
    expect(fixture.laneFor({ messages: [{ role: "user", content: `<conversation>\n${fixture.prompt("summary_history")}\n</conversation>\nAdditional focus: ${fixture.prompt("summary")}` }] })).toBe(summary);
  });

  it.skipIf(process.platform === "win32")("executes the browser counter as a real non-idempotent shell append", async () => {
    const fixture = createLlmRetryFixture({ runId: "test", directory: directory(), platform: "linux" });
    const item = fixture.addCase("counter", 0);
    const response = await fixture.respond({ tools: [{ function: { name: "bash" } }], messages: [{ role: "user", content: item.prompt }] });
    const firstLine = (await response.text()).split("\n")[0]!;
    const chunk = JSON.parse(firstLine.slice("data: ".length));
    const command = JSON.parse(chunk.choices[0].delta.tool_calls[0].function.arguments).command;
    const run = () => spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", command], { encoding: "utf8", env: { PATH: "" } });
    expect(run().status).toBe(0);
    expect(() => assertCounterOnce(item)).not.toThrow();
    expect(run().status).toBe(0);
    expect(() => assertCounterOnce(item)).toThrow(/replayed/);
  });
});

describe("LLM retry acceptance wire and native evidence", () => {
  it("requires full replacements and observes nested supervisor delivery", () => {
    const state = { type: "llm_retry_state", targetSessionId: "leaf", automaticRetry: {
      source: "agent", attempt: 1, maxAttempts: 10, delayMs: 5000, remainingMs: 4123, errorMessage: "503",
    }, llmRecovery: null };
    expect(retryStateInFrame({ type: "subagent_supervisor", ownerSessionId: "owner", event: state })).toEqual(state);
    expect(retryStateInFrame({ ...state, automaticRetry: null })).toMatchObject({ automaticRetry: null, llmRecovery: null });
    const { llmRecovery: _, ...partial } = state;
    expect(() => retryStateInFrame(partial)).toThrow(/replace both/);
    expect(() => retryStateInFrame({ ...state, automaticRetry: { ...state.automaticRetry, remainingMs: 5001 } })).toThrow();
    expect(() => retryStateInFrame({ ...state, llmRecovery: { targetSessionId: "other", failureId: "f", failedEntryId: "e", status: "available" } })).toThrow();
  });

  function evidenceFixture() {
    const root = directory();
    const fixture = createLlmRetryFixture({ runId: "audit", directory: join(root, "counter") });
    const item = fixture.addCase("direct", 1);
    writeFileSync(item.counter, item.leaf.marker + "\n");
    const rootPath = join(root, "root.jsonl");
    const childPath = join(root, "child.jsonl");
    const rows: any[] = [{ type: "session", id: "root" }, { type: "message", id: "root-user", message: { role: "user" } }];
    const record = (data: unknown) => ({ type: "custom", customType: "easyresearch:subagent_job", data });
    rows.push(...[
      { kind: "reserved", launchId: "launch", ownerSessionId: "root", toolCallId: "tool", agent: fixture.leafAgent, agentId: "leaf_0", continuation: false, createdAt: "now" },
      { kind: "created", launchId: "launch", childSessionId: "leaf", sessionPath: childPath },
      { kind: "materialized", launchId: "launch" },
      { kind: "launch_acknowledged", launchId: "launch", acknowledgedAt: "now" },
    ].map(record));
    const write = () => writeFileSync(rootPath, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    write();
    writeFileSync(childPath, [{ type: "session", id: "leaf" }, { type: "message", id: "leaf-user", message: { role: "user" } },
      { type: "message", id: "failed", message: { role: "assistant", stopReason: "error" } }].map(row => JSON.stringify(row)).join("\n") + "\n");
    const recovery: LlmRecoveryDto = { targetSessionId: "leaf", failureId: "failure", failedEntryId: "failed", status: "available" };
    const snapshot: SessionSnapshotDto = { session: { id: "root", cwd: root, sessionFile: rootPath, status: "running", isStreaming: false },
      subagents: [{ ownerSessionId: "root", childSessionId: "leaf", toolCallId: "tool", launchId: "launch", agentId: "leaf_0",
        agent: fixture.leafAgent, status: "working", llmRecovery: recovery }], timeline: [], runtimeConfigurationGeneration: 0,
      compactionPolicy: { enabled: false, triggerPercent: 70 } };
    return { root, item, snapshot, recovery, rows, write, record, rootPath, childPath };
  }

  it("accepts one original-owner terminal/handoff and rejects a replacement launch, premature outcome and duplicated handoff", () => {
    const f = evidenceFixture();
    const audit = captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
    expect(audit.check(f.snapshot).toolExecutions).toBe(1);
    const replaced = structuredClone(f.snapshot);
    replaced.subagents[0]!.launchId = "different";
    expect(() => audit.check(replaced)).toThrow(/replaced/);
    f.rows.push(f.record({ kind: "terminal", launchId: "launch", status: "complete", finishedAt: "now" }));
    f.write();
    expect(() => audit.check(f.snapshot)).toThrow(/Premature/);
    const handoff = { type: "custom_message", customType: "easyresearch:agent_status", display: false,
      details: { outcomes: [{ launchId: "launch", status: "complete" }] } };
    f.rows.push(handoff); f.write();
    expect(audit.check(f.snapshot, "complete").terminalOutcomes).toBe(1);
    f.rows.push(handoff); f.write();
    expect(() => audit.check(f.snapshot, "complete")).toThrow(/duplicate.*handoff/);
  });

  it("rejects new native user rows and refuses to audit histories outside the private root", () => {
    const f = evidenceFixture();
    const audit = captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
    appendFileSync(f.childPath, JSON.stringify({ type: "message", message: { role: "user", content: "retry" } }) + "\n");
    expect(() => audit.check(f.snapshot)).toThrow(/another native user/);
    const other = directory();
    mkdirSync(join(other, "child"));
    expect(() => captureRetryEvidence(f.snapshot, f.recovery, f.item, join(other, "child"))).toThrow(/private fixture/);
  });
});
