import assert from "node:assert/strict";
import type { AgentDto } from "../src/web/contracts";
import { nativeLocalShellTool, normalizeLocalShellTools } from "../src/runtime/platform-tools";
import { assertPathFreeSessionEvent, isSmokeSessionReadyAfter, recordSmokeSessionActivityReplacement, type SmokeSessionActivityTracker } from "./smoke-release-support";

export interface MemorySmokeRequest {
  tools?: Array<{ function?: { name?: string; description?: string } }>;
  messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
}
export type MemorySmokeAction =
  | { kind: "tool"; id: string; name: string; arguments: string }
  | { kind: "text"; text: string };
export interface MemorySmokeStep {
  name: string;
  args: () => unknown;
  accept?: (text: string) => void;
  terminal?: () => string;
  errorCode?: string;
}
export interface MemorySmokeCall {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  errorCode?: string;
}
export function memorySmokeText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(memorySmokeText).join("\n");
  if (content && typeof content === "object" && "text" in content) return memorySmokeText(content.text);
  return "";
}

/** Test-provider response script, never a product runtime or workflow store. */
export class MemorySmokeLane {
  private index = 0;
  private pending?: MemorySmokeCall;
  private requests = 0;
  complete = false;
  readonly calls: MemorySmokeCall[] = [];
  readonly dispatches: Array<{ callId: string; agentId: string; terminal: string }> = [];

  constructor(readonly name: string, private steps: MemorySmokeStep[], private finalText: () => string) {}

  select(request: MemorySmokeRequest): MemorySmokeAction {
    assert(!this.complete, `${this.name} response sequence already complete`);
    assert(++this.requests <= this.steps.length * 3 + 12, `${this.name} provider request budget exceeded`);
    if (this.pending) {
      const call = this.pending;
      const step = this.steps[this.index]!;
      const results = request.messages?.filter(message => message.role === "tool" && message.tool_call_id === call.id) ?? [];
      assert.equal(results.length, 1, `${this.name} expected exactly one result for ${call.id}`);
      const text = memorySmokeText(results[0]!.content);
      if (step.terminal) {
        const match = /^([a-zA-Z0-9_-]+) is working\.$/u.exec(text);
        assert(match, `${this.name} missing normal materialization acknowledgement: ${text}`);
        const agentId = match[1]!;
        const notifications = request.messages?.filter(message => message.role === "user")
          .map(message => memorySmokeText(message.content).replaceAll("\r\n", "\n"))
          .filter(content => content.includes(`<agent_status>`) && content.includes(`Complete subagent:${agentId}\n`)) ?? [];
        if (notifications.length === 0) {
          assert(!request.messages?.some(message => message.role === "user"
            && memorySmokeText(message.content).includes(`Error subagent:${agentId}`)), `${agentId} failed`);
          return { kind: "text", text: `Awaiting owned terminal handoff from ${agentId}.` };
        }
        assert.equal(notifications.length, 1, `${agentId} duplicate terminal handoff`);
        const notification = notifications[0]!;
        const terminal = step.terminal();
        assert(notification.includes(`<agent_handoff>\nAgent: ${agentId}\nResult: ${terminal}\n</agent_handoff>`), `${agentId} terminal handoff mismatch`);
        assert(!notification.includes("session_path"), "successful handoff disclosed a private session path");
        this.dispatches.push({ callId: call.id, agentId, terminal });
      }
      if (step.errorCode) assert(text.startsWith(`${step.errorCode}:`), `${call.id} expected ${step.errorCode} denial, got ${text}`);
      step.accept?.(text);
      call.result = text;
      this.pending = undefined;
      this.index++;
    }
    const step = this.steps[this.index];
    if (!step) {
      this.complete = true;
      return { kind: "text", text: this.finalText() };
    }
    assert.equal(request.tools?.filter(tool => tool.function?.name === step.name).length, 1, `missing or duplicate tool ${step.name}`);
    const call: MemorySmokeCall = {
      id: `rsi_${this.name}_${this.index}`, name: step.name, arguments: JSON.stringify(step.args()),
      ...(step.errorCode ? { errorCode: step.errorCode } : {}),
    };
    this.calls.push(call);
    this.pending = call;
    return { kind: "tool", ...call };
  }
}

/** Only root activity advances readiness; nested child activity is still validated. */
export class MemorySmokeObservation {
  readonly acknowledgements = new Map<string, string>();
  readonly terminals = new Set<string>();
  private activity: SmokeSessionActivityTracker = { sequence: 0 };
  private finalBaseline?: number;
  constructor(private finalText: string, private expectedChildren: number) {}

