import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativeLocalShellTool } from "../src/runtime/platform-tools";
import { SmokeAgentLane, smokeAgentText, type SmokeAgentAction, type SmokeAgentRequest } from "./smoke-agent-scenario";
import { venvToolCommand } from "./smoke-release-support";

export type RetryFixtureAction = SmokeAgentAction | { kind: "failure"; message: string };

/** A provider script, not an application retry loop. Each request is made by Pi. */
export class RetryFixtureLane {
  readonly requests: Array<{ at: number; messages: SmokeAgentRequest["messages"] }> = [];
  readonly callId: string;
  complete = false;
  failures = 0;
  private issued = false;
  private context?: SmokeAgentRequest["messages"];
  private gate?: { hit: boolean; promise: Promise<void>; release(): void };

  constructor(readonly name: string, readonly final: string, readonly marker: string,
    private readonly tool: { name: string; command: string } | undefined,
    private readonly failuresBeforeSuccess: number) {
    this.callId = `retry_counter_${name}`;
  }

  holdNext() {
    assert(!this.gate, "Only one provider response may be held per lane");
    const pending = Promise.withResolvers<void>();
    const gate = { hit: false, promise: pending.promise, release: () => pending.resolve() };
    this.gate = gate;
    return gate;
  }

  release() { this.gate?.release(); }

  async select(request: SmokeAgentRequest): Promise<RetryFixtureAction> {
    assert(!this.complete, `${this.name}: unexpected request after completion`);
    assert(this.requests.length < 32, `${this.name}: bounded provider script exceeded`);
    this.requests.push({ at: performance.now(), messages: structuredClone(request.messages) });
    const gate = this.gate;
    if (gate) { gate.hit = true; await gate.promise; this.gate = undefined; }
    if (this.tool && !this.issued) {
      assert.equal(request.tools?.filter(tool => tool.function?.name === this.tool!.name).length, 1);
      this.issued = true;
      return { kind: "tool", id: this.callId, name: this.tool.name,
        arguments: JSON.stringify({ command: this.tool.command }) };
    }
    if (this.tool) {
      const results = request.messages?.filter(message => message.role === "tool" && message.tool_call_id === this.callId) ?? [];
      assert.equal(results.length, 1, `${this.name}: completed counter tool result missing or duplicated`);
      assert(smokeAgentText(results[0]!.content).includes(this.marker), `${this.name}: completed tool did not run`);
    }
    assert.equal(request.messages?.filter(message => message.role === "user").length, 1,
      `${this.name}: recovery injected a new user/Task/control message`);
    assert(!JSON.stringify(request.messages).includes("easyresearch:llm-retry"), "Hidden wake leaked to provider context");
    if (this.context) assert.deepEqual(request.messages, this.context,
      `${this.name}: recovery changed completed request context or retained a failed assistant`);
    else this.context = structuredClone(request.messages);
    if (this.failures < this.failuresBeforeSuccess) {
      this.failures++;
      return { kind: "failure", message: `503 service unavailable: controlled LLM retry ${this.name} failure ${this.failures}` };
    }
    this.complete = true;
    return { kind: "text", text: this.final };
  }
}

export interface RetryFixtureCase {
  name: string;
  depth: 0 | 1 | 2;
  prompt: string;
  final: string;
  leaf: RetryFixtureLane;
  counter: string;
  owner?: SmokeAgentLane;
  dispatcher?: SmokeAgentLane;
}

