import assert from "node:assert/strict";
import type { AgentDto } from "../src/web/contracts";
import { nativeLocalShellTool, normalizeLocalShellTools } from "../src/runtime/platform-tools";

export interface SmokeAgentRequest {
  tools?: Array<{ function?: { name?: string; description?: string } }>;
  messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string; details?: unknown }>;
}
export type SmokeAgentAction =
  | { kind: "tool"; id: string; name: string; arguments: string }
  | { kind: "text"; text: string };
export interface SmokeAgentStep {
  name: string;
  args: () => unknown;
  accept?: (text: string) => void;
  terminal?: () => string;
  /** Retry fixtures only: validate known exhausted periods before waiting for recovery. */
  acceptErrorPeriod?: (report: SmokeBackgroundReport) => void;
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

export function smokeSubagentSessionID(result: { content?: unknown; details?: unknown }): string {
  const details = result.details as { sessionID?: unknown; job?: { childSessionId?: unknown } } | undefined;
  // Provider wire messages carry text only; saved native tool results retain details.
  const sessionID = details?.sessionID ?? details?.job?.childSessionId
    ?? /\(sessionID: ([a-f0-9-]+)\)/iu.exec(smokeAgentText(result.content))?.[1];
  assert(typeof sessionID === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(sessionID),
    "native smoke subagent admission did not return a native sessionID");
  if (details?.sessionID && details.job?.childSessionId) assert.equal(details.sessionID, details.job.childSessionId);
  return sessionID;
}

export interface SmokeBackgroundReport {
  kind: "subagent" | "shell";
  sessionID?: string;
  id?: string;
  state: "running" | "completed" | "cancelled" | "error";
  text: string;
}

export function smokeBackgroundReports(request: Pick<SmokeAgentRequest, "messages">): SmokeBackgroundReport[] {
  const reports: SmokeBackgroundReport[] = [];
  for (const message of request.messages ?? []) {
    if (message.role !== "user") continue;
    const content = smokeAgentText(message.content).replaceAll("\r\n", "\n").trim();
    if (!content.startsWith("<background-result")) continue;
    const match = /^<background-result\s+([^>]+)>\n?([\s\S]*?)\n?<\/background-result>$/u.exec(content);
    assert(match, "native smoke received a malformed background result boundary");
    const attributes = Object.fromEntries([...match[1]!.matchAll(/([\w-]+)="([^"]*)"/gu)].map(item => [item[1], item[2]]));
    assert(attributes.kind === "subagent" || attributes.kind === "shell", "native smoke received an unknown background result kind");
    assert(["running", "completed", "cancelled", "error"].includes(attributes.state!), "native smoke received an invalid background result state");
    assert(attributes.kind === "subagent" ? attributes.sessionID : attributes.id, "native smoke background result is missing its identity");
    reports.push({ kind: attributes.kind, sessionID: attributes.sessionID, id: attributes.id,
      state: attributes.state as SmokeBackgroundReport["state"], text: match[2]!.trim() });
  }
  return reports;
}

/** Test-provider response script, never a product runtime or workflow store. */
export class SmokeAgentLane {
  private index = 0;
  private pending?: SmokeAgentCall;
  private requests = 0;
  private cancellationExpected = false;
  complete = false;
  readonly calls: SmokeAgentCall[] = [];
  readonly dispatches: Array<{ callId: string; sessionID: string; terminal: string }> = [];

  constructor(readonly name: string, private steps: SmokeAgentStep[], private finalText: () => string) {}

  expectCancellation(): void { this.cancellationExpected = true; }

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
        const sessionID = smokeSubagentSessionID(results[0]!);
        const reports = smokeBackgroundReports(request).filter(report => report.kind === "subagent" && report.sessionID === sessionID);
        for (const report of reports.filter(report => report.state === "error")) {
          assert(step.acceptErrorPeriod, `${sessionID} failed`);
          step.acceptErrorPeriod(report);
        }
        if (this.cancellationExpected && reports.some(report => report.state === "cancelled")) {
          assert.equal(reports.filter(report => report.state === "cancelled").length, 1, "Duplicate task cancellation notice");
          this.complete = true;
          return { kind: "text", text: "Acceptance task cancellation observed." };
        }
        assert(!reports.some(report => report.state === "cancelled"), `${sessionID} failed`);
        const notifications = reports.filter(report => report.state === "completed");
        if (notifications.length === 0) {
          return { kind: "text", text: `Awaiting owned terminal handoff from ${sessionID}.` };
        }
        assert.equal(notifications.length, 1, `${sessionID} duplicate terminal handoff`);
        const notification = notifications[0]!;
        const terminal = step.terminal();
        assert.equal(notification.text, terminal, `${sessionID} terminal handoff mismatch`);
        assert(!notification.text.includes("session_path"), "successful handoff disclosed a private session path");
        this.dispatches.push({ callId: call.id, sessionID, terminal });
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
    for (const tool of ["bash", "powershell", "grep", "find", "ls"]) assert(!row.effectiveTools.includes(tool), `${name} leaked ${tool}`);
    assert.equal(row.effectiveTools.includes("ssh-bash"), name === "research-assistant" || name === "experiment", `${name} SSH boundary`);
    assert.equal(row.effectiveTools.includes("subagent"), name !== "search", `${name} dispatch boundary`);
    assert.equal(row.effectiveTools.includes("models"), name !== "search", `${name} model discovery boundary`);
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