  observe(event: unknown): void {
    assertPathFreeSessionEvent(event);
    const value = event as { type?: string; toolName?: string; toolCallId?: string; isError?: boolean;
      result?: { content?: unknown }; message?: { role?: string; content?: unknown }; agentId?: string; status?: string };
    if (value.type === "tool_execution_end" && value.toolName === "subagent") {
      assert(!value.isError, "RSI child launch failed");
      const match = /^([a-zA-Z0-9_-]+) is working\.$/u.exec(memorySmokeText(value.result?.content));
      assert(match && value.toolCallId, "missing materialization acknowledgement");
      assert(!this.acknowledgements.has(match[1]!), "duplicate materialization acknowledgement");
      this.acknowledgements.set(match[1]!, value.toolCallId);
    }
    if (value.type === "subagent_supervisor") {
      assert(value.status !== "error", `RSI supervisor error for ${value.agentId}`);
      if (value.status === "complete") {
        assert(value.agentId && this.acknowledgements.has(value.agentId), "terminal before materialization acknowledgement");
        this.terminals.add(value.agentId);
      }
    }
    if (value.type === "message_end" && value.message?.role === "assistant" && memorySmokeText(value.message.content) === this.finalText) {
      assert.equal(this.acknowledgements.size, this.expectedChildren, "root ended before all acknowledgements");
      assert.equal(this.terminals.size, this.expectedChildren, "root ended before owned terminal completion");
      this.finalBaseline = this.activity.sequence;
    }
    if (value.type === "session_activity_changed") this.activity = recordSmokeSessionActivityReplacement(this.activity, event);
  }

  get ready(): boolean { return this.finalBaseline !== undefined && isSmokeSessionReadyAfter(this.activity, this.finalBaseline); }
}

export function assertResearchMemoryCapabilities(value: unknown, platform: NodeJS.Platform): void {
  assert(Array.isArray(value), "Agent catalog must be an array");
  const shell = nativeLocalShellTool(platform);
  const excluded = shell === "bash" ? "powershell" : "bash";
  const roles = ["research-assistant", "search", "experiment", "writing", "figures", "review"];
  const byName = new Map<string, AgentDto>();
  for (const name of roles) {
    const matches: AgentDto[] = value.filter((row: AgentDto) => row.name === name);
    assert.equal(matches.length, 1, `bundled role ${name} missing or duplicated`);
    const row = matches[0] as AgentDto;
    byName.set(name, row);
    assert(row.builtin && row.enabled && row.source === "bundled", `${name} must resolve to enabled bundled metadata`);
    if (name !== "research-assistant") {
      assert(row.tools && row.tools.length > 0, `${name} must retain a strict tool allowlist`);
      assert.deepEqual(new Set(row.effectiveTools), new Set(normalizeLocalShellTools(row.tools, platform)), `${name} effective tools must match its configured allowlist`);
    }
    assert(row.skills && row.skills.length > 0, `${name} must retain a configured Skill allowlist`);
    assert.deepEqual(new Set(row.effectiveSkills), new Set(row.skills), `${name} effective Skills must match its configured allowlist`);
    for (const tool of ["read", "write", shell, "web-search", "webfetch", "research-memory"]) {
      assert(row.effectiveTools.includes(tool), `${name} missing ${tool}`);
    }
    for (const tool of [excluded, "grep", "find", "ls"]) assert(!row.effectiveTools.includes(tool), `${name} leaked ${tool}`);
    assert.equal(row.effectiveTools.includes("ssh-bash"), name === "research-assistant" || name === "experiment", `${name} SSH boundary`);
    assert.equal(row.effectiveTools.includes("subagent"), name !== "search", `${name} dispatch boundary`);
    assert(row.effectiveSkills.includes("research-experience"), `${name} missing shared experience Skill`);
    assert.equal(row.effectiveSkills.includes("recursive-self-improvement"), name === "research-assistant", `${name} RSI boundary`);
    assert.equal(row.effectiveSkills.includes("specialist-handoff"), name !== "research-assistant", `${name} handoff boundary`);
    assert.deepEqual(row.missingSkills, [], `${name} unresolved Skills`);
  }
  assert.deepEqual(byName.get("search")!.subagents, []);
  for (const name of ["review", "figures", "experiment"]) assert.deepEqual(byName.get(name)!.subagents, ["search"]);
  assert.deepEqual(new Set(byName.get("writing")!.subagents), new Set(["search", "figures"]));
  const review = byName.get("review")!;
  assert(!review.effectiveTools.includes("edit"), "Review must not edit specialist sources");
  for (const skill of ["peer-review", "paper-lookup", "arxiv", "playwright-cli"]) assert(review.effectiveSkills.includes(skill), `Review missing ${skill}`);
}
