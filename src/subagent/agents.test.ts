import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents, discoverGlobalAgents, filterEnabledAgents, type AgentConfig } from "./agents";

let root: string;
let agentDir: string;
let bundledDir: string;

function agentFile(name: string, fields: string[] = [], body = "Prompt"): string {
  const description = fields.some((field) => field.startsWith("description:")) ? "" : `description: ${name} description\n`;
  return `---\nname: ${name}\n${description}${fields.join("\n")}\n---\n${body}\n`;
}

function writeAgent(dir: string, name: string, fields: string[] = [], body?: string): void {
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", `${name}.md`), agentFile(name, fields, body), "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-agents-"));
  agentDir = join(root, "global");
  bundledDir = join(root, "bundled");
  mkdirSync(join(bundledDir, "agents"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function options() {
  return { agentDir, bundledAgentsDir: bundledDir, cwd: join(root, "project") };
}

describe("discoverAgents (Markdown layers)", () => {
  it("uses bundled agents when the global agents directory is absent", async () => {
    writeAgent(bundledDir, "paper-assistant", ["enable: true", "tools: [read, bash]", "skills: [workflow]"]);
    const { agents } = await discoverAgents(options());

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: "paper-assistant", enabled: true, builtin: true, source: "bundled" });
  });

  it("lets a project Markdown file completely replace a global file", async () => {
    writeAgent(bundledDir, "search", ["tools: [read]", "skills: [bundled]"]);
    writeAgent(agentDir, "search", ["tools: [bash]", "skills: [global]", "model: global/model"]);
    writeAgent(join(root, "project", ".easyresearch"), "search", ["enable: false", "tools: [grep]"]);
    const { agents } = await discoverAgents(options());

    expect(agents[0]).toMatchObject({ name: "search", enabled: false, tools: ["grep"], skills: undefined, model: undefined });
  });

  it("appends custom Markdown agents and keeps built-ins before them", async () => {
    writeAgent(bundledDir, "paper-assistant");
    writeAgent(bundledDir, "search");
    writeAgent(agentDir, "审稿人", ["description: Custom reviewer"]);
    const { agents } = await discoverAgents(options());

    expect(agents.map((agent) => agent.name)).toEqual(["paper-assistant", "search", "审稿人"]);
    expect(agents[2]).toMatchObject({ builtin: false, source: "global" });
  });

  it("uses the primary built-in filename before its localized alias", async () => {
    writeAgent(bundledDir, "search", ["description: bundled search"]);
    writeAgent(agentDir, "检索", ["description: alias override"]);
    writeAgent(agentDir, "search", ["description: primary override"]);
    const { agents } = await discoverAgents(options());

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: "search", description: "primary override", filePath: join(agentDir, "agents", "search.md") });
  });

  it("treats assistant.md as custom while paper-assistant remains the built-in", async () => {
    writeAgent(bundledDir, "paper-assistant", ["enable: true"]);
    writeAgent(agentDir, "assistant", ["enable: true"]);
    writeAgent(join(root, "project", ".easyresearch"), "assistant", ["description: Project custom assistant"]);
    writeAgent(join(root, "project", ".easyresearch"), "paper-assistant", ["description: Project Paper Assistant"]);

    const { agents } = await discoverAgents(options());

    expect(agents[0]).toMatchObject({
      name: "paper-assistant",
      builtin: true,
      source: "project",
      description: "Project Paper Assistant",
    });
    expect(agents.find((agent) => agent.name === "assistant")).toMatchObject({
      builtin: false,
      source: "project",
      description: "Project custom assistant",
    });
  });

  it("uses the localized Paper Assistant alias and keeps it enabled", async () => {
    writeAgent(agentDir, "Paper Assistant", ["enable: false"]);

    const { agents } = await discoverAgents(options());

    expect(agents[0]).toMatchObject({
      name: "paper-assistant",
      enabled: true,
      builtin: true,
      source: "global",
      filePath: join(agentDir, "agents", "Paper Assistant.md"),
    });
  });

  it("keeps disabled agents visible and filters them from dispatch targets", async () => {
    writeAgent(bundledDir, "paper-assistant");
    writeAgent(bundledDir, "search", ["enable: false"]);
    writeAgent(bundledDir, "writing");
    const { agents } = await discoverAgents(options());

    expect(agents.map((agent) => [agent.name, agent.enabled])).toEqual([
      ["paper-assistant", true],
      ["search", false],
      ["writing", true],
    ]);
    expect(filterEnabledAgents(agents).map((agent) => agent.name)).toEqual(["paper-assistant", "writing"]);
  });

  it("defaults enable to true and reads complete frontmatter configuration", async () => {
    writeAgent(bundledDir, "experiment", ["model: provider/model", "tools: [bash, subagent]", "skills: [experiment]", "subagents: [search]"]);
    const { agents } = await discoverAgents(options());
    const experiment = agents[0] as AgentConfig;

    expect(experiment).toMatchObject({
      enabled: true,
      model: "provider/model",
      tools: ["bash", "subagent"],
      skills: ["experiment"],
      subagents: ["search"],
    });
  });

  it("parses the thinking frontmatter field as a string default", async () => {
    writeAgent(bundledDir, "search", ["thinking: medium"]);
    const { agents } = await discoverAgents(options());

    expect(agents[0]?.thinking).toBe("medium");
  });

  it.each([["thinking: ultra"], ["thinking:"], ["thinking: [high]"]])(
    "drops a non-level thinking value ($#)",
    async (field) => {
      writeAgent(bundledDir, "search", [field]);
      const { agents } = await discoverAgents(options());

      expect(agents[0]?.thinking).toBeUndefined();
    },
  );

  it.each([
    { label: "omitted", fields: [] },
    { label: "YAML-empty", fields: ["tools:", "skills:"] },
    { label: "empty arrays", fields: ["tools: []", "skills: []"] },
  ])("normalizes $label tool and Skill configuration to all capabilities", async ({ fields }) => {
    const bundledSkillsDir = join(root, "bundled-skills");
    mkdirSync(join(bundledSkillsDir, "available-skill"), { recursive: true });
    writeFileSync(join(bundledSkillsDir, "available-skill", "SKILL.md"), "# Available\n");
    writeAgent(bundledDir, "paper-assistant", fields);

    const { agents } = await discoverAgents({ ...options(), bundledSkillsDir });
    const paperAssistant = agents[0] as AgentConfig;

    expect(paperAssistant.tools).toBeUndefined();
    expect(paperAssistant.skills).toBeUndefined();
    expect(paperAssistant.effectiveTools).toEqual(expect.arrayContaining(["read", "subagent", "web-search"]));
    expect(paperAssistant.effectiveSkills).toEqual(["available-skill"]);
    expect(paperAssistant.missingSkills).toEqual([]);
  });

  it("keeps valid configured Skills and diagnoses missing ones", async () => {
    const bundledSkillsDir = join(root, "bundled-skills");
    mkdirSync(join(bundledSkillsDir, "available-skill"), { recursive: true });
    writeFileSync(join(bundledSkillsDir, "available-skill", "SKILL.md"), "# Available\n");
    writeAgent(bundledDir, "paper-assistant", ["skills: [available-skill, missing-skill]"]);

    const { agents } = await discoverAgents({ ...options(), bundledSkillsDir });
    const paperAssistant = agents[0] as AgentConfig;

    expect(paperAssistant.skills).toEqual(["available-skill", "missing-skill"]);
    expect(paperAssistant.effectiveSkills).toEqual(["available-skill"]);
    expect(paperAssistant.missingSkills).toEqual(["missing-skill"]);
  });

  it("preserves an empty subagent allowlist for leaf agents", async () => {
    writeAgent(bundledDir, "search", ["subagents: []"]);

    const { agents } = await discoverAgents(options());

    expect(agents[0]?.subagents).toEqual([]);
  });

  it("only includes home .agents skills when the global setting is enabled", async () => {
    const homeDir = join(root, "home");
    const bundledSkillsDir = join(root, "bundled-skills");
    mkdirSync(join(homeDir, ".agents", "skills", "home-only"), { recursive: true });
    mkdirSync(join(bundledSkillsDir, "home-only"), { recursive: true });
    writeFileSync(join(homeDir, ".agents", "skills", "home-only", "SKILL.md"), "# Home\n");
    writeFileSync(join(bundledSkillsDir, "home-only", "SKILL.md"), "# Bundled\n");
    writeAgent(bundledDir, "search", ["skills: [home-only]"]);

    const disabled = await discoverAgents({ ...options(), homeDir, bundledSkillsDir });
    expect(disabled.agents[0]?.effectiveSkills).toEqual(["home-only"]);

    const enabled = await discoverAgents({ ...options(), homeDir, bundledSkillsDir, enableDotAgentsSkill: true });
    expect(enabled.agents[0]?.effectiveSkills).toEqual(["home-only"]);
  });

  it("keeps global discovery free of project Agent and Skill roots", async () => {
    const project = join(root, "project");
    const bundledSkillsDir = join(root, "bundled-skills");
    writeAgent(bundledDir, "paper-assistant", ["skills: [project-only]"]);
    writeAgent(join(project, ".easyresearch"), "project-custom");
    mkdirSync(join(project, ".easyresearch", "skills", "project-only"), { recursive: true });
    writeFileSync(join(project, ".easyresearch", "skills", "project-only", "SKILL.md"), "# Project only\n");

    const { agents } = await discoverGlobalAgents({
      cwd: project,
      agentDir,
      bundledAgentsDir: bundledDir,
      bundledSkillsDir,
    });

    expect(agents.map((agent) => agent.name)).not.toContain("project-custom");
    expect(agents.find((agent) => agent.name === "paper-assistant")).toMatchObject({
      effectiveSkills: [],
      missingSkills: ["project-only"],
    });
  });
});
