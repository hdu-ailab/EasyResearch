import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertResearchMemoryCapabilities,
  MemorySmokeLane,
  MemorySmokeObservation,
  type MemorySmokeRequest,
} from "../../scripts/smoke-research-memory-support";
import { createResearchMemorySmoke } from "../../scripts/smoke-research-memory";
import { createResearchMemoryStore } from "../research-memory/store";
import { loadAgentCatalog, resolveAgentCatalog } from "../subagent/agents";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temporary() {
  const root = mkdtempSync(join(tmpdir(), "rsi-smoke-test-"));
  roots.push(root);
  return root;
}
const toolResult = (id: string, content: string) => ({ role: "tool", tool_call_id: id, content });
const request = (messages: MemorySmokeRequest["messages"] = []): MemorySmokeRequest => ({
  tools: ["research-memory", "subagent"].map(name => ({ function: { name } })), messages,
});

describe("memory smoke result-driven response lanes", () => {
  it("requires the exact result before advancing and rejects duplicates or unrelated results", () => {
    const lane = new MemorySmokeLane("author", [{ name: "research-memory", args: () => ({ action: "recall" }),
      accept: text => { expect(JSON.parse(text).memories).toEqual([]); } }], () => "done");
    const first = lane.select(request());
    expect(first.kind).toBe("tool");
    if (first.kind !== "tool") throw new Error("missing call");
    expect(lane.complete).toBe(false);
    expect(() => lane.select(request([toolResult("unrelated", "{}")]))).toThrow(/exactly one.*result/);
    expect(() => lane.select(request([toolResult(first.id, "{}"), toolResult(first.id, "{}")]))).toThrow(/exactly one.*result/);
    expect(lane.select(request([toolResult(first.id, '{"memories":[]}')]))).toEqual({ kind: "text", text: "done" });
    expect(lane.complete).toBe(true);
    expect(() => lane.select(request())).toThrow(/complete/);
  });

  it("does not accept a working ack as terminal evidence or another child's handoff", () => {
    const lane = new MemorySmokeLane("root", [{ name: "subagent", args: () => ({ agent: "search", task: "probe" }),
      terminal: () => "complete\nverified child" }], () => "root done");
    const call = lane.select(request());
    if (call.kind !== "tool") throw new Error("missing call");
    const messages = [toolResult(call.id, "search_4 is working.")];
    expect(lane.select(request(messages)).kind).toBe("text");
    expect(lane.complete).toBe(false);
    const terminal = (agent: string, status = "Complete", body = "complete\nverified child") => ({ role: "user",
      content: `<agent_status>\nTime: now\n${status} subagent:${agent}\n</agent_status>\n<agent_handoff>\nAgent: ${agent}\nResult: ${body}\n</agent_handoff>` });
    expect(lane.select(request([...messages, terminal("search_5")])).kind).toBe("text");
    expect(lane.complete).toBe(false);
    expect(() => lane.select(request([...messages, terminal("search_4", "Complete", "wrong")]))).toThrow(/handoff/);
    expect(lane.select(request([...messages, terminal("search_4")]))).toEqual({ kind: "text", text: "root done" });
    expect(lane.dispatches).toEqual([{ callId: call.id, agentId: "search_4", terminal: "complete\nverified child" }]);
  });

  it("rejects failed launch text and missing tool availability", () => {
    const lane = new MemorySmokeLane("root", [{ name: "subagent", args: () => ({}), terminal: () => "complete" }], () => "done");
    expect(() => lane.select({ tools: [], messages: [] })).toThrow(/tool.*subagent/);
    const call = lane.select(request());
    if (call.kind !== "tool") throw new Error("missing call");
    expect(() => lane.select(request([toolResult(call.id, "Error: launch failed")]))).toThrow(/acknowledgement/);
  });

  it("bounds waiting requests instead of allowing an unending provider loop", () => {
    const lane = new MemorySmokeLane("root", [{ name: "subagent", args: () => ({}), terminal: () => "complete" }], () => "done");
    const call = lane.select(request());
    if (call.kind !== "tool") throw new Error("missing call");
    expect(() => { for (let n = 0; n < 200; n++) lane.select(request([toolResult(call.id, "search_0 is working.")])); }).toThrow(/budget/);
  });
});

describe("packaged six-role capability acceptance", () => {
  it.each(["linux", "darwin", "win32"] as const)("accepts the real resolved catalog and rejects capability leaks on %s", async platform => {
    const root = temporary();
    const options = { agentDir: join(root, "agent"), cwd: root, homeDir: join(root, "home"), platform };
    const { agents } = resolveAgentCatalog(await loadAgentCatalog(options), options);
    const rows = agents.map(agent => ({ ...agent, builtin: true, enabled: true, source: "bundled" }));
    expect(() => assertResearchMemoryCapabilities(rows, platform)).not.toThrow();
    for (const [name, field, value] of [
      ["review", "effectiveTools", "edit"], ["review", "effectiveTools", "ssh-bash"],
      ["search", "effectiveTools", "subagent"], ["search", "effectiveSkills", "recursive-self-improvement"],
      ["writing", "effectiveTools", platform === "win32" ? "bash" : "powershell"],
    ]) {
      const changed = structuredClone(rows);
      (changed.find(row => row.name === name)![field as "effectiveTools" | "effectiveSkills"]).push(value!);
      expect(() => assertResearchMemoryCapabilities(changed, platform)).toThrow();
    }
    const missing = structuredClone(rows);
    missing.find(row => row.name === "experiment")!.effectiveTools = ["read"];
    expect(() => assertResearchMemoryCapabilities(missing, platform)).toThrow();
    const unbounded = structuredClone(rows);
    unbounded.find(row => row.name === "experiment")!.tools = [];
    expect(() => assertResearchMemoryCapabilities(unbounded, platform)).toThrow(/strict/);
    const unresolved = structuredClone(rows);
    unresolved.find(row => row.name === "search")!.effectiveSkills.push("not-configured");
    expect(() => assertResearchMemoryCapabilities(unresolved, platform)).toThrow(/configured/);
  });
});

