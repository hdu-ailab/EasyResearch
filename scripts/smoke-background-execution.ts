import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildSessionSnapshotDto, SessionSnapshotDto } from "../src/web/contracts";
import type { SshConnectionConfig } from "../src/extensions/ssh-bash/runtime";
import type { ShellOutputDto } from "../src/background/contracts";
import { smokeAgentText, smokeBackgroundReports, smokeSubagentSessionID, type SmokeAgentAction, type SmokeAgentRequest } from "./smoke-agent-scenario";
import { requestSmokeJsonBeforeDeadline, venvToolCommand } from "./smoke-release-support";

export type BackgroundSmokeMode = "explicit" | "promotion";
const modes: BackgroundSmokeMode[] = ["explicit", "promotion"];

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitBounded(promise: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Native background smoke timed out awaiting ${label}`)), 20_000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Scripted provider only: gates are released by observed causal evidence, never sleeps. */
export function createBackgroundExecutionSmoke(options: {
  runId: string;
  agentName: string;
  command(mode: BackgroundSmokeMode): string;
  shellToolName?: "shell" | "ssh-bash";
  sshConfiguration?: SshConnectionConfig;
  forbiddenText?: readonly string[];
}) {
  const shellToolName = options.shellToolName ?? "shell";
  const runArguments = shellToolName === "ssh-bash" ? { action: "run" } : {};
  const prefix = `BACKGROUND_SMOKE_${options.runId}:`;
  const prompt = (role: "root" | "child" | "followup") => `${prefix}${role}`;
  const hasInput = (request: SmokeAgentRequest, role: "root" | "child" | "followup") =>
    request.messages?.some(message => {
      if (message.role !== "user") return false;
      const text = smokeAgentText(message.content).replaceAll("\r\n", "\n").trim();
      return text === prompt(role) || (role === "child" && text === `You are a subagent spawned by another session.\n${prompt(role)}`);
    }) ?? false;
  const final = (role: "root" | "child") => `BACKGROUND_COMPLETE_${options.runId}_${role}`;
  const marker = (mode: BackgroundSmokeMode) => `BACKGROUND_PROCESS_${options.runId}_${mode}`;
  const waiting = (mode: BackgroundSmokeMode) => `Child awaiting ${mode} shell completion.`;
  const gatePath = (mode: BackgroundSmokeMode) => `/background-smoke/${encodeURIComponent(options.runId)}/${mode}`;
  const firstChildRequest = gate();
  const followupAdmission = gate();
  const shellGates = { explicit: gate(), promotion: gate() };
  const gateCalls = { explicit: 0, promotion: 0 };
  const shellIDs: Partial<Record<BackgroundSmokeMode, string>> = {};
  const released = new Set<BackgroundSmokeMode>();
  let rootStep = options.sshConfiguration ? -3 : 0;
  let childStep = 0;
  let requests = 0;
  let childFirstResponseReturned = false;
  let failure: unknown;
  const evidence = {
    childSessionID: undefined as string | undefined,
    earlyAdmission: false, runningFollowup: false, explicitCompletion: false,
    promotionCompletion: false, runningPeriods: 0, complete: false,
  };
  const resultFor = (request: SmokeAgentRequest, id: string) => {
    const results = request.messages?.filter(message => message.role === "tool" && message.tool_call_id === id) ?? [];
    assert.equal(results.length, 1, `background smoke expected exactly one tool result for ${id}`);
    return results[0]!;
  };
  const tool = (request: SmokeAgentRequest, id: string, name: string, args: unknown): SmokeAgentAction => {
    assert.equal(request.tools?.filter(entry => entry.function?.name === name).length, 1, `missing background smoke tool ${name}`);
    return { kind: "tool", id, name, arguments: JSON.stringify(args) };
  };
  const acknowledgeShell = (request: SmokeAgentRequest, mode: BackgroundSmokeMode) => {
    const result = resultFor(request, `background_${mode}`);
    const text = smokeAgentText(result.content);
    const shellID = (result.details as { shellID?: string } | undefined)?.shellID
      ?? /\(shell ID: ([a-zA-Z0-9_-]+)\)/u.exec(text)?.[1];
    assert(shellID, `${mode} command did not return a managed background shell ID`);
    assert(!text.split(/\r?\n/u).includes(marker(mode)), `${mode} command completed before its background acknowledgement`);
    if (mode === "promotion") assert.notEqual(shellID, shellIDs.explicit, "two commands reused one shell identity");
    shellIDs[mode] = shellID;
  };
  const requireShellCompletion = (request: SmokeAgentRequest, mode: BackgroundSmokeMode) => {
    const reports = smokeBackgroundReports(request).filter(report => report.kind === "shell" && report.id === shellIDs[mode]);
    assert.equal(reports.length, 1, `${mode} shell completion was not delivered exactly once to its owning child`);
    assert.equal(reports[0]!.state, "completed", `${mode} shell failed`);
    assert.equal(reports[0]!.text, marker(mode), `${mode} shell output/exit status did not match`);
  };

  return {
    prompt, final, marker, gatePath, evidence, gateCalls, shellIDs, shellToolName, command: options.command,
    get failure() { return failure; },
    get requests() { return requests; },
    matches(request: SmokeAgentRequest) {
      return hasInput(request, "root") || hasInput(request, "child") || hasInput(request, "followup");
    },
    gate(path: string): Promise<Response> | undefined {
      const mode = modes.find(mode => path === gatePath(mode));
      if (!mode) return undefined;
      return (async () => {
        try {
          assert.equal(++gateCalls[mode], 1, `${mode} background process was launched more than once`);
          await waitBounded(shellGates[mode].promise, `${mode} child idle report`);
          return new Response("released");
        } catch (error) { failure = error; return new Response(String(error), { status: 500 }); }
      })();
    },
    async select(request: SmokeAgentRequest): Promise<SmokeAgentAction> {
      try {
        assert(!options.forbiddenText?.some(secret => secret && JSON.stringify(request).includes(secret)), "Background smoke provider context exposed credential contents");
        assert(++requests <= 24, "background smoke provider request budget exceeded");
        const root = hasInput(request, "root");
        const child = hasInput(request, "child") || hasInput(request, "followup");
        assert(root !== child, "Background smoke request has no unambiguous native input owner");
        if (root) {
          const reports = smokeBackgroundReports(request);
          assert(!reports.some(report => report.kind === "shell"), "Shell completion leaked to root instead of its owning child");
          if (rootStep === -3) {
            rootStep = -2;
            return tool(request, "background_ssh_configure", "ssh-bash", { action: "configure", ...options.sshConfiguration });
          }
          if (rootStep === -2) {
            assert(smokeAgentText(resultFor(request, "background_ssh_configure").content).includes("configured and tested"), "Compiled SSH configuration did not succeed");
            rootStep = -1;
            return tool(request, "background_ssh_test", "ssh-bash", { action: "test" });
          }
          if (rootStep === -1) {
            assert(smokeAgentText(resultFor(request, "background_ssh_test").content).includes("test passed"), "Compiled SSH connection test did not succeed");
            rootStep = 0;
          }
          if (rootStep === 0) {
            rootStep = 1;
            return tool(request, "background_dispatch", "subagent", {
              agent: options.agentName, description: "Verify owned background execution", prompt: prompt("child"),
            });
          }
          const sessionID = smokeSubagentSessionID(resultFor(request, "background_dispatch"));
          if (evidence.childSessionID) assert.equal(sessionID, evidence.childSessionID);
          evidence.childSessionID = sessionID;
          if (rootStep === 1) {
            assert(!childFirstResponseReturned, "Child inference completed before durable admission was observed");
            evidence.earlyAdmission = true;
            await waitBounded(firstChildRequest.promise, "first child inference entry");
            rootStep = 2;
            return tool(request, "background_followup", "subagent", {
              agent: options.agentName, description: "Steer active background child", prompt: prompt("followup"), sessionID,
            });
          }
          assert.equal(smokeSubagentSessionID(resultFor(request, "background_followup")), sessionID, "Follow-up created another child");
          if (rootStep === 2) {
            assert(!childFirstResponseReturned, "Running follow-up was not admitted before the first child response");
            evidence.runningFollowup = true;
            followupAdmission.resolve();
            rootStep = 3;
          }
          const own = reports.filter(report => report.kind === "subagent" && report.sessionID === sessionID);
          assert(!own.some(report => report.state === "error" || report.state === "cancelled"), "Background smoke child failed");
          for (const mode of modes) {
            const periods = own.filter(report => report.text.startsWith(waiting(mode)));
            assert(periods.length <= 1, `Duplicate ${mode} busy-period report`);
            if (periods.length && !released.has(mode)) {
              assert.equal(periods[0]!.state, "running", "Idle child falsely reported subtree completion");
              assert(shellIDs[mode] && periods[0]!.text.includes(`shell (${shellIDs[mode]}`), "Idle report omitted the outstanding owned shell");
              released.add(mode);
              evidence.runningPeriods++;
              shellGates[mode].resolve();
            }
          }
          const terminal = own.filter(report => report.state === "completed" && report.text === final("child"));
          assert(terminal.length <= 1, "Duplicate child terminal report");
          if (terminal.length) {
            assert(evidence.earlyAdmission && evidence.runningFollowup && evidence.explicitCompletion
              && evidence.promotionCompletion && evidence.runningPeriods === 2, "Background acceptance evidence is incomplete");
            evidence.complete = true;
            return { kind: "text", text: final("root") };
          }
          return { kind: "text", text: "Background acceptance is awaiting owned completion." };
        }

        assert(request.tools?.some(entry => entry.function?.name === shellToolName), "Child lost its shell capability");
        if (childStep === 0) {
          firstChildRequest.resolve();
          await waitBounded(followupAdmission.promise, "running direct-child follow-up admission");
          childFirstResponseReturned = true;
          childStep = 1;
          return tool(request, "background_explicit", shellToolName, { ...runArguments, command: options.command("explicit"), background: true, timeout: 30_000 });
        }
        assert(hasInput(request, "followup"), "Running follow-up did not reach the child");
        if (childStep === 1) {
          acknowledgeShell(request, "explicit");
          childStep = 2;
          return { kind: "text", text: waiting("explicit") };
        }
        if (childStep === 2) {
          requireShellCompletion(request, "explicit");
          evidence.explicitCompletion = true;
          childStep = 3;
          return tool(request, "background_promotion", shellToolName, { ...runArguments, command: options.command("promotion"), timeout: 1 });
        }
        if (childStep === 3) {
          acknowledgeShell(request, "promotion");
          childStep = 4;
          return { kind: "text", text: waiting("promotion") };
        }
        assert.equal(childStep, 4, "Child executed again after final completion");
        requireShellCompletion(request, "promotion");
        evidence.promotionCompletion = true;
        childStep = 5;
        return { kind: "text", text: final("child") };
      } catch (error) { failure = error; throw error; }
    },
    release() {
      firstChildRequest.resolve();
      followupAdmission.resolve();
      for (const mode of modes) shellGates[mode].resolve();
    },
  };
}

type Scenario = ReturnType<typeof createBackgroundExecutionSmoke>;

export function writeBackgroundExecutionScripts(options: {
  directory: string; origin: string; scenario: Scenario;
}) {
  mkdirSync(options.directory, { recursive: true });
  for (const mode of modes) {
    writeFileSync(join(options.directory, `${mode}.py`), [
      "from pathlib import Path", "import urllib.request",
      `counter = Path(${JSON.stringify(join(options.directory, `${mode}.counter`))})`,
      'with counter.open("a", encoding="utf-8") as output:',
      `    output.write(${JSON.stringify(options.scenario.marker(mode) + "\n")})`,
      `with urllib.request.urlopen(${JSON.stringify(options.origin + options.scenario.gatePath(mode))}, timeout=30) as response:`,
      '    assert response.read() == b"released"',
      `print(${JSON.stringify(options.scenario.marker(mode))})`, "",
    ].join("\n"));
  }
}

export function backgroundSmokeCommand(platform: NodeJS.Platform, directory: string, mode: BackgroundSmokeMode) {
  return venvToolCommand(platform, join(directory, `${mode}.py`));
}

export function assertBackgroundInvocationReceipt(content: string, marker: string): void {
  // Python's text-mode append uses CRLF on Windows; normalization must retain
  // every record so a repeated command still fails the exact one-record check.
  assert.equal(content.replaceAll("\r\n", "\n"), marker + "\n", "Background command did not execute exactly once");
}

export async function runBackgroundExecutionSmoke(options: {
  base: string; project: string; directory: string; deadline: number; scenario: Scenario;
  remoteCommands?: readonly { command: string }[];
}) {
  const { scenario, deadline } = options;
  const json = (path: string, init?: RequestInit) => requestSmokeJsonBeforeDeadline({ url: `${options.base}${path}`, deadline, label: `background smoke ${path}`, init });
  const post = (path: string, body: unknown = {}) => json(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const created = await post("/api/sessions", { cwd: options.project }) as { id: string };
  assert(created.id);
  let primaryFailure: unknown;
  try {
    await post(`/api/sessions/${created.id}/messages`, { message: scenario.prompt("root") });
    let snapshot!: SessionSnapshotDto;
    for (;;) {
      if (scenario.failure) throw scenario.failure;
      assert(Date.now() < deadline, "Native background acceptance exceeded its deadline");
      snapshot = await json(`/api/sessions/${created.id}/snapshot`) as SessionSnapshotDto;
      if (scenario.evidence.complete && snapshot.session.status === "ready" && !snapshot.session.isStreaming
        && snapshot.timeline.some(entry => entry.kind === "message" && entry.message.role === "assistant" && smokeAgentText(entry.message.content) === scenario.final("root"))) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const admissions = snapshot.timeline.flatMap(entry => entry.kind === "message" && entry.message.role === "toolResult" && entry.message.toolName === "subagent" ? [entry.message] : []);
    assert.equal(admissions.length, 2, "Expected one fresh dispatch and one running follow-up");
    for (const admission of admissions) assert.equal(smokeSubagentSessionID(admission), scenario.evidence.childSessionID);
    const child = await json(`/api/sessions/${created.id}/subagents/${scenario.evidence.childSessionID}/snapshot`) as ChildSessionSnapshotDto;
    assert.equal(child.session.cwd, options.project, "Background child left the exact project cwd");
    const shells = child.timeline.flatMap(entry => entry.kind === "message" && entry.message.role === "toolResult" && entry.message.toolName === scenario.shellToolName ? [entry.message] : []);
    assert.equal(shells.length, 2, "Background promotion duplicated a shell tool invocation");
    for (const mode of modes) {
      assert.equal(scenario.gateCalls[mode], 1, `${mode} must execute exactly one real process`);
      const shellID = scenario.shellIDs[mode];
      assert(shellID, `${mode} has no owned output identity`);
      const outputPath = `/api/sessions/${created.id}/background/${encodeURIComponent(shellID)}/output`;
      const output = await json(outputPath) as ShellOutputDto;
      assert.equal(output.id, shellID);
      assert.equal(output.sessionID, scenario.evidence.childSessionID, "Shell output changed its native owner");
      assert.equal(output.command, scenario.command(mode));
      assert.equal(output.status, "completed");
      assert.equal(output.exitCode, 0);
      assert.equal(output.output.replaceAll("\r\n", "\n"), scenario.marker(mode) + "\n", "Retained shell output differs from command output");
      assert.equal(output.cursor, output.size, "Final output was not drained");
      assert.equal(output.size, Buffer.byteLength(output.output), "Output cursor is not a byte offset");
      assert(!("worker" in output) && !("file" in output) && !("token" in output), "Private shell custody leaked into output metadata");
      const delta = await json(`${outputPath}?cursor=${output.cursor}&limit=64`) as ShellOutputDto;
      assert.equal(delta.output, "", "Reading an already drained cursor duplicated output");
      assert.equal(delta.cursor, output.cursor);
      if (scenario.shellToolName === "ssh-bash") {
        assert(options.remoteCommands, "Remote acceptance requires SSH protocol execution receipts");
        assert.equal(options.remoteCommands.filter(command => command.command === scenario.command(mode)).length, 1, "Remote SSH command was replayed");
      } else {
        assertBackgroundInvocationReceipt(readFileSync(join(options.directory, `${mode}.counter`), "utf8"), scenario.marker(mode));
      }
    }
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    scenario.release();
    // Terminal stop owns the complete tree; no stale task snapshot can race cleanup.
    try { await post(`/api/sessions/${created.id}/stop`); }
    catch (cleanupError) {
      if (primaryFailure) throw new AggregateError([primaryFailure, cleanupError],
        `${String(primaryFailure)}; background acceptance cleanup also failed: ${String(cleanupError)}`);
      throw cleanupError;
    }
  }
}
