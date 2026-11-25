import * as fs from "node:fs";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmRecoveryDto, SessionSnapshotDto } from "../web/contracts";
import { createLlmRetryFixture, llmRetryFixtureResponse, RetryFixtureLane } from "../../scripts/smoke-llm-retry-fixture";
import { assertCounterOnce, captureRetryEvidence, preserveRetryFailureEvidence, retryStateInFrame } from "../../scripts/smoke-llm-retry";
import { SmokeAgentLane, type SmokeAgentRequest } from "../../scripts/smoke-agent-scenario";

const roots: string[] = [];
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory() { const root = mkdtempSync(join(tmpdir(), "llm-retry-harness-")); roots.push(root); return root; }

function completedContext(lane: RetryFixtureLane): SmokeAgentRequest {
  return { tools: [{ function: { name: "bash" } }], messages: [
    { role: "user", content: "original task" },
    { role: "assistant", content: "completed call" },
    { role: "tool", tool_call_id: lane.callId, content: lane.marker },
  ] };
}

describe("LLM retry acceptance provider", () => {
  it("waits through only scripted error periods and accepts a later success without redispatching the child", async () => {
    const fixture = createLlmRetryFixture({ runId: "periods", directory: directory(), platform: "linux" });
    const item = fixture.addCase("direct", 1);
    const parent = item.dispatcher!;
    const tools = [{ function: { name: "subagent" } }];
    const launch = parent.select({ tools, messages: [{ role: "user", content: item.prompt }] });
    if (launch.kind !== "tool") throw new Error("Missing child launch");
    const childContext: SmokeAgentRequest = { tools: [{ function: { name: "shell" } }], messages: [
      { role: "user", content: "original child task" },
      { role: "tool", tool_call_id: item.leaf.callId, content: item.leaf.marker },
    ] };
    await item.leaf.select({ tools: childContext.tools, messages: childContext.messages!.slice(0, 1) });
    const sessionID = "62dcdf07-3e6c-4a0a-a2af-b7594efad8ca";
    const messages: NonNullable<SmokeAgentRequest["messages"]> = [{ role: "user", content: item.prompt },
      { role: "tool", tool_call_id: launch.id, content: "admitted", details: { sessionID } }];
    const report = (state: string, text: string) => ({ role: "user", content: `<background-result kind="subagent" sessionID="${sessionID}" state="${state}">\n${text}\n</background-result>` });
    for (const period of [1, 2]) {
      await item.leaf.select(childContext);
      const failed = await item.leaf.select(childContext);
      if (failed.kind !== "failure") throw new Error("Missing controlled failure");
      messages.push(report("error", failed.message));
      expect(parent.select({ tools, messages }).kind).toBe("text");
      expect(parent.complete).toBe(false);
      expect(parent.calls).toHaveLength(1);
      expect(item.leaf.failures).toBe(period * 2);
    }
    expect(() => parent.select({ tools, messages: [...messages,
      report("error", "503 service unavailable: controlled LLM retry direct_leaf failure 200"),
    ] })).toThrow(/Unexpected Retry/);
    await item.leaf.select(childContext);
    const recovered = await item.leaf.select(childContext);
    expect(recovered).toEqual({ kind: "text", text: item.leaf.final });
    messages.push(report("completed", item.leaf.final));
    expect(parent.select({ tools, messages })).toEqual({ kind: "text", text: item.final });
    expect(parent.calls).toHaveLength(1);
    expect(parent.dispatches).toEqual([{ callId: launch.id, sessionID, terminal: item.leaf.final }]);
    expect(item.leaf.requests).toHaveLength(7);
  });

  it("keeps ordinary dispatch strict and does not accept unrelated failures in Retry dispatch", () => {
    const fixture = createLlmRetryFixture({ runId: "strict", directory: directory() });
    const retry = fixture.addCase("direct", 1).dispatcher!;
    const ordinary = new SmokeAgentLane("ordinary", [{ name: "subagent", args: () => ({}), terminal: () => "done" }], () => "done");
    for (const lane of [ordinary, retry]) {
      const tools = [{ function: { name: "subagent" } }];
      const call = lane.select({ tools });
      if (call.kind !== "tool") throw new Error("Missing dispatch");
      const sessionID = "62dcdf07-3e6c-4a0a-a2af-b7594efad8ca";
      expect(() => lane.select({ tools, messages: [
        { role: "tool", tool_call_id: call.id, content: "admitted", details: { sessionID } },
        { role: "user", content: `<background-result kind="subagent" sessionID="${sessionID}" state="error">\npermission denied\n</background-result>` },
      ] })).toThrow(/failed|unexpected/i);
    }
  });

  it("allows explicitly requested cancellation after a verified Retry error period", async () => {
    const fixture = createLlmRetryFixture({ runId: "cancel-period", directory: directory(), platform: "linux" });
    const item = fixture.addCase("direct", 1);
    const parent = item.dispatcher!;
    const tools = [{ function: { name: "subagent" } }];
    const launch = parent.select({ tools });
    if (launch.kind !== "tool") throw new Error("Missing dispatch");
    const child: SmokeAgentRequest = { tools: [{ function: { name: "shell" } }], messages: [
      { role: "user", content: "original task" }, { role: "tool", tool_call_id: item.leaf.callId, content: item.leaf.marker },
    ] };
    await item.leaf.select({ tools: child.tools, messages: child.messages!.slice(0, 1) });
    const failure = await item.leaf.select(child);
    if (failure.kind !== "failure") throw new Error("Missing fixture failure");
    const sessionID = "62dcdf07-3e6c-4a0a-a2af-b7594efad8ca";
    parent.expectCancellation();
    const result = parent.select({ tools, messages: [
      { role: "tool", tool_call_id: launch.id, content: "admitted", details: { sessionID } },
      { role: "user", content: `<background-result kind="subagent" sessionID="${sessionID}" state="error">\n${failure.message}\n</background-result>` },
      { role: "user", content: `<background-result kind="subagent" sessionID="${sessionID}" state="cancelled">\nCancelled\n</background-result>` },
    ] });
    expect(result).toEqual({ kind: "text", text: "Acceptance task cancellation observed." });
    expect(parent.dispatches).toEqual([]);
  });
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
    const tool = llmRetryFixtureResponse({ kind: "tool", id: "append", name: "shell", arguments: '{"command":"append"}' });
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
    const response = await fixture.respond({ tools: [{ function: { name: "shell" } }], messages: [{ role: "user", content: item.prompt }] });
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

  function evidenceFixture(depth: 1 | 2 = 1) {
    const root = directory();
    const fixture = createLlmRetryFixture({ runId: "audit", directory: join(root, "counter") });
    const item = fixture.addCase(depth === 2 ? "nested" : "direct", depth);
    writeFileSync(item.counter, item.leaf.marker + "\n");
    const rootPath = join(root, "root.jsonl");
    const childPath = join(root, "child.jsonl");
    const ownerPath = join(root, "owner.jsonl");
    const rows: any[] = [{ type: "session", id: "root" }, { type: "message", id: "root-user", message: { role: "user" } }];
    const record = <T>(data: T) => ({ type: "custom", customType: "easyresearch:subagent_job", data });
    if (depth === 2) {
      rows.push(...[
        { kind: "reserved", launchId: "owner-launch", ownerSessionId: "root", toolCallId: "owner-tool", agent: fixture.ownerAgent, agentId: "owner_0", continuation: false, createdAt: "now" },
        { kind: "created", launchId: "owner-launch", childSessionId: "owner", sessionPath: ownerPath },
        { kind: "materialized", launchId: "owner-launch" },
        { kind: "launch_acknowledged", launchId: "owner-launch", acknowledgedAt: "now" },
      ].map(record));
      writeFileSync(ownerPath, [{ type: "session", id: "owner" }, { type: "message", message: { role: "user" } }].map(row => JSON.stringify(row)).join("\n") + "\n");
    }
    rows.push(...[
      { kind: "reserved", launchId: "launch", ownerSessionId: depth === 2 ? "owner" : "root", toolCallId: "tool", agent: fixture.leafAgent, agentId: "leaf_0", continuation: false, createdAt: "now" },
      { kind: "created", launchId: "launch", childSessionId: "leaf", sessionPath: childPath },
      { kind: "materialized", launchId: "launch" },
      { kind: "launch_acknowledged", launchId: "launch", acknowledgedAt: "now" },
    ].map(record));
    const write = () => writeFileSync(rootPath, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    write();
    writeFileSync(childPath, [{ type: "session", id: "leaf" }, { type: "message", id: "leaf-user", message: { role: "user" } },
      { type: "message", id: "failed", message: { role: "assistant", stopReason: "error", errorMessage: `503 service unavailable: controlled LLM retry ${item.leaf.name} failure 2` } }].map(row => JSON.stringify(row)).join("\n") + "\n");
    const recovery: LlmRecoveryDto = { targetSessionId: "leaf", failureId: "failure", failedEntryId: "failed", status: "available" };
    const snapshot: SessionSnapshotDto = { session: { id: "root", cwd: root, sessionFile: rootPath, status: "running", isStreaming: false },
      subagents: [{ ownerSessionId: depth === 2 ? "owner" : "root", childSessionId: "leaf", toolCallId: "tool", launchId: "launch", agentId: "leaf_0",
        agent: fixture.leafAgent, status: "working", llmRecovery: recovery }], timeline: [], runtimeConfigurationGeneration: 0,
      compactionPolicy: { enabled: false, triggerPercent: 70 } };
    if (depth === 2) snapshot.subagents.unshift({ ownerSessionId: "root", childSessionId: "owner", toolCallId: "owner-tool",
      launchId: "owner-launch", agentId: "owner_0", agent: fixture.ownerAgent, status: "working" });
    return { root, item, snapshot, recovery, rows, write, record, rootPath, childPath, ownerPath };
  }

  function settled(snapshot: SessionSnapshotDto): SessionSnapshotDto {
    const next = structuredClone(snapshot);
    next.llmRecovery = null;
    for (const child of next.subagents) child.llmRecovery = null;
    return next;
  }

  it("preserves bounded delivery metadata outside the cleaned fixture root without copying message or credential contents", () => {
    const f = evidenceFixture();
    f.rows.push(f.record({ kind: "background_report", launchId: "launch", result: { state: "cancelled", text: "PRIVATE_RESULT_SECRET", outstanding: [] },
      batch: { batchId: "cancel-batch", ownerSessionId: "root", launchIds: ["launch"], content: "PRIVATE_RESULT_SECRET", triggerTurn: true, createdAt: "now" },
      apiKey: "PRIVATE_AUTH_SECRET" }));
    f.write();
    const archive = preserveRetryFailureEvidence({ root: f.root, caseName: "native_stop_parked", phase: "cancel-check",
      snapshots: [f.snapshot], parentDirectory: directory() });
    rmSync(f.root, { recursive: true, force: true });
    const serialized = readFileSync(archive, "utf8");
    const evidence = JSON.parse(serialized);
    expect(evidence).toMatchObject({ caseName: "native_stop_parked", phase: "cancel-check" });
    expect(serialized).toContain("cancel-batch");
    expect(serialized).toContain("contentSha256");
    expect(serialized).not.toMatch(/PRIVATE_RESULT_SECRET|PRIVATE_AUTH_SECRET/);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(evidence.histories.some((history: { entries: unknown[] }) => history.entries.length > 0)).toBe(true);
  });

  const admissionPhases = ["reserved", "created", "materialized", "background_admitted", "launch_acknowledged"] as const;

  function laterPeriod(f: ReturnType<typeof evidenceFixture>) {
    const previous = f.snapshot.subagents[0]!;
    return [
      { kind: "reserved", launchId: "later", ownerSessionId: previous.ownerSessionId, toolCallId: `wake:${previous.launchId}`,
        agent: previous.agent, agentId: previous.agentId, continuation: true, createdAt: "later",
        childSessionId: previous.childSessionId, sessionPath: f.item.depth === 2 ? f.ownerPath : f.childPath },
      { kind: "created", launchId: "later", childSessionId: previous.childSessionId, sessionPath: f.item.depth === 2 ? f.ownerPath : f.childPath },
      { kind: "materialized", launchId: "later" },
      { kind: "background_admitted", launchId: "later", admission: { cwd: f.root, callerAgent: "research-assistant", description: "Retry child" } },
      { kind: "launch_acknowledged", launchId: "later", acknowledgedAt: "later" },
    ].map(f.record);
  }

  function advancePeriod(f: ReturnType<typeof evidenceFixture>, through: typeof admissionPhases[number] = "launch_acknowledged") {
    const previous = f.snapshot.subagents[0]!;
    f.rows.push(f.record({ kind: "background_admitted", launchId: previous.launchId, admission: {
      cwd: f.root, callerAgent: "research-assistant", description: "Retry child",
    } }), f.record({ kind: "background_report", launchId: previous.launchId,
      result: { state: "completed", text: "Waiting for owned work", outstanding: [{ id: "shell", kind: "shell", sessionID: "leaf", status: "running" }] },
      batch: { batchId: "first", ownerSessionId: "root", launchIds: [previous.launchId], content: "first report", triggerTurn: true, createdAt: "now" },
    }), { type: "custom_message", customType: "easyresearch:agent_status", display: false,
      details: { outcomes: [{ launchId: previous.launchId, status: "complete" }] } });
    f.rows.push(...laterPeriod(f).slice(0, admissionPhases.indexOf(through) + 1));
    f.write();
    const current = structuredClone(f.snapshot);
    current.subagents.push({ ...current.subagents[0]!, launchId: "later", toolCallId: `wake:${previous.launchId}` });
    return current;
  }

  function delivery(f: ReturnType<typeof evidenceFixture>, recipient: "root" | "nested") {
    const job = f.snapshot.subagents[recipient === "root" ? 0 : 1]!;
    const ownerPath = recipient === "root" ? f.rootPath : f.ownerPath;
    const text = recipient === "root" ? "Waiting for the retained leaf"
      : `503 service unavailable: controlled LLM retry ${f.item.leaf.name} failure 2`;
    const report = { ...f.record({ kind: "background_report", launchId: job.launchId,
      result: { state: recipient === "root" ? "completed" : "error", text,
        outstanding: recipient === "root" ? [{ id: "leaf", kind: "subagent", sessionID: "leaf", status: "running" }] : [] },
      batch: { batchId: `batch-${job.launchId}`, ownerSessionId: job.ownerSessionId, launchIds: [job.launchId],
        content: "owned report", triggerTurn: true, createdAt: "now" },
    }), id: `report-${job.launchId}` };
    const handoff = { type: "custom_message", customType: "easyresearch:agent_status", id: `handoff-${job.launchId}`,
      display: false, content: "owned report", details: { outcomes: [{ launchId: job.launchId }] } };
    f.rows.push(f.record({ kind: "background_admitted", launchId: job.launchId,
      admission: { cwd: f.root, callerAgent: "research-assistant", description: "Retry child" } }));
    f.write();
    const publishReport = () => { f.rows.push(report); f.write(); };
    const publishHandoff = () => {
      if (recipient === "root") { f.rows.push(handoff); f.write(); }
      else appendFileSync(ownerPath, JSON.stringify(handoff) + "\n");
    };
    return { job, ownerPath, report, handoff, publishReport, publishHandoff };
  }

  describe.each(["capture", "check"] as const)("%s with a causal history sample", mode => {
    it.each(["root", "nested"] as const)("accepts report-then-delivery interleaving at the %s recipient", recipient => {
      const f = evidenceFixture(2);
      const d = delivery(f, recipient);
      const prior = mode === "check" ? captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root) : undefined;
      const read = fs.readFileSync;
      let leafRead = false;
      let delivered = false;
      const sampled: string[] = [];
      const publish = () => { delivered = true; d.publishReport(); d.publishHandoff(); };
      const spy = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
        const path = String(args[0]);
        // A nested recipient may already have the handoff when sampled. Its
        // root report must be read afterwards, not from an older outbox prefix.
        if (recipient === "nested" && path === d.ownerPath && !delivered) publish();
        const value = read(...args);
        if ([f.rootPath, f.ownerPath, f.childPath].includes(path)) sampled.push(path);
        if (path === f.childPath) leafRead = true;
        // For capture, the first root read only discovers the known tree. Gate
        // after that discovery; a later root delivery must not enter this cut.
        if (recipient === "root" && path === f.rootPath && !delivered && (mode === "check" || leafRead)) publish();
        return value;
      });
      let audit = prior;
      try {
        if (audit) expect(audit.check(f.snapshot).identities).toHaveLength(2);
        else audit = captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
      } finally { spy.mockRestore(); }
      expect(delivered).toBe(true);
      expect(sampled.filter(path => path === f.ownerPath)).toHaveLength(1);
      expect(sampled.filter(path => path === f.childPath)).toHaveLength(1);
      expect(sampled.at(-1)).toBe(f.rootPath);
      expect(audit!.check(f.snapshot)).toMatchObject({ userRows: 3, toolExecutions: 1 });
    });

    it.each(["root", "nested"] as const)("archives the exact failed %s handoff operands before later appends", recipient => {
      const f = evidenceFixture(2);
      const d = delivery(f, recipient);
      const prior = mode === "check" ? captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root) : undefined;
      Object.assign(d.handoff, { content: "PRIVATE_HANDOFF_BODY", apiKey: "PRIVATE_HANDOFF_KEY" });
      d.publishHandoff(); // Deliberately orphaned, not a valid report/delivery race.
      let failure: unknown;
      try { prior ? prior.check(f.snapshot) : captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/Premature or duplicate original-owner handoff/);
      d.publishReport();
      d.publishHandoff();
      const archive = preserveRetryFailureEvidence({ root: f.root, caseName: f.item.name, phase: mode,
        snapshots: [f.snapshot], error: failure, parentDirectory: directory() });
      const serialized = readFileSync(archive, "utf8");
      const saved = JSON.parse(serialized);
      expect(saved.failureRead).toMatchObject({ phase: mode, sampling: "audit", handoff: {
        launchId: d.job.launchId, ownerSessionId: d.job.ownerSessionId, childSessionId: d.job.childSessionId,
        source: d.ownerPath, outcomeCount: 0, handoffCount: 1,
        outcomeEntryIds: [], handoffEntryIds: [d.handoff.id],
      } });
      expect(saved.failureRead.handoff.handoffs[0]).toMatchObject({ id: d.handoff.id, contentSha256: expect.any(String) });
      const newer = saved.histories.find((history: { source: string }) => history.source === d.ownerPath).entries;
      expect(newer.filter((entry: { id?: string }) => entry.id === d.handoff.id)).toHaveLength(2);
      expect(serialized).not.toMatch(/PRIVATE_HANDOFF_BODY|PRIVATE_HANDOFF_KEY/);
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(4 * 1024 * 1024);
    });
  });

  it("bounds the failed recipient sample while retaining matching handoff identities and full counts", () => {
    const f = evidenceFixture(2);
    const d = delivery(f, "nested");
    const audit = captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
    for (let index = 0; index < 2600; index++) appendFileSync(d.ownerPath, JSON.stringify({
      type: "custom", customType: "probe", id: `noise-${index}`, ownerSessionId: "x".repeat(512),
      content: "PRIVATE_RECIPIENT_BODY", apiKey: "PRIVATE_RECIPIENT_KEY",
    }) + "\n");
    d.publishHandoff();
    let failure: unknown;
    try { audit.check(f.snapshot); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const archive = preserveRetryFailureEvidence({ root: f.root, caseName: f.item.name, phase: "check",
      snapshots: [f.snapshot], error: failure, parentDirectory: directory() });
    const serialized = readFileSync(archive, "utf8");
    const saved = JSON.parse(serialized);
    expect(saved.failureRead).toMatchObject({ truncated: true, handoff: {
      truncated: true, outcomeCount: 0, handoffCount: 1, handoffEntryIds: [d.handoff.id], entryCount: 2603,
    } });
    expect(saved.failureRead.handoff.recipientTail.at(-1).id).toBe(d.handoff.id);
    expect(serialized).not.toMatch(/PRIVATE_RECIPIENT_BODY|PRIVATE_RECIPIENT_KEY/);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("does not label an earlier successful handoff comparison as a failed checkpoint's operands", () => {
    const f = evidenceFixture(2);
    const d = delivery(f, "root");
    d.publishReport(); d.publishHandoff();
    const audit = captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
    const wrong = structuredClone(f.snapshot);
    wrong.subagents[1]!.llmRecovery!.failedEntryId = "absent-error";
    let failure: unknown;
    try { audit.check(wrong); } catch (error) { failure = error; }
    expect((failure as Error).message).toMatch(/persisted failure/);
    const archive = preserveRetryFailureEvidence({ root: f.root, caseName: f.item.name, phase: "check",
      snapshots: [f.snapshot], error: failure, parentDirectory: directory() });
    expect(JSON.parse(readFileSync(archive, "utf8")).failureRead.handoff).toBeUndefined();
  });

  it("retains matching entry IDs independently of oversized recipient metadata", () => {
    const f = evidenceFixture(2);
    const d = delivery(f, "nested");
    const audit = captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
    Object.assign(d.handoff.details, { outcomes: [d.handoff.details.outcomes[0], ...Array.from({ length: 2000 },
      (_, index) => ({ launchId: `unrelated-${index}`, agentId: "x".repeat(512), text: "PRIVATE_LARGE_HANDOFF_BODY" }))],
      apiKey: "PRIVATE_LARGE_HANDOFF_KEY" });
    d.publishHandoff();
    let failure: unknown;
    try { audit.check(f.snapshot); } catch (error) { failure = error; }
    expect((failure as Error).message).toMatch(/Premature or duplicate original-owner handoff/);
    const archive = preserveRetryFailureEvidence({ root: f.root, caseName: f.item.name, phase: "check",
      snapshots: [f.snapshot], error: failure, parentDirectory: directory() });
    const serialized = readFileSync(archive, "utf8");
    expect(JSON.parse(serialized).failureRead.handoff).toMatchObject({
      handoffCount: 1, handoffEntryIds: [d.handoff.id], handoffs: [], truncated: true,
    });
    expect(serialized).not.toMatch(/PRIVATE_LARGE_HANDOFF_BODY|PRIVATE_LARGE_HANDOFF_KEY/);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it.each(["valid", "duplicate-report", "duplicate-handoff", "missing-report", "missing-handoff", "orphan-handoff"] as const)(
    "keeps nested terminal exactly-once acceptance strict: %s", fault => {
      const f = evidenceFixture(2);
      const audit = captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
      for (const job of f.snapshot.subagents) {
        f.rows.push(f.record({ kind: "background_admitted", launchId: job.launchId,
          admission: { cwd: f.root, callerAgent: "research-assistant", description: "Retry child" } }));
        const report = f.record({ kind: "background_report", launchId: job.launchId,
          result: { state: "completed", text: "Recovered", outstanding: [] },
          batch: { batchId: `complete-${job.launchId}`, ownerSessionId: job.ownerSessionId, launchIds: [job.launchId],
            content: "Recovered", triggerTurn: true, createdAt: "now" },
        });
        const handoff = { type: "custom_message", customType: "easyresearch:agent_status", display: false,
          details: { outcomes: [{ launchId: job.launchId, status: "complete" }] } };
        const nested = job.childSessionId === "leaf";
        if (!nested || !["missing-report", "orphan-handoff"].includes(fault)) f.rows.push(report);
        if (nested && fault === "duplicate-report") f.rows.push(report);
        if (!nested) f.rows.push(handoff);
        else if (fault !== "missing-handoff" && fault !== "missing-report") {
          appendFileSync(f.ownerPath, JSON.stringify(handoff) + "\n");
          if (fault === "duplicate-handoff") appendFileSync(f.ownerPath, JSON.stringify(handoff) + "\n");
        }
      }
      f.write();
      if (fault === "valid") expect(audit.check(settled(f.snapshot), "complete"))
        .toMatchObject({ terminalOutcomes: 2, userRows: 3, toolExecutions: 1 });
      else expect(() => audit.check(settled(f.snapshot), "complete")).toThrow(/duplicate|Missing|Premature/);
    },
  );

  it.each(["capture", "check"] as const)("rejects a non-native root header during %s", mode => {
    const f = evidenceFixture(2);
    const audit = mode === "check" ? captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root) : undefined;
    f.rows[0].type = "message"; f.write();
    expect(() => audit ? audit.check(f.snapshot) : captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root))
      .toThrow(/Physical JSONL identity/);
  });

  it.skipIf(process.platform === "win32")("keeps the verified canonical root path instead of following a replaced symlink", () => {
    const f = evidenceFixture();
    const linked = join(f.root, "linked.jsonl");
    symlinkSync(f.rootPath, linked);
    f.snapshot.session.sessionFile = linked;
    const audit = captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
    const replacement = join(f.root, "replacement.jsonl");
    writeFileSync(replacement, readFileSync(f.rootPath));
    rmSync(linked); symlinkSync(replacement, linked);
    expect(() => audit.check(f.snapshot)).toThrow(/Physical JSONL path changed/);
    const outside = join(directory(), "foreign.jsonl");
    writeFileSync(outside, readFileSync(f.rootPath));
    rmSync(linked); symlinkSync(outside, linked);
    expect(() => captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root)).toThrow(/private fixture histories/);
  });

  it.each(["capture", "check"] as const)("does not read a new child's path discovered after the allowed tree in %s", mode => {
    const f = evidenceFixture(2);
    const audit = mode === "check" ? captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root) : undefined;
    const unexpectedPath = join(f.root, "unexpected.jsonl");
    const read = fs.readFileSync;
    let added = false;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      const path = String(args[0]);
      expect(path).not.toBe(unexpectedPath);
      if (path === f.ownerPath && !added) {
        added = true;
        f.rows.push(...[
          { kind: "reserved", launchId: "unexpected", ownerSessionId: "root", toolCallId: "extra-tool",
            agent: f.snapshot.subagents[0]!.agent, agentId: "owner_1", continuation: false, createdAt: "now" },
          { kind: "created", launchId: "unexpected", childSessionId: "extra-child", sessionPath: unexpectedPath },
          { kind: "materialized", launchId: "unexpected" },
          { kind: "launch_acknowledged", launchId: "unexpected", acknowledgedAt: "now" },
        ].map(f.record));
        f.write();
      }
      return read(...args);
    });
    try {
      expect(() => audit ? audit.check(f.snapshot) : captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root))
        .toThrow(/logical child/);
      expect(added).toBe(true);
    } finally { spy.mockRestore(); }
  });

  describe.each(["capture", "check"] as const)("%s during automatic period admission", mode => {
    it.each(admissionPhases)("audits the real %s prefix without changing native identities or inventing acknowledgement", phase => {
      const f = evidenceFixture(2);
      const prior = mode === "check" ? captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root) : undefined;
      const current = advancePeriod(f, phase);
      const bytes = readFileSync(f.rootPath, "utf8");
      const audit = prior ?? captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
      expect(audit.check(f.snapshot)).toMatchObject({ userRows: 3, toolExecutions: 1, terminalOutcomes: 0,
        identities: [{ childSessionId: "leaf", ownerSessionId: "owner" }, { childSessionId: "owner", ownerSessionId: "root" }] });
      expect(readFileSync(f.rootPath, "utf8")).toBe(bytes);
      f.rows.push(...laterPeriod(f).slice(admissionPhases.indexOf(phase) + 1)); f.write();
      expect(audit.check(current).identities).toHaveLength(2);
    });

    it("retains a reserved launch obligation even after the older snapshot is checked again", () => {
      const f = evidenceFixture(2);
      const prior = mode === "check" ? captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root) : undefined;
      advancePeriod(f, "reserved");
      const audit = prior ?? captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
      expect(audit.check(f.snapshot).identities).toHaveLength(2);
      f.rows.splice(f.rows.findIndex(row => row.data?.launchId === "later"), 1); f.write();
      expect(() => audit.check(f.snapshot)).toThrow(/period disappeared|obligation/i);
    });

    it("requires the same binding after a pending period becomes acknowledged and terminal", () => {
      const f = evidenceFixture();
      const prior = mode === "check" ? captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root) : undefined;
      const current = advancePeriod(f, "reserved");
      const audit = prior ?? captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
      expect(audit.check(f.snapshot).identities).toHaveLength(1);
      f.rows.push(...laterPeriod(f).slice(1), f.record({ kind: "terminal", launchId: "later", status: "complete", finishedAt: "later" }),
        { type: "custom_message", customType: "easyresearch:agent_status", display: false,
          details: { outcomes: [{ launchId: "later", status: "complete" }] } });
      f.write();
      expect(audit.check(settled(current), "complete")).toMatchObject({ terminalOutcomes: 1, userRows: 2, toolExecutions: 1 });
      const reservation = f.rows.find(row => row.data?.launchId === "later" && row.data.kind === "reserved").data;
      reservation.toolCallId = "wake:foreign-launch"; f.write();
      const rebound = structuredClone(current);
      rebound.subagents.at(-1)!.toolCallId = reservation.toolCallId;
      expect(() => audit.check(settled(rebound), "complete")).toThrow(/admission|obligation|wake/i);
    });

    it("rejects removal of an observed created binding instead of accepting an older reservation prefix", () => {
      const f = evidenceFixture(2);
      const prior = mode === "check" ? captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root) : undefined;
      advancePeriod(f, "created");
      const audit = prior ?? captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
      expect(audit.check(f.snapshot).identities).toHaveLength(2);
      f.rows.pop(); f.write();
      expect(() => audit.check(f.snapshot)).toThrow(/regress|obligation/i);
    });

    it.each(admissionPhases.slice(0, -1))("rejects terminal settlement while %s remains unresolved", phase => {
      const f = evidenceFixture(2);
      const prior = mode === "check" ? captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root) : undefined;
      advancePeriod(f, phase);
      const audit = prior ?? captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
      expect(audit.check(f.snapshot).identities).toHaveLength(2);
      expect(() => audit.check(settled(f.snapshot), "error")).toThrow(/unresolved|admission|acknowledg/i);
    });

    it.each(["fresh", "foreign-wake", "owner", "agent", "alias", "unsettled", "concurrent", "uuid", "path"])("rejects %s admission rather than excluding it from the child count", fault => {
      const f = evidenceFixture(2);
      const prior = mode === "check" ? captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root) : undefined;
      advancePeriod(f, fault === "uuid" || fault === "path" ? "created" : "reserved");
      const reserved = f.rows.find(row => row.data?.launchId === "later" && row.data.kind === "reserved").data;
      if (fault === "fresh") reserved.continuation = false;
      if (fault === "foreign-wake") reserved.toolCallId = "wake:foreign-launch";
      if (fault === "owner") reserved.ownerSessionId = "leaf";
      if (fault === "agent") reserved.agent = "other-agent";
      if (fault === "alias") reserved.agentId = "other-alias";
      if (fault === "unsettled") f.rows.splice(f.rows.findIndex(row => row.data?.kind === "background_report"), 1);
      if (fault === "concurrent") f.rows.push(f.record({ ...reserved, launchId: "concurrent" }));
      if (fault === "uuid" || fault === "path") {
        const created = f.rows.find(row => row.data?.launchId === "later" && row.data.kind === "created").data;
        if (fault === "uuid") created.childSessionId = "foreign-uuid";
        else created.sessionPath = f.childPath;
      }
      f.write();
      expect(() => prior ? prior.check(f.snapshot) : captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root)).toThrow();
    });

    it("still rejects a genuinely admitted third child", () => {
      const f = evidenceFixture(2);
      const prior = mode === "check" ? captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root) : undefined;
      advancePeriod(f);
      const reservation = f.rows.find(row => row.data?.launchId === "later" && row.data.kind === "reserved").data;
      Object.assign(reservation, { continuation: false, toolCallId: "extra-dispatch", agentId: "owner_1" });
      const created = f.rows.find(row => row.data?.launchId === "later" && row.data.kind === "created").data;
      Object.assign(created, { childSessionId: "third-child", sessionPath: join(f.root, "third.jsonl") });
      f.write();
      expect(() => prior ? prior.check(f.snapshot) : captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root)).toThrow(/logical child/i);
    });

    it("archives the exact failed read after disk admission and snapshots have advanced", () => {
      const f = evidenceFixture(2);
      const prior = mode === "check" ? captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root) : undefined;
      advancePeriod(f, "reserved");
      const reservation = f.rows.at(-1)!.data;
      reservation.toolCallId = "wake:foreign-launch";
      reservation.description = "PRIVATE_FAILING_READ_BODY";
      reservation.apiKey = "PRIVATE_FAILING_READ_KEY";
      f.write();
      let failure: unknown;
      const atFailure = structuredClone(f.snapshot);
      try { prior ? prior.check(atFailure) : captureRetryEvidence(atFailure, f.recovery, f.item, f.root); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      atFailure.session.id = "advanced-snapshot";
      reservation.toolCallId = "wake:owner-launch";
      f.rows.push(...laterPeriod(f).slice(1)); f.write();
      const archive = preserveRetryFailureEvidence({ root: f.root, caseName: f.item.name, phase: mode, snapshots: [f.snapshot],
        error: failure, parentDirectory: directory() });
      const serialized = readFileSync(archive, "utf8");
      const saved = JSON.parse(serialized);
      expect(saved.failureRead.snapshot.session.id).toBe("root");
      expect(saved.failureRead.jobs.find((job: { launchId: string }) => job.launchId === "later"))
        .toMatchObject({ childSessionId: null, sessionPath: null, launchAcknowledged: false, toolCallId: "wake:foreign-launch" });
      expect(saved.failureRead.journalTail.at(-1).data.kind).toBe("reserved");
      expect(saved.histories.find((history: { source: string }) => history.source === f.rootPath).entries.at(-1).data.kind).toBe("launch_acknowledged");
      expect(serialized).not.toMatch(/PRIVATE_FAILING_READ_BODY|PRIVATE_FAILING_READ_KEY|advanced-snapshot/);
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(4 * 1024 * 1024);
    });
  });

  it("bounds exact-read metadata while keeping the failing journal tail and excluding message bodies", () => {
    const f = evidenceFixture(2);
    for (let index = 0; index < 2600; index++) f.rows.push({ type: "custom", customType: "isolated-probe", id: `probe-${index}`,
      data: { kind: "probe", ownerSessionId: "x".repeat(512), toolCallId: "y".repeat(512), content: "PRIVATE_LARGE_READ_BODY" } });
    advancePeriod(f, "reserved");
    f.rows.at(-1)!.data.toolCallId = "wake:foreign-launch"; f.write();
    const snapshot = structuredClone(f.snapshot);
    snapshot.subagents = Array.from({ length: 2000 }, () => ({ ...f.snapshot.subagents[0]!, agentId: "z".repeat(512) }));
    let failure: unknown;
    try { captureRetryEvidence(snapshot, f.recovery, f.item, f.root); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const archive = preserveRetryFailureEvidence({ root: f.root, caseName: f.item.name, phase: "capture",
      snapshots: [snapshot], error: failure, parentDirectory: directory() });
    const serialized = readFileSync(archive, "utf8");
    const saved = JSON.parse(serialized);
    expect(saved.failureRead.truncated).toBe(true);
    expect(saved.failureRead.journalTail.at(-1).data).toMatchObject({ kind: "reserved", toolCallId: "wake:foreign-launch" });
    expect(serialized).not.toContain("PRIVATE_LARGE_READ_BODY");
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it("records the physical root read when the supplied snapshot has a replaced path", () => {
    const f = evidenceFixture();
    const audit = captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
    const replaced = structuredClone(f.snapshot);
    replaced.session.sessionFile = join(f.root, "not-the-read-history.jsonl");
    let failure: unknown;
    try { audit.check(replaced); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const archive = preserveRetryFailureEvidence({ root: f.root, caseName: f.item.name, phase: "check", snapshots: [f.snapshot],
      error: failure, parentDirectory: directory() });
    const saved = JSON.parse(readFileSync(archive, "utf8"));
    expect(saved.failureRead.source).toBe(f.rootPath);
    expect(saved.failureRead.snapshot.session.sessionFile).toBe(replaced.session.sessionFile);
  });

  it("groups per-launch summaries into one logical child while validating every visible identity and journal path", () => {
    const f = evidenceFixture();
    const audit = captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
    const current = advancePeriod(f);
    expect(audit.check(current).identities).toHaveLength(1);
    expect(captureRetryEvidence(current, f.recovery, f.item, f.root).check(current).userRows).toBe(2);
    for (const field of ["ownerSessionId", "agentId", "agent", "childSessionId"] as const) {
      const changed = structuredClone(current);
      changed.subagents[0]![field] = "foreign";
      expect(() => audit.check(changed)).toThrow(/replaced|identity|logical/i);
    }
    const unknownLaunch = structuredClone(current);
    unknownLaunch.subagents[0]!.launchId = "unknown";
    expect(() => audit.check(unknownLaunch)).toThrow(/visible launch|journal/i);
    const oldPath = f.rows.find(row => row.data?.kind === "created" && row.data.launchId === "launch");
    oldPath.data.sessionPath = join(f.root, "foreign-child.jsonl");
    f.write();
    expect(() => audit.check(current)).toThrow(/identity|path/i);
  });

  it("allows active HTTP snapshots to precede a new journal period but requires the last visible period at terminal settlement", () => {
    const f = evidenceFixture();
    const audit = captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
    const current = advancePeriod(f);
    // HTTP projection predates the newly appended native period.
    expect(audit.check(f.snapshot).toolExecutions).toBe(1);
    expect(() => audit.check(settled(f.snapshot), "complete")).toThrow(/visible launch|latest|period/i);
    f.rows.push(f.record({ kind: "terminal", launchId: "later", status: "complete", finishedAt: "later" }),
      { type: "custom_message", customType: "easyresearch:agent_status", display: false,
        details: { outcomes: [{ launchId: "later", status: "complete" }] } });
    f.write();
    expect(audit.check(settled(current), "complete").terminalOutcomes).toBe(1);
    expect(() => audit.check(settled(f.snapshot), "complete")).toThrow(/visible launch|latest|period/i);
  });

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
    expect(audit.check(settled(f.snapshot), "complete").terminalOutcomes).toBe(1);
    f.rows.push(handoff); f.write();
    expect(() => audit.check(settled(f.snapshot), "complete")).toThrow(/duplicate.*handoff/);
  });

  it("audits durable busy-period reports without requiring the retired terminal journal record", () => {
    const f = evidenceFixture();
    f.rows.push(f.record({ kind: "background_admitted", launchId: "launch", admission: {
      cwd: f.root, callerAgent: "research-assistant", description: "Retry fixture child",
    } }));
    f.write();
    const audit = captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
    const report = f.record({ kind: "background_report", launchId: "launch",
      result: { state: "completed", text: f.item.leaf.final, outstanding: [] },
      batch: { batchId: "batch", ownerSessionId: "root", launchIds: ["launch"], content: "report", triggerTurn: true, createdAt: "now" },
    });
    f.rows.push(report, { type: "custom_message", customType: "easyresearch:agent_status", display: false,
      details: { outcomes: [{ launchId: "launch", status: "complete" }] } });
    f.write();
    expect(() => audit.check(f.snapshot)).toThrow(/Premature/);
    expect(audit.check(settled(f.snapshot), "complete").terminalOutcomes).toBe(1);
    f.rows.push(report); f.write();
    expect(() => audit.check(settled(f.snapshot), "complete")).toThrow(/duplicate/i);
  });

  it("allows a settled intermediate period to resume the same child while rejecting a concurrent replacement period", () => {
    const f = evidenceFixture();
    const audit = captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
    const appendPeriod = (launchId: string, outstanding: unknown[]) => {
      f.rows.push(f.record({ kind: "background_admitted", launchId, admission: {
        cwd: f.root, callerAgent: "research-assistant", description: "Retry fixture child",
      } }), f.record({ kind: "background_report", launchId,
        result: { state: "completed", text: "period outcome", outstanding },
        batch: { batchId: `batch-${launchId}`, ownerSessionId: "root", launchIds: [launchId], content: "report", triggerTurn: true, createdAt: "now" },
      }), { type: "custom_message", customType: "easyresearch:agent_status", display: false,
        details: { outcomes: [{ launchId, status: "complete" }] } });
    };
    appendPeriod("launch", [{ id: "shell", kind: "shell", sessionID: "leaf", status: "running" }]);
    f.write();
    expect(audit.check(f.snapshot).terminalOutcomes).toBe(0);
    f.rows.push(...[
      { kind: "reserved", launchId: "later", ownerSessionId: "root", toolCallId: "wake", agent: f.snapshot.subagents[0]!.agent,
        agentId: "leaf_0", continuation: true, createdAt: "later" },
      { kind: "created", launchId: "later", childSessionId: "leaf", sessionPath: f.childPath },
      { kind: "materialized", launchId: "later" },
      { kind: "launch_acknowledged", launchId: "later", acknowledgedAt: "later" },
    ].map(f.record));
    appendPeriod("later", []);
    f.write();
    const current = structuredClone(f.snapshot);
    current.subagents[0]!.launchId = "later";
    current.subagents[0]!.toolCallId = "wake";
    expect(audit.check(settled(current), "complete").terminalOutcomes).toBe(1);
    const initialReport = f.rows.findIndex(row => row.data?.kind === "background_report" && row.data.launchId === "launch");
    f.rows.splice(initialReport, 1);
    f.write();
    expect(() => audit.check(settled(current), "complete")).toThrow(/Premature|unsettled|changed|removed/i);
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

  it("accepts an error period only with a real live checkpoint, and preserves it through admitted recovery and success", () => {
    const f = evidenceFixture();
    const errorText = "503 service unavailable: controlled LLM retry direct_leaf failure 2";
    const first = f.record({ kind: "background_report", launchId: "launch",
      result: { state: "error", text: errorText, outstanding: [] },
      batch: { batchId: "failed-period", ownerSessionId: "root", launchIds: ["launch"], content: "error report", triggerTurn: true, createdAt: "now" },
    });
    f.rows.push(f.record({ kind: "background_admitted", launchId: "launch", admission: {
      cwd: f.root, callerAgent: "research-assistant", description: "Retry child",
    } }), first, { type: "custom_message", customType: "easyresearch:agent_status", display: false,
      details: { outcomes: [{ launchId: "launch", status: "error" }] } });
    f.snapshot.subagents[0]!.status = "error";
    f.write();
    const audit = captureRetryEvidence(f.snapshot, f.recovery, f.item, f.root);
    expect(audit.check(f.snapshot).terminalOutcomes).toBe(0);
    const missing = structuredClone(f.snapshot);
    missing.subagents[0]!.llmRecovery = null;
    expect(() => audit.check(missing)).toThrow(/checkpoint|recovery/i);
    const wrong = structuredClone(f.snapshot);
    wrong.subagents[0]!.llmRecovery!.failedEntryId = "not-a-failed-message";
    expect(() => audit.check(wrong)).toThrow(/checkpoint|persisted failure/i);
    const wrongTarget = structuredClone(f.snapshot);
    wrongTarget.subagents[0]!.llmRecovery!.targetSessionId = "different-child";
    expect(() => audit.check(wrongTarget)).toThrow(/checkpoint/i);
    appendFileSync(f.childPath, JSON.stringify({ type: "custom_message", customType: "easyresearch:llm-retry", display: false, content: "", details: { failedEntryId: "failed" } }) + "\n");
    f.rows.push(...[
      { kind: "reserved", launchId: "recovery", ownerSessionId: "root", toolCallId: "wake", agent: f.snapshot.subagents[0]!.agent, agentId: "leaf_0", continuation: true, createdAt: "later" },
      { kind: "created", launchId: "recovery", childSessionId: "leaf", sessionPath: f.childPath },
      { kind: "materialized", launchId: "recovery" },
      { kind: "launch_acknowledged", launchId: "recovery", acknowledgedAt: "later" },
      { kind: "background_admitted", launchId: "recovery", admission: { cwd: f.root, callerAgent: "research-assistant", description: "Retry child" } },
    ].map(f.record));
    f.write();
    const active = structuredClone(missing);
    Object.assign(active.subagents[0]!, { launchId: "recovery", toolCallId: "wake", status: "working" });
    expect(audit.check(active).toolExecutions).toBe(1);
    f.rows.push(f.record({ kind: "background_report", launchId: "recovery", result: { state: "completed", text: f.item.leaf.final, outstanding: [] },
      batch: { batchId: "success-period", ownerSessionId: "root", launchIds: ["recovery"], content: "success report", triggerTurn: true, createdAt: "later" } }),
      { type: "custom_message", customType: "easyresearch:agent_status", display: false, details: { outcomes: [{ launchId: "recovery", status: "complete" }] } });
    f.write();
    expect(audit.check(active, "complete").terminalOutcomes).toBe(1);
    first.data.result.text = "rewritten error";
    f.write();
    expect(() => audit.check(active, "complete")).toThrow(/changed|overwrit|immutable/i);
    first.data.result.text = errorText;
    const originalPeriod = f.rows.filter(row => row.data?.launchId === "launch");
    for (const row of originalPeriod) f.rows.splice(f.rows.indexOf(row), 1);
    f.write();
    expect(() => audit.check(active, "complete")).toThrow(/period disappeared/i);
  });
});
