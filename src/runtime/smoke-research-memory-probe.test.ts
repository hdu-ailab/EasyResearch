import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createResearchMemorySmoke } from "../../scripts/smoke-research-memory";
import { runResearchMemorySmoke } from "../../scripts/smoke-research-memory-probe";
import type { MemorySmokeRequest } from "../../scripts/smoke-research-memory-support";
import { createResearchMemoryStore } from "../research-memory/store";
import { nativeLocalShellTool } from "./platform-tools";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Only the HTTP/Agent transport is replaced. The exported probe, response lanes,
 * memory operations, SSE streams and persisted-history audits all run for real. */
function probeFixture(options: {
  subscriptionFailure?: boolean;
  privateActivityDuringSnapshot?: boolean;
  snapshotFailure?: boolean;
  stopFailure?: boolean;
  cancelFailure?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "rsi-full-probe-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const skill = join(agentDir, "bundled/skills/research-experience/SKILL.md");
  mkdirSync(dirname(skill), { recursive: true });
  mkdirSync(project);
  writeFileSync(skill, "# research-experience\nUse frozen accepted references.\n");
  const scenario = createResearchMemorySmoke({ runId: randomUUID(), project, agentDir, platform: process.platform });
  const store = createResearchMemoryStore(agentDir);
  interface Session {
    id: string;
    path: string;
    lane: string;
    timeline: unknown[];
    controller?: ReadableStreamDefaultController<Uint8Array>;
  }
  const roots: Session[] = [];
  const stopped: string[] = [];
  const cancelled: string[] = [];
  const snapshotRequests: string[] = [];
  let privateActivityInjected = false;
  let reportCalls = 0;
  const report = scenario.report;
  scenario.report = () => { reportCalls++; return report(); };
  const snapshot = (session: Session) => ({
    session: { id: session.id, cwd: project, sessionFile: session.path, status: "ready", isStreaming: false },
    runtimeConfigurationGeneration: 1, timeline: session.timeline, subagents: [],
    compactionPolicy: { triggerPercent: 70, enabled: true },
  });
  const append = (session: Session, entry: object) => appendFileSync(session.path, `${JSON.stringify(entry)}\n`);
  const message = (session: Session, content: object) => {
    const id = randomUUID();
    append(session, { type: "message", id, message: content });
    session.timeline.push({ kind: "message", entryId: id, message: content });
  };
  const create = (lane: string): Session => {
    const id = randomUUID();
    const session: Session = { id, path: join(agentDir, `${id}.jsonl`), lane, timeline: [] };
    append(session, { type: "session", id, cwd: project });
    return session;
  };
  const emit = (session: Session, event: unknown) => {
    assert(session.controller, "fixture must subscribe before dispatch");
    session.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  };
  const runLane = async (session: Session, isRoot: boolean): Promise<string> => {
    const messages: NonNullable<MemorySmokeRequest["messages"]> = [
      { role: "system", content: "<name>research-experience</name>\n<name>recursive-self-improvement</name>" },
      { role: "user", content: scenario.prompt(session.lane) },
    ];
    const tools = ["read", "write", "research-memory", nativeLocalShellTool(process.platform), ...(isRoot ? ["subagent", "ssh-bash"] : [])]
      .map(name => ({ function: { name } }));
    let childSequence = 0;
    for (let budget = 0; budget < 100; budget++) {
      const action = scenario.select({ messages, tools });
      if (action.kind === "text") {
        message(session, { role: "assistant", content: [{ type: "text", text: action.text }] });
        return action.text;
      }
      const args = JSON.parse(action.arguments);
      message(session, { role: "assistant", content: [{ type: "toolCall", id: action.id, name: action.name, arguments: args }] });
      let text: string;
      let isError = false;
      let child: { agentId: string; final: string } | undefined;
      if (action.name === "subagent") {
        const childLane = scenario.laneFor({ messages: [{ role: "user", content: args.task }] });
        assert(childLane);
        const childSession = create(childLane);
        child = { agentId: `search_${childSequence++}`, final: await runLane(childSession, false) };
        append(session, { type: "custom", customType: "easyresearch:subagent_session_alias", data: {
          id: child.agentId, agent: "search", sessionId: childSession.id, sessionPath: childSession.path,
        } });
        text = `${child.agentId} is working.`;
      } else if (action.name === "research-memory") {
        try { text = JSON.stringify(await store.execute(args, { cwd: project, sessionId: session.id,
          agent: isRoot ? "research-assistant" : "search", model: "smoke/smoke-model" })); }
        catch (error) { isError = true; text = `${(error as { code: string }).code}: ${(error as Error).message}`; }
      } else if (action.name === "write") {
        const path = resolve(project, args.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, args.content);
        text = `Successfully wrote ${args.content.length} bytes to ${args.path}`;
      } else {
        assert.equal(action.name, "read");
        text = readFileSync(resolve(project, args.path), "utf8");
      }
      messages.push({ role: "tool", tool_call_id: action.id, content: text });
      message(session, { role: "toolResult", toolName: action.name, toolCallId: action.id, isError, content: [{ type: "text", text }] });
      if (child) {
        emit(session, { type: "tool_execution_end", toolName: "subagent", toolCallId: action.id,
          isError: false, result: { content: [{ type: "text", text }] } });
        emit(session, { type: "subagent_supervisor", agentId: child.agentId, status: "complete" });
        messages.push({ role: "user", content: `<agent_status>\nTime: now\nComplete subagent:${child.agentId}\n</agent_status>\n<agent_handoff>\nAgent: ${child.agentId}\nResult: ${child.final}\n</agent_handoff>` });
        session.timeline.push({ kind: "subagent-completion", entryId: randomUUID(), batchId: randomUUID(),
          timestamp: new Date().toISOString(), outcomes: [{ launchId: action.id, agentId: child.agentId, status: "complete", text: child.final }] });
      }
    }
    throw new Error("fixture response budget exhausted");
  };

  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname;
    if (path === "/api/sessions") {
      assert.equal(init?.method, "POST");
      const session = create(roots.length === 0 ? "learn" : "reuse");
      roots.push(session);
      return Response.json({ id: session.id });
    }
    const session = roots.find(item => path.startsWith(`/api/sessions/${item.id}/`));
    assert(session, `unowned request: ${path}`);
    if (path.endsWith("/events")) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          session.controller = controller;
          if (!options.subscriptionFailure) emit(session, { type: "snapshot", ...snapshot(session) });
        },
        cancel() {
          cancelled.push(session.id);
          if (options.cancelFailure) throw new Error("fixture reader cancellation failed");
        },
      });
      return new Response(body, { status: options.subscriptionFailure ? 503 : 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (path.endsWith("/messages")) {
      const final = await runLane(session, true);
      emit(session, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: final }] } });
      emit(session, { type: "session_activity_changed", status: "ready", isStreaming: false });
      return Response.json({ ok: true });
    }
    if (path.endsWith("/snapshot")) {
      snapshotRequests.push(session.id);
      if (options.privateActivityDuringSnapshot) {
        privateActivityInjected = true;
        emit(session, { type: "subagent_supervisor", agentId: "search_0", event: { type: "session_activity_changed", active: false } });
        // A real pending read consumes this event while the final snapshot is in flight.
        await new Promise(resolveTurn => setImmediate(resolveTurn));
      }
      return options.snapshotFailure ? new Response("fixture snapshot failed", { status: 500 }) : Response.json(snapshot(session));
    }
    assert(path.endsWith("/stop"));
    assert.equal(init?.method, "POST");
    stopped.push(session.id);
    return options.stopFailure ? new Response("fixture stop failed", { status: 500 }) : Response.json({ ok: true });
  });
  return {
    roots, stopped, cancelled, snapshotRequests,
    get privateActivityInjected() { return privateActivityInjected; },
    get reportCalls() { return reportCalls; },
    run: () => runResearchMemorySmoke({ base: "http://rsi-probe.invalid", agentDir, project, scenario, deadline: Date.now() + 5_000 }),
  };
}

