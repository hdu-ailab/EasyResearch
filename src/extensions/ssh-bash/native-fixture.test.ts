import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRemoteSshBackgroundSmoke } from "../../../scripts/smoke-ssh-background";
import { createSshBashRuntime } from "./runtime";
import { createSshExecutor } from "./executor";
import { createSshBashTool } from "./index";
import { createBackgroundExecutionSmoke } from "../../../scripts/smoke-background-execution";

describe("native SSH acceptance fixture", () => {
  it("routes only actual fixture input messages, not quoted tool instructions or report bodies", () => {
    const scenario = createBackgroundExecutionSmoke({ runId: "routing", agentName: "experiment", shellToolName: "ssh-bash", command: () => "fixture" });
    const marker = scenario.prompt("root");
    for (const role of ["system", "assistant", "tool"]) {
      expect(scenario.matches({ messages: [{ role, content: marker }] })).toBe(false);
    }
    expect(scenario.matches({ messages: [{ role: "user", content: `Quoted tool instructions: ${marker}` }] })).toBe(false);
    expect(scenario.matches({ messages: [{ role: "user", content: `<background-result kind="shell" id="other" state="completed">\n${marker}\n</background-result>` }] })).toBe(false);
    expect(scenario.matches({ messages: [{ role: "user", content: marker }] })).toBe(true);
    expect(scenario.matches({ messages: [{ role: "user", content: `You are a subagent spawned by another session.\n${scenario.prompt("child")}` }] })).toBe(true);
    scenario.release();
  });

  it("configures/tests through the registered tool and selects managed SSH run with native child continuation", async () => {
    const root = mkdtempSync(join(tmpdir(), "native-ssh-fixture-"));
    const project = join(root, "project");
    const agentDir = join(root, "agent");
    mkdirSync(project);
    const fixture = await createRemoteSshBackgroundSmoke({ runId: "test", project, agentDir,
      fixtureDirectory: join(root, "private-fixture") });
    try {
      const scenario = fixture.scenario;
      const tool = createSshBashTool({ allowConfigure: true, runtime: createSshBashRuntime({ execute: createSshExecutor() }) });
      const tools = ["subagent", "shell", "ssh-bash"].map(name => ({ function: { name } }));
      const messages: Array<{ role: string; content?: unknown; tool_call_id?: string; details?: unknown }> = [{ role: "user", content: scenario.prompt("root") }];
      for (const expected of ["configure", "test"]) {
        const action = await scenario.select({ tools, messages });
        if (action.kind !== "tool") throw new Error("Missing SSH preflight");
        expect(action.name).toBe("ssh-bash");
        const args = JSON.parse(action.arguments);
        expect(args.action).toBe(expected);
        const result = await tool.execute(action.id, args, undefined, undefined, { cwd: project } as never);
        messages.push({ role: "tool", tool_call_id: action.id, content: result.content, details: result.details });
      }
      const persisted = JSON.parse(readFileSync(join(project, ".easyresearch", "settings.json"), "utf8"));
      expect(persisted.easyresearch.ssh.authType).toBe("password");
      expect(persisted.easyresearch.ssh).not.toHaveProperty("password");
      const launch = await scenario.select({ tools, messages });
      if (launch.kind !== "tool") throw new Error("Missing dispatch");
      const childRequest = { tools: [{ function: { name: "ssh-bash" } }, { function: { name: "subagent" } }], messages: [
        { role: "user", content: `You are a subagent spawned by another session.\n${scenario.prompt("child")}` },
        { role: "user", content: `Quoted parent example: ${scenario.prompt("root")}` },
      ] };
      const child = scenario.select(childRequest);
      const sessionID = "62dcdf07-3e6c-4a0a-a2af-b7594efad8ca";
      messages.push({ role: "tool", tool_call_id: launch.id, content: "admitted", details: { sessionID } });
      const followup = await scenario.select({ tools, messages });
      if (followup.kind !== "tool") throw new Error("Missing follow-up");
      expect(JSON.parse(followup.arguments)).toMatchObject({ sessionID, agent: fixture.agentName });
      messages.push({ role: "tool", tool_call_id: followup.id, content: "admitted", details: { sessionID } });
      await scenario.select({ tools, messages });
      const run = await child;
      if (run.kind !== "tool") throw new Error("Missing remote run");
      expect(run.name).toBe("ssh-bash");
      expect(JSON.parse(run.arguments)).toMatchObject({ action: "run", background: true, timeout: 30_000 });
      const credential = readFileSync(join(root, "private-fixture", "ssh-password"), "utf8");
      expect(fixture.redact(`diagnostic ${credential}`)).toBe("diagnostic [redacted SSH credential]");
    } finally { await fixture.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
