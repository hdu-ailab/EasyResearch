import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents, type AgentConfig } from "../subagent/agents";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-bundled-agents-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("bundled agent definitions", () => {
  it("loads the role-specific capability and dispatch boundaries", async () => {
    const { agents } = await discoverAgents({
      agentDir: join(root, "agent"),
      cwd: join(root, "project"),
      homeDir: join(root, "home"),
      includeProject: false,
      includeGlobal: false,
    });
    const byName = Object.fromEntries(agents.map((agent) => [agent.name, agent])) as Record<string, AgentConfig>;

    expect(byName.search!.subagents).toEqual([]);
    expect(byName.experiment!.subagents).toEqual(["search"]);
    expect(byName.writing!.subagents).toEqual(["search", "figures"]);
    expect(byName.figures!.effectiveSkills).toEqual(expect.arrayContaining(["drawio", "drawio-academic-skills"]));
    expect(byName.assistant!.effectiveTools).toContain("subagent");
    expect(byName.assistant!.effectiveTools).not.toContain("write");
  });
});