/** Shared by native and browser acceptance. No real resources are read or copied. */
export function createLlmRetryFixture(options: { runId: string; directory: string; platform?: NodeJS.Platform; venv?: boolean }) {
  const platform = options.platform ?? process.platform;
  const shell = nativeLocalShellTool(platform);
  const prefix = `LLM_RETRY_${options.runId}:`;
  const leafAgent = "smoke-llm-retry-leaf";
  const ownerAgent = "smoke-llm-retry-owner";
  const lanes = new Map<string, RetryFixtureLane | SmokeAgentLane>();
  const summaries = new Map<string, RetryFixtureLane>();
  const cases: RetryFixtureCase[] = [];
  let failure: unknown;
  let requests = 0;
  mkdirSync(options.directory, { recursive: true });
  const prompt = (name: string) => `${prefix}${name}`;
  const final = (name: string) => `LLM_RETRY_COMPLETE_${options.runId}_${name}`;
  const laneFor = (request: SmokeAgentRequest) => {
    // Native compaction includes prior conversation markers inside its one user
    // message. Route the explicit custom-instructions marker before that history.
    for (const [name, lane] of summaries) if (request.messages?.some(message => message.role === "user"
      && new RegExp(`${prompt(name)}(?![A-Za-z0-9_-])`).test(smokeAgentText(message.content)))) return lane;
    for (const message of [...request.messages ?? []].reverse()) {
      if (message.role !== "user") continue;
      const match = smokeAgentText(message.content).match(new RegExp(`${prefix}([A-Za-z0-9_-]+)`));
      if (match) return lanes.get(match[1]!);
    }
    return undefined;
  };
  return {
    leafAgent, ownerAgent, cases, laneFor, prompt, final,
    get failure() { return failure; },
    get requests() { return requests; },
    addText(name: string, text: string) {
      assert(!lanes.has(name));
      const lane = new SmokeAgentLane(name, [], () => text);
      lanes.set(name, lane);
      return lane;
    },
    addSummary(name: string) {
      assert(!lanes.has(name) && !summaries.has(name));
      const lane = new RetryFixtureLane(name, final(name), "", undefined, 1);
      summaries.set(name, lane);
      return lane;
    },
    addProbe(name: string, failForever = false) {
      assert(!lanes.has(name));
      const lane = new RetryFixtureLane(name, final(name), "", undefined, failForever ? Infinity : 1);
      lanes.set(name, lane);
      return lane;
    },
    addCase(name: string, depth: 0 | 1 | 2): RetryFixtureCase {
      assert(/^[A-Za-z0-9_-]+$/.test(name) && !lanes.has(name));
      const leafName = depth ? `${name}_leaf` : name;
      const counter = join(options.directory, `${name}.counter`);
      const marker = `COUNTER_${options.runId}_${name}`;
      let command: string;
      if (options.venv) {
        const script = join(options.directory, `${name}.py`);
        writeFileSync(script, `from pathlib import Path\nwith Path(${JSON.stringify(counter)}).open("a", encoding="utf-8") as f:\n    f.write(${JSON.stringify(marker + "\n")})\nprint(${JSON.stringify(marker)})\n`);
        command = venvToolCommand(platform, script);
      } else if (platform === "win32") {
        command = `Add-Content -LiteralPath '${counter.replaceAll("'", "''")}' -Value '${marker}'; Write-Output '${marker}'`;
      } else {
        command = `printf '%s\\n' '${marker}' >> '${counter.replaceAll("'", "'\\''")}'; printf '%s\\n' '${marker}'`;
      }
      const leaf = new RetryFixtureLane(leafName, final(leafName), marker, { name: shell, command }, 5);
      lanes.set(leafName, leaf);
      const dispatch = (caller: string, agent: string, child: string) => new SmokeAgentLane(`retry_${caller}`, [{
        name: "subagent", args: () => ({ agent, task: prompt(child) }), terminal: () => final(child),
      }], () => final(caller));
      const owner = depth === 2 ? dispatch(`${name}_owner`, leafAgent, leafName) : undefined;
      if (owner) lanes.set(`${name}_owner`, owner);
      const dispatcher = depth ? dispatch(name, depth === 2 ? ownerAgent : leafAgent, depth === 2 ? `${name}_owner` : leafName) : undefined;
      if (dispatcher) lanes.set(name, dispatcher);
      const item = { name, depth, prompt: prompt(name), final: final(name), counter, leaf, owner, dispatcher };
      cases.push(item);
      return item;
    },
    writeAgents(agentDir: string) {
      mkdirSync(join(agentDir, "agents"), { recursive: true });
      for (const [name, tools, children] of [[leafAgent, [shell], []], [ownerAgent, ["subagent"], [leafAgent]]] as const) {
        writeFileSync(join(agentDir, "agents", `${name}.md`), ["---", `name: ${name}`,
          "description: Isolated LLM retry acceptance fixture", "enable: true", `tools: ${JSON.stringify(tools)}`,
          "skills: [specialist-handoff]", `subagents: ${JSON.stringify(children)}`, "---",
          "Perform the supplied isolated acceptance task; preserve completed tool results and return its exact completion marker.", ""].join("\n"));
      }
    },
    async respond(request: SmokeAgentRequest): Promise<Response> {
      requests++;
      try {
        const lane = laneFor(request);
        assert(lane, "Unexpected LLM retry fixture request");
        return llmRetryFixtureResponse(await lane.select(request));
      } catch (error) {
        failure = error;
        return Response.json({ error: { message: String(error) } }, { status: 400 });
      }
    },
    release() { for (const lane of lanes.values()) if (lane instanceof RetryFixtureLane) lane.release(); },
  };
}

export type LlmRetryFixture = ReturnType<typeof createLlmRetryFixture>;

export function llmRetryFixtureResponse(action: RetryFixtureAction): Response {
  if (action.kind === "failure") return Response.json({ error: { message: action.message, type: "server_error" } }, { status: 503 });
  const delta = action.kind === "tool" ? { role: "assistant", tool_calls: [{ index: 0, id: action.id, type: "function",
    function: { name: action.name, arguments: action.arguments } }] } : { role: "assistant", content: action.text };
  const chunks = [
    { delta, finish_reason: null },
    { delta: {}, finish_reason: action.kind === "tool" ? "tool_calls" : "stop" },
  ].map(choice => ({ id: "llm-retry-fixture", object: "chat.completion.chunk", created: 1, model: "smoke-model",
    choices: [{ index: 0, ...choice }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } });
}
