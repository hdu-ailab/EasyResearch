import assert from "node:assert/strict";
import type { AgentDto } from "../src/web/contracts";
import { nativeLocalShellTool, normalizeLocalShellTools } from "../src/runtime/platform-tools";

export interface SmokeAgentRequest {
  tools?: Array<{ function?: { name?: string; description?: string } }>;
  messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
}
export type SmokeAgentAction =
  | { kind: "tool"; id: string; name: string; arguments: string }
  | { kind: "text"; text: string };
export interface SmokeAgentStep {
  name: string;
  args: () => unknown;
  accept?: (text: string) => void;
  terminal?: () => string;
  errorCode?: string;
}
export interface SmokeAgentCall {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  errorCode?: string;
}
export function smokeAgentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(smokeAgentText).join("\n");
  if (content && typeof content === "object" && "text" in content) return smokeAgentText(content.text);
  return "";
}

/** Test-provider response script, never a product runtime or workflow store. */
export class SmokeAgentLane {
  private index = 0;
  private pending?: SmokeAgentCall;
  private requests = 0;
  complete = false;
  readonly calls: SmokeAgentCall[] = [];
  readonly dispatches: Array<{ callId: string; agentId: string; terminal: string }> = [];

  constructor(readonly name: string, private steps: SmokeAgentStep[], private finalText: () => string) {}

  select(request: SmokeAgentRequest): SmokeAgentAction {
    assert(!this.complete, `${this.name} response sequence already complete`);
    assert(++this.requests <= this.steps.length * 3 + 12, `${this.name} provider request budget exceeded`);
    if (this.pending) {
      const call = this.pending;
      const step = this.steps[this.index]!;
      const results = request.messages?.filter(message => message.role === "tool" && message.tool_call_id === call.id) ?? [];
      assert.equal(results.length, 1, `${this.name} expected exactly one result for ${call.id}`);
      const text = smokeAgentText(results[0]!.content);
      if (step.terminal) {
        const match = /^([a-zA-Z0-9_-]+) is working\.$/u.exec(text);
        assert(match, `${this.name} missing normal materialization acknowledgement: ${text}`);
        const agentId = match[1]!;
        const notifications = request.messages?.filter(message => message.role === "user")
          .map(message => smokeAgentText(message.content).replaceAll("\r\n", "\n"))
          .filter(content => content.includes(`<agent_status>`) && content.includes(`Complete subagent:${agentId}\n`)) ?? [];
        if (notifications.length === 0) {
          assert(!request.messages?.some(message => message.role === "user"
            && smokeAgentText(message.content).includes(`Error subagent:${agentId}`)), `${agentId} failed`);
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
    const call: SmokeAgentCall = {
      id: `smoke_${this.name}_${this.index}`, name: step.name, arguments: JSON.stringify(step.args()),
      ...(step.errorCode ? { errorCode: step.errorCode } : {}),
    };
    this.calls.push(call);
    this.pending = call;
    return { kind: "tool", ...call };
  }
}

export function assertBundledAgentCapabilities(value: unknown, platform: NodeJS.Platform): void {
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
    if (name !== "research-assistant") {
      assert(row.skills && row.skills.length > 0, `${name} must retain a configured Skill allowlist`);
      assert.deepEqual(new Set(row.effectiveSkills), new Set(row.skills), `${name} effective Skills must match its configured allowlist`);
    }
    for (const tool of ["read", "write", shell, "web-search", "webfetch"]) {
      assert(row.effectiveTools.includes(tool), `${name} missing ${tool}`);
    }
    for (const tool of [excluded, "grep", "find", "ls"]) assert(!row.effectiveTools.includes(tool), `${name} leaked ${tool}`);
    assert.equal(row.effectiveTools.includes("ssh-bash"), name === "research-assistant" || name === "experiment", `${name} SSH boundary`);
    assert.equal(row.effectiveTools.includes("subagent"), name !== "search", `${name} dispatch boundary`);
    assert(!row.effectiveTools.includes("research-memory"), `${name} exposes a retired tool`);
    for (const retired of ["research-experience", "recursive-self-improvement"]) {
      assert(!row.effectiveSkills.includes(retired), `${name} exposes a retired Skill`);
    }
    assert(row.effectiveSkills.includes("specialist-handoff"), `${name} missing document recovery/handoff Skill`);
    assert.deepEqual(row.missingSkills, [], `${name} unresolved Skills`);
  }
  assert.deepEqual(byName.get("search")!.subagents, []);
  const main = byName.get("research-assistant")!;
  assert(!main.skills?.length && !main.tools?.length, "main Agent must load all controlled capabilities");
  for (const row of byName.values()) {
    for (const skill of row.effectiveSkills) assert(main.effectiveSkills.includes(skill), `main Agent missing ${skill}`);
  }
  for (const name of ["review", "figures", "experiment"]) assert.deepEqual(byName.get(name)!.subagents, ["search"]);
  assert.deepEqual(new Set(byName.get("writing")!.subagents), new Set(["search", "figures"]));
  const review = byName.get("review")!;
  assert(!review.effectiveTools.includes("edit"), "Review must not edit specialist sources");
  for (const skill of ["peer-review", "paper-lookup", "arxiv", "playwright-cli"]) assert(review.effectiveSkills.includes(skill), `Review missing ${skill}`);
}