describe("memory smoke terminal acceptance probe", () => {
  const ready = { type: "session_activity_changed", status: "ready", isStreaming: false };
  const ack = { type: "tool_execution_end", toolName: "subagent", toolCallId: "launch", isError: false,
    result: { content: [{ type: "text", text: "search_0 is working." }] } };
  const terminal = { type: "subagent_supervisor", agentId: "search_0", status: "complete" };
  const final = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "root done" }] } };
  it("requires acknowledgement, supervisor terminal, final root message, and a later ready replacement", () => {
    const observed = new MemorySmokeObservation("root done", 1);
    observed.observe(ready);
    observed.observe(ack);
    expect(observed.ready).toBe(false);
    observed.observe(terminal);
    observed.observe(final);
    expect(observed.ready).toBe(false);
    observed.observe({ type: "session_activity_changed", status: "running", isStreaming: false });
    expect(observed.ready).toBe(false);
    observed.observe(ready);
    expect(observed.ready).toBe(true);
  });
  it("rejects launch errors, missing acknowledgements, unknown terminals and leaked private activity", () => {
    expect(() => new MemorySmokeObservation("root done", 1).observe({ ...ack, isError: true })).toThrow();
    expect(() => new MemorySmokeObservation("root done", 1).observe(terminal)).toThrow(/acknowledgement/);
    const observed = new MemorySmokeObservation("root done", 1);
    observed.observe(ack);
    expect(() => observed.observe({ ...terminal, agentId: "unowned_0" })).toThrow(/acknowledgement/);
    expect(() => observed.observe({ type: "subagent_supervisor", event: { type: "session_activity_changed", active: false } })).toThrow();
    expect(() => observed.observe({ ...terminal, status: "error" })).toThrow();
  });
});

it("runs the response scenario against real isolated memory operations, with independent sessions and frozen next-round lineage", async () => {
  const root = temporary();
  const project = join(root, "project");
  mkdirSync(project);
  const scenario = createResearchMemorySmoke({ runId: "fixture", project, agentDir: join(root, "agent"), platform: "linux" });
  const store = createResearchMemoryStore(join(root, "agent"));
  let childSequence = 0;
  const run = async (lane: string, sessionId: string, role: string): Promise<string> => {
    const messages: NonNullable<MemorySmokeRequest["messages"]> = [
      { role: "system", content: "<name>research-experience</name>\n<name>recursive-self-improvement</name>" },
      { role: "user", content: scenario.prompt(lane) },
    ];
    const tools = ["research-memory", "read", "write", "bash", "web-search", "webfetch", ...(role === "research-assistant" ? ["subagent", "ssh-bash"] : [])]
      .map(name => ({ function: { name } }));
    for (let n = 0; n < 100; n++) {
      const action = scenario.select({ messages, tools });
      if (action.kind === "text") return action.text;
      const args = JSON.parse(action.arguments);
      let text: string;
      if (action.name === "subagent") {
        const agentId = `search_${childSequence++}`;
        const childLane = scenario.laneFor({ messages: [{ role: "user", content: args.task }] })!;
        const final = await run(childLane, `session-${agentId}`, "search");
        messages.push(toolResult(action.id, `${agentId} is working.`));
        messages.push({ role: "user", content: `<agent_status>\nTime: now\nComplete subagent:${agentId}\n</agent_status>\n<agent_handoff>\nAgent: ${agentId}\nResult: ${final}\n</agent_handoff>` });
        continue;
      }
      if (action.name === "research-memory") {
        try { text = JSON.stringify(await store.execute(args, { cwd: project, sessionId, agent: role, model: "smoke/smoke-model" })); }
        catch (error) { text = `${(error as { code: string }).code}: ${(error as Error).message}`; }
      } else if (action.name === "write") {
        mkdirSync(dirname(join(project, args.path)), { recursive: true });
        writeFileSync(join(project, args.path), args.content);
        text = `Successfully wrote ${args.content.length} bytes to ${args.path}`;
      } else {
        text = args.path.includes("SKILL.md") ? "# research-experience\nUse exact accepted revisions." : readFileSync(join(project, args.path), "utf8");
      }
      messages.push(toolResult(action.id, text));
    }
    throw new Error("fixture exceeded its bounded calls");
  };
  await run("learn", "root-learn", "research-assistant");
  await run("reuse", "root-reuse", "research-assistant");
  const report = scenario.report();
  expect(report.complete).toBe(true);
  expect(report.method.active?.author.sessionId).not.toBe(report.method.active?.verification?.actor.sessionId);
  expect(report.strategy.active?.entry.kind).toBe("strategy");
  expect(report.nextRound.pending?.entry.basedOn).toContainEqual(report.strategyRef);
  expect(report.restored.active).toEqual(report.method.active);
  expect(report.restored.revision).toBeGreaterThan(report.method.revision);
  expect(report.denials).toEqual(expect.arrayContaining(["FORBIDDEN", "EVIDENCE"]));
  expect(report.comparison).toMatchObject({ baseline: 1, candidate: 2, baselineBudget: 2, candidateBudget: 2 });
});
