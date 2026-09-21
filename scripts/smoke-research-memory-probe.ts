import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { readAgentAliases } from "../src/subagent/agent-alias";
import { runCleanupSteps } from "../src/runtime/cleanup";
import type { SessionSnapshotDto } from "../src/web/contracts";
import { fetchSessionEventsBeforeDeadline, parseSmokeInitialSessionSnapshot, requestSmokeJsonBeforeDeadline } from "./smoke-release-support";
import { MemorySmokeObservation, memorySmokeText, type MemorySmokeLane } from "./smoke-research-memory-support";
import type { createResearchMemorySmoke } from "./smoke-research-memory";

type Scenario = ReturnType<typeof createResearchMemorySmoke>;
interface Entry { type: string; id?: string; cwd?: string; message?: { role?: string; toolCallId?: string; toolName?: string; isError?: boolean; content?: unknown } }
function entries(path: string): Entry[] { return readFileSync(path, "utf8").trim().split(/\r?\n/u).map(line => JSON.parse(line)); }
function contained(path: string, parent: string): void {
  const rel = relative(realpathSync(parent), realpathSync(path));
  assert(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`), "smoke session escaped owned Agent directory");
}
function materialized(rootFile: string, agentId: string, agentDir: string, project: string) {
  const alias = readAgentAliases(entries(rootFile)).find(item => item.id === agentId);
  assert(alias, `missing persisted alias for acknowledged ${agentId}`);
  contained(alias.sessionPath, agentDir);
  const child = entries(alias.sessionPath);
  assert.equal(child[0]?.type, "session");
  assert.equal(child[0]?.id, alias.sessionId);
  assert.equal(child[0]?.cwd, project);
  assert(child.some(entry => entry.message?.role === "assistant"), "acknowledged child lacks first persisted assistant message");
  return alias;
}
function auditCalls(lane: MemorySmokeLane, path: string): void {
  const messages = entries(path).flatMap(entry => entry.message ? [entry.message] : []);
  for (const call of lane.calls) {
    const results = messages.filter(message => message.role === "toolResult" && message.toolCallId === call.id);
    assert.equal(results.length, 1, `missing/duplicate persisted result ${call.id}`);
    assert.equal(results[0]!.toolName, call.name);
    assert.equal(results[0]!.isError, Boolean(call.errorCode), `${call.id} native error flag disagreed with acceptance`);
    assert.equal(memorySmokeText(results[0]!.content), call.result, `${call.id} provider observed a different result from persisted Pi history`);
  }
}

/** Uses only existing Web session APIs and the caller's already owned compiled daemon. */
export async function runResearchMemorySmoke(options: {
  base: string; project: string; agentDir: string; deadline: number; scenario: Scenario;
}) {
  const { scenario, base, project, agentDir, deadline } = options;
  const json = (path: string, init?: RequestInit) => requestSmokeJsonBeforeDeadline({ url: `${base}${path}`, deadline, label: `RSI ${path}`, init });
  const post = (path: string, body: unknown) => json(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const sessions: Array<{ lane: string; id: string; path: string; children: ReturnType<typeof materialized>[] }> = [];
  for (const name of ["learn", "reuse"]) {
    const created = await post("/api/sessions", { cwd: project }) as { id: string };
    assert(typeof created.id === "string" && created.id);
    let rootFile: string | undefined;
    let streamError: { error: unknown } | undefined;
    let stopping = false;
    const acknowledged = new Map<string, ReturnType<typeof materialized>>();
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let reading: Promise<void> | undefined;
    let primary: { error: unknown } | undefined;
    try {
      const lane = scenario.lanes.get(name)!;
      const observation = new MemorySmokeObservation(`RSI_ROOT_DONE:${scenario.prompt(name).split(":")[1]}:${name}`, name === "learn" ? 3 : 1);
      response = await fetchSessionEventsBeforeDeadline({ url: `${base}/api/sessions/${created.id}/events`, deadline });
      assert(response.ok && response.body, "RSI session event subscription failed");
      const eventReader = response.body.getReader();
      reader = eventReader;
      reading = (async () => {
        let buffer = ""; const decoder = new TextDecoder();
        while (true) {
          const chunk = await eventReader.read();
          if (chunk.done) { assert(stopping, "RSI session stream ended before completion"); return; }
          buffer += decoder.decode(chunk.value, { stream: true });
          assert(buffer.length < 2 * 1024 * 1024, "RSI event frame exceeded its bound");
          const frames = buffer.split(/\r?\n\r?\n/u); buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const data = frame.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            const event = JSON.parse(data);
            if (event.type === "snapshot") {
              parseSmokeInitialSessionSnapshot(event);
              assert.equal(event.session.id, created.id);
              rootFile = event.session.sessionFile;
              assert(rootFile, "RSI initial snapshot omitted authoritative root path");
            }
            observation.observe(event);
            for (const agentId of observation.acknowledgements.keys()) {
              if (!acknowledged.has(agentId)) {
                assert(rootFile);
                acknowledged.set(agentId, materialized(rootFile, agentId, agentDir, project));
              }
            }
          }
        }
      })().catch(error => { streamError = { error }; });
      const wait = async (condition: () => boolean) => {
        while (!condition()) {
          if (streamError) throw streamError.error;
          if (scenario.failure) throw scenario.failure;
          assert(Date.now() < deadline, `RSI ${name} exceeded native deadline`);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (streamError) throw streamError.error;
        if (scenario.failure) throw scenario.failure;
      };
      await wait(() => rootFile !== undefined);
      await post(`/api/sessions/${created.id}/messages`, { message: scenario.prompt(name) });
      await wait(() => lane.complete && observation.ready);
      const snapshot = await json(`/api/sessions/${created.id}/snapshot`) as SessionSnapshotDto;
      parseSmokeInitialSessionSnapshot({ type: "snapshot", ...snapshot });
      assert.equal(snapshot.session.status, "ready"); assert.equal(snapshot.session.isStreaming, false);
      assert.equal(snapshot.session.sessionFile, rootFile);
      assert(rootFile); contained(rootFile, agentDir);
      const header = entries(rootFile)[0]!;
      assert.equal(header.id, created.id); assert.equal(header.cwd, project);
      auditCalls(lane, rootFile);
      for (const dispatch of lane.dispatches) {
        const alias = acknowledged.get(dispatch.agentId); assert(alias);
        const call = lane.calls.find(item => item.id === dispatch.callId)!;
        const childLane = scenario.laneFor({ messages: [{ role: "user", content: JSON.parse(call.arguments).task }] })!;
        auditCalls(scenario.lanes.get(childLane)!, alias.sessionPath);
        const ackIndex = snapshot.timeline.findIndex(entry => entry.kind === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === dispatch.callId);
        const terminalIndex = snapshot.timeline.findIndex(entry => entry.kind === "subagent-completion" && entry.outcomes.some(outcome => outcome.agentId === dispatch.agentId && outcome.status === "complete" && outcome.text === dispatch.terminal));
        assert(ackIndex >= 0 && terminalIndex > ackIndex, "persisted terminal handoff must follow normal launch acknowledgement");
      }
    } catch (error) { primary = { error }; }
    finally {
      stopping = true;
      await runCleanupSteps([
        () => { if (primary) throw primary.error; },
        async () => { if (reader) await reader.cancel(); else await response?.body?.cancel(); },
        // Cancellation failure must not abandon the owned reader task. Its catch
        // may record a violation after readiness, during the final snapshot.
        async () => { await reading; },
        () => { if (streamError) throw streamError.error; },
        async () => {
          await requestSmokeJsonBeforeDeadline({ url: `${base}/api/sessions/${created.id}/stop`, deadline: Date.now() + 15_000,
            label: "RSI owned session cleanup", init: { method: "POST" } });
        },
      ], "RSI probe failed during acceptance or owned cleanup");
    }
    assert(rootFile);
    sessions.push({ lane: name, id: created.id, path: rootFile, children: [...acknowledged.values()] });
  }
  const report = scenario.report();
  assert(report.complete);
  assert.equal(report.rootSessions.learn, sessions[0]!.id);
  assert.equal(report.rootSessions.reuse, sessions[1]!.id);
  assert.notEqual(sessions[0]!.id, sessions[1]!.id);
  const childIds = new Set(sessions.flatMap(session => session.children.map(child => child.sessionId)));
  assert.equal(childIds.size, 4, "fresh specialist sessions must be independent");
  assert(childIds.has(report.method.active!.author.sessionId!));
  assert(childIds.has(report.method.active!.verification!.actor.sessionId!));
  assert(childIds.has(report.strategy.active!.verification!.actor.sessionId!));
  assert(childIds.has(report.nextRound.pending!.author.sessionId!));
  return { ...report, sessions, providerRequests: scenario.requests };
}