describe("exported research-memory probe ownership and terminal errors", () => {
  it("accepts a complete stream and settles both owned roots and readers", async () => {
    const fixture = probeFixture();
    const report = await fixture.run();
    expect(report.complete).toBe(true);
    expect(new Set(report.sessions.flatMap(session => session.children.map(child => child.sessionId))).size).toBe(4);
    expect(fixture.stopped).toEqual(report.sessions.map(session => session.id));
    expect(fixture.cancelled).toEqual(fixture.stopped);
    expect(fixture.snapshotRequests).toEqual(fixture.stopped);
    expect(fixture.reportCalls).toBe(1);
  });

  it("rejects private activity delivered during the final snapshot after readiness", async () => {
    const fixture = probeFixture({ privateActivityDuringSnapshot: true });
    await expect(fixture.run()).rejects.toThrow(/private active state/);
    expect(fixture.privateActivityInjected).toBe(true);
    expect(fixture.snapshotRequests).toEqual([fixture.roots[0]!.id]);
    expect(fixture.stopped).toEqual([fixture.roots[0]!.id]);
    expect(fixture.cancelled).toEqual(fixture.stopped);
    expect(fixture.reportCalls).toBe(0);
  });

  it("stops an owned root and cancels the response body when event subscription returns 503", async () => {
    const fixture = probeFixture({ subscriptionFailure: true });
    await expect(fixture.run()).rejects.toThrow(/subscription failed/);
    expect(fixture.stopped).toEqual([fixture.roots[0]!.id]);
    expect(fixture.cancelled).toEqual(fixture.stopped);
    expect(fixture.reportCalls).toBe(0);
  });

  it("preserves primary, late stream, cancellation and stop failures after attempting every cleanup", async () => {
    const fixture = probeFixture({ snapshotFailure: true, privateActivityDuringSnapshot: true, cancelFailure: true, stopFailure: true });
    const error = await fixture.run().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    const messages = (error as AggregateError).errors.map((failure: Error) => failure.message);
    expect(messages[0]).toContain("fixture snapshot failed");
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining("private active state"), "fixture reader cancellation failed", expect.stringContaining("fixture stop failed"),
    ]));
    expect(fixture.stopped).toEqual([fixture.roots[0]!.id]);
    expect(fixture.cancelled).toEqual(fixture.stopped);
    expect(fixture.reportCalls).toBe(0);
  });
});
