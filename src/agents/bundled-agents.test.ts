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
  it.each(["linux", "darwin", "win32"] as const)("gives the main Agent specialist capabilities without restoring retired evolution features on %s", async (platform) => {
    const agentDir = join(root, "agent");
    const catalog = await loadAgentCatalog({ agentDir });
    const { agents } = resolveAgentCatalog(catalog, {
      agentDir,
      cwd: join(root, "project"),
      homeDir: join(root, "home"),
      platform,
    });
    const main = agents.find((agent) => agent.name === "research-assistant")!;
    for (const agent of agents) {
      expect(agent.effectiveTools).not.toContain("research-memory");
      expect(agent.effectiveSkills).not.toContain("research-experience");
      expect(agent.effectiveSkills).not.toContain("recursive-self-improvement");
      expect(main.effectiveSkills).toEqual(expect.arrayContaining(agent.effectiveSkills));
      expect(main.effectiveTools).toEqual(expect.arrayContaining(agent.effectiveTools));
      expect(agent.missingSkills).toEqual([]);
    }
  });

  it("loads the role-specific capability and dispatch boundaries", async () => {
    const catalog = await loadAgentCatalog({
      agentDir: join(root, "agent"),
    });
    const { agents } = resolveAgentCatalog(catalog, {
      agentDir: join(root, "agent"),
      cwd: join(root, "project"),
      homeDir: join(root, "home"),
      platform: "linux",
    });
    const byName = Object.fromEntries(agents.map((agent) => [agent.name, agent])) as Record<string, AgentConfig>;

    expect(byName.search!.subagents).toEqual([]);
    expect(byName.experiment!.subagents).toEqual(["search"]);
    expect(byName.writing!.subagents).toEqual(["search", "figures"]);
    expect(byName.review!.subagents).toEqual(["search"]);
    expect(byName.figures!.subagents).toEqual(["search"]);
    expect(byName.search!.effectiveTools).not.toContain("subagent");
    expect(byName.search!.effectiveTools).not.toContain("models");
    expect(byName.figures!.effectiveSkills).toEqual(expect.arrayContaining(["drawio", "drawio-academic-skills"]));
    expect(byName.figures!.effectiveSkills).toContain("scientific-visualization");
    for (const name of ["search", "experiment", "writing", "figures"]) {
      expect(byName[name]!.effectiveSkills).toContain("specialist-handoff");
    }
    expect(byName["research-assistant"]!.effectiveSkills).toContain("specialist-handoff");
    expect(byName["research-assistant"]!.effectiveTools).toEqual(
      expect.arrayContaining(["read", "shell", "edit", "write", "subagent", "models", "web-search", "webfetch"]),
    );
    expect(byName["research-assistant"]!.effectiveSkills).toContain("autoresearch");
    expect(byName.experiment!.effectiveSkills).not.toContain("autoresearch");
    expect(byName["research-assistant"]!.effectiveSkills).toContain("remote-experiment-preflight");
    expect(byName.search!.effectiveSkills).toContain("paper-material-package");
    expect(byName.search!.effectiveSkills).toContain("paper-lookup");
    expect(byName.writing!.effectiveSkills).toContain("survey-paper-writing");
    expect(byName.experiment!.effectiveSkills).toContain("ssh-experiment");
    expect(byName.experiment!.effectiveSkills).toEqual(expect.arrayContaining([
      "hypothesis-generation",
      "experimental-design",
      "statistical-power",
      "huggingface-datasets",
    ]));
    expect(byName.experiment!.effectiveSkills).not.toContain("remote-experiment-preflight");
    expect(byName["research-assistant"]!.effectiveSkills).toContain("ssh-experiment");
    expect(byName["research-assistant"]!.effectiveTools).toContain("ssh-bash");
    expect(byName.experiment!.effectiveTools).toContain("ssh-bash");
    expect(byName.search!.effectiveTools).not.toContain("ssh-bash");
    expect(byName.writing!.effectiveTools).not.toContain("ssh-bash");
    expect(byName.figures!.effectiveTools).not.toContain("ssh-bash");
    expect(byName.review!.effectiveTools).toEqual(expect.arrayContaining([
      "read",
      "shell",
      "write",
      "subagent",
      "models",
      "web-search",
      "webfetch",
    ]));
    for (const tool of ["edit", "ssh-bash"]) expect(byName.review!.effectiveTools).not.toContain(tool);
    expect(byName.review!.effectiveSkills).toEqual(expect.arrayContaining([
      "peer-review",
      "paper-lookup",
      "arxiv",
      "specialist-handoff",
      "playwright-cli",
    ]));
  });

  it("gives every bundled agent web tools and the playwright-cli skill, and never grep/find/ls (ADR-068)", async () => {
    const catalog = await loadAgentCatalog({
      agentDir: join(root, "agent"),
    });
    const { agents } = resolveAgentCatalog(catalog, {
      agentDir: join(root, "agent"),
      cwd: join(root, "project"),
      homeDir: join(root, "home"),
      platform: "linux",
    });
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(agent.effectiveTools).toEqual(expect.arrayContaining(["web-search", "webfetch"]));
      for (const tool of ["grep", "find", "ls"]) expect(agent.effectiveTools).not.toContain(tool);
      expect(agent.effectiveSkills).toContain("playwright-cli");
    }
  });

  it.each(["win32", "linux", "darwin"] as const)("keeps managed shell and model discovery aligned with role capabilities on %s", async (platform) => {
    const catalog = await loadAgentCatalog({
      agentDir: join(root, "agent"),
    });
    const { agents } = resolveAgentCatalog(catalog, {
      agentDir: join(root, "agent"),
      cwd: join(root, "project"),
      homeDir: join(root, "home"),
      platform,
    });
    const researchAssistant = agents.find((agent) => agent.name === "research-assistant");

    for (const agent of agents) {
      expect(agent.effectiveTools.filter(tool => ["shell", "bash", "powershell"].includes(tool))).toEqual(["shell"]);
      expect(agent.effectiveTools.includes("models")).toBe(agent.effectiveTools.includes("subagent"));
      expect(new Set(agent.effectiveTools).size).toBe(agent.effectiveTools.length);
    }
    expect(researchAssistant?.effectiveTools).toContain("ssh-bash");
  });
});
