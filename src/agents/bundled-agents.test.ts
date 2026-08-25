import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentCatalog, resolveAgentCatalog, type AgentConfig } from "../subagent/agents";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-bundled-agents-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("bundled agent definitions", () => {
  it("loads the role-specific capability and dispatch boundaries", async () => {
    const catalog = await loadAgentCatalog({
      agentDir: join(root, "agent"),
    });
    const { agents } = resolveAgentCatalog(catalog, {
      agentDir: join(root, "agent"),
      cwd: join(root, "project"),
      homeDir: join(root, "home"),
    });
    const byName = Object.fromEntries(agents.map((agent) => [agent.name, agent])) as Record<string, AgentConfig>;

    expect(byName.search!.subagents).toEqual([]);
    expect(byName.experiment!.subagents).toEqual(["search"]);
    expect(byName.writing!.subagents).toEqual(["search", "figures"]);
    expect(byName.figures!.effectiveSkills).toEqual(expect.arrayContaining(["drawio", "drawio-academic-skills"]));
    expect(byName["research-assistant"]!.effectiveTools).toEqual(
      expect.arrayContaining(["read", "bash", "edit", "write", "subagent", "web-search", "webfetch"]),
    );
    expect(byName["research-assistant"]!.effectiveSkills).toContain("autoresearch");
    expect(byName.experiment!.effectiveSkills).not.toContain("autoresearch");
    expect(byName["research-assistant"]!.effectiveSkills).toContain("remote-experiment-preflight");
    expect(byName.search!.effectiveSkills).toContain("paper-material-package");
    expect(byName.writing!.effectiveSkills).toContain("survey-paper-writing");
    expect(byName.experiment!.effectiveSkills).toContain("ssh-experiment");
    expect(byName.experiment!.effectiveSkills).not.toContain("remote-experiment-preflight");
    expect(byName["research-assistant"]!.effectiveSkills).not.toContain("ssh-experiment");
    expect(byName["research-assistant"]!.effectiveTools).toContain("ssh-bash");
    expect(byName.experiment!.effectiveTools).toContain("ssh-bash");
    expect(byName.search!.effectiveTools).not.toContain("ssh-bash");
    expect(byName.writing!.effectiveTools).not.toContain("ssh-bash");
    expect(byName.figures!.effectiveTools).not.toContain("ssh-bash");
  });

  it("gives every bundled agent web tools and the playwright-cli skill, and never grep/find/ls (ADR-068)", async () => {
    const catalog = await loadAgentCatalog({
      agentDir: join(root, "agent"),
    });
    const { agents } = resolveAgentCatalog(catalog, {
      agentDir: join(root, "agent"),
      cwd: join(root, "project"),
      homeDir: join(root, "home"),
    });
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(agent.effectiveTools).toEqual(expect.arrayContaining(["web-search", "webfetch"]));
      expect(agent.effectiveTools).not.toEqual(expect.arrayContaining(["grep", "find", "ls"]));
      expect(agent.effectiveSkills).toContain("playwright-cli");
    }
  });
});
