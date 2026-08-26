import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverAgents,
  discoverGlobalAgents,
  filterEnabledAgents,
  loadAgentCatalog,
  resolveAgentCatalog,
  type AgentConfig,
} from "./agents";

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

function writeSettings(dir: string, settings: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings), "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-agents-"));
  agentDir = join(root, "global");
  bundledDir = join(root, "bundled");
  mkdirSync(join(bundledDir, "agents"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function options(platform: NodeJS.Platform = "linux") {
  return { agentDir, bundledAgentsDir: bundledDir, cwd: join(root, "project"), platform };
}

describe("discoverAgents (Markdown layers)", () => {
  it("uses bundled agents when the global agents directory is absent", async () => {
    writeAgent(bundledDir, "research-assistant", ["enable: true", "tools: [read, bash]", "skills: [workflow]"]);
    const { agents } = await discoverAgents(options());

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: "research-assistant", enabled: true, builtin: true, source: "bundled" });
  });

  it("uses global over bundled definitions without reading or changing project Agent files", async () => {
    const project = join(root, "project");
    const projectAgents = join(project, ".easyresearch");
    writeAgent(bundledDir, "search", ["tools: [read]", "skills: [bundled]"]);
    writeAgent(agentDir, "search", ["tools: [bash]", "skills: [global]", "model: global/model"]);
    writeAgent(projectAgents, "search", ["enable: false", "tools: [write]", "model: project/model"], "PROJECT SEARCH SECRET");
    writeAgent(projectAgents, "reviewer", ["description: Project reviewer"], "PROJECT REVIEWER SECRET");
    const projectSearch = join(projectAgents, "agents", "search.md");
    const projectReviewer = join(projectAgents, "agents", "reviewer.md");
    const beforeSearch = readFileSync(projectSearch, "utf8");
    const beforeReviewer = readFileSync(projectReviewer, "utf8");

    const { agents } = await discoverAgents(options());

    expect(agents.find((agent) => agent.name === "search")).toMatchObject({
      source: "global",
      enabled: true,
      tools: ["bash"],
      skills: ["global"],
      model: undefined,
    });
    expect(agents.some((agent) => agent.name === "reviewer")).toBe(false);
    expect(readFileSync(projectSearch, "utf8")).toBe(beforeSearch);
    expect(readFileSync(projectReviewer, "utf8")).toBe(beforeReviewer);
  });

  it("appends custom Markdown agents and keeps built-ins before them", async () => {
    writeAgent(bundledDir, "research-assistant");
    writeAgent(bundledDir, "search");
    writeAgent(agentDir, "审稿人", ["description: Custom reviewer"]);
    const { agents } = await discoverAgents(options());

    expect(agents.map((agent) => agent.name)).toEqual(["research-assistant", "search", "审稿人"]);
    expect(agents[2]).toMatchObject({ builtin: false, source: "global" });
  });

  it("uses global agentDefaults for built-in and custom Agents while ignoring Markdown and project values", async () => {
    const project = join(root, "project");
    writeAgent(bundledDir, "research-assistant", ["model: markdown/paper", "thinking: low"]);
    writeAgent(agentDir, "reviewer", ["model: markdown/reviewer", "thinking: minimal"]);
    writeSettings(agentDir, {
      easyresearch: {
        agentDefaults: {
          "research-assistant": { model: "global/paper", thinking: "high" },
          reviewer: { model: "global/reviewer", thinking: "xhigh" },
        },
      },
    });
    writeSettings(join(project, ".easyresearch"), {
      easyresearch: {
        agentDefaults: {
          "research-assistant": { model: "project/paper", thinking: "off" },
          reviewer: { model: "project/reviewer", thinking: "off" },
        },
      },
    });

    const { agents } = await discoverAgents({ ...options(), cwd: project });

    expect(agents.find((agent) => agent.name === "research-assistant")).toMatchObject({
      model: "global/paper",
      thinking: "high",
    });
    expect(agents.find((agent) => agent.name === "reviewer")).toMatchObject({
      model: "global/reviewer",
      thinking: "xhigh",
    });
  });

  it("uses the primary built-in filename before its alias", async () => {
    writeAgent(bundledDir, "research-assistant", ["description: bundled research assistant"]);
    writeAgent(agentDir, "Research Assistant", ["description: alias override"]);
    writeAgent(agentDir, "research-assistant", ["description: primary override"]);
    const { agents } = await discoverAgents(options());

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: "research-assistant", description: "primary override", filePath: join(agentDir, "agents", "research-assistant.md") });
  });

  it("treats a global assistant.md as custom while project definitions remain inert", async () => {
    writeAgent(bundledDir, "research-assistant", ["enable: true"]);
    writeAgent(agentDir, "assistant", ["enable: true"]);
    writeAgent(join(root, "project", ".easyresearch"), "assistant", ["description: Project custom assistant"]);
    writeAgent(join(root, "project", ".easyresearch"), "research-assistant", ["description: Project Research Assistant"]);

    const { agents } = await discoverAgents(options());

    expect(agents[0]).toMatchObject({
      name: "research-assistant",
      builtin: true,
      source: "bundled",
      description: "research-assistant description",
    });
    expect(agents.find((agent) => agent.name === "assistant")).toMatchObject({
      builtin: false,
      source: "global",
      description: "assistant description",
    });
  });

  it("uses the localized Research Assistant alias and keeps it enabled", async () => {
    writeAgent(agentDir, "Research Assistant", ["enable: false"]);

    const { agents } = await discoverAgents(options());

    expect(agents[0]).toMatchObject({
      name: "research-assistant",
      enabled: true,
      builtin: true,
      source: "global",
      filePath: join(agentDir, "agents", "Research Assistant.md"),
    });
  });

  it("keeps disabled agents visible and filters them from dispatch targets", async () => {
    writeAgent(bundledDir, "research-assistant");
    writeAgent(bundledDir, "search", ["enable: false"]);
    writeAgent(bundledDir, "writing");
    const { agents } = await discoverAgents(options());

    expect(agents.map((agent) => [agent.name, agent.enabled])).toEqual([
      ["research-assistant", true],
      ["search", false],
      ["writing", true],
    ]);
    expect(filterEnabledAgents(agents).map((agent) => agent.name)).toEqual(["research-assistant", "writing"]);
  });

  it("defaults enable to true and reads capability frontmatter while ignoring model", async () => {
    writeAgent(bundledDir, "experiment", ["model: provider/model", "tools: [bash, subagent]", "skills: [experiment]", "subagents: [search]"]);
    const { agents } = await discoverAgents(options());
    const experiment = agents[0] as AgentConfig;

    expect(experiment).toMatchObject({
      enabled: true,
      model: undefined,
      tools: ["bash", "subagent"],
      skills: ["experiment"],
      subagents: ["search"],
    });
  });

  it.each([
    ["win32", ["read", "powershell", "ssh-bash"]],
    ["linux", ["read", "bash", "ssh-bash"]],
    ["darwin", ["read", "bash", "ssh-bash"]],
  ] as const)("normalizes strict local-shell names on %s", async (platform, expected) => {
    writeAgent(bundledDir, "experiment", [
      "tools: [read, bash, powershell, ssh-bash]",
    ]);

    const { agents } = await discoverAgents({ ...options(), platform });
    const experiment = agents.find((agent) => agent.name === "experiment");

    expect(experiment?.tools).toEqual(["read", "bash", "powershell", "ssh-bash"]);
    expect(experiment?.effectiveTools).toEqual(expected);
  });

  it("ignores thinking frontmatter", async () => {
    writeAgent(bundledDir, "search", ["thinking: medium"]);
    const { agents } = await discoverAgents(options());

    expect(agents[0]?.thinking).toBeUndefined();
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
    writeAgent(bundledDir, "research-assistant", fields);

    const { agents } = await discoverAgents({ ...options(), bundledSkillsDir });
    const researchAssistant = agents[0] as AgentConfig;

    expect(researchAssistant.tools).toBeUndefined();
    expect(researchAssistant.skills).toBeUndefined();
    expect(researchAssistant.effectiveTools).toEqual(expect.arrayContaining(["read", "subagent", "web-search"]));
    expect(researchAssistant.effectiveSkills).toEqual(["available-skill"]);
    expect(researchAssistant.missingSkills).toEqual([]);
  });

  it("keeps valid configured Skills and diagnoses missing ones", async () => {
    const bundledSkillsDir = join(root, "bundled-skills");
    mkdirSync(join(bundledSkillsDir, "available-skill"), { recursive: true });
    writeFileSync(join(bundledSkillsDir, "available-skill", "SKILL.md"), "# Available\n");
    writeAgent(bundledDir, "research-assistant", ["skills: [available-skill, missing-skill]"]);

    const { agents } = await discoverAgents({ ...options(), bundledSkillsDir });
    const researchAssistant = agents[0] as AgentConfig;

    expect(researchAssistant.skills).toEqual(["available-skill", "missing-skill"]);
    expect(researchAssistant.effectiveSkills).toEqual(["available-skill"]);
    expect(researchAssistant.missingSkills).toEqual(["missing-skill"]);
  });

  it("reports ssh-bash for all-tools Research Assistant and Experiment definitions only", async () => {
    writeAgent(bundledDir, "research-assistant", ["tools: []"]);
    writeAgent(bundledDir, "experiment", ["tools: []"]);
    writeAgent(bundledDir, "custom", ["tools: []"]);

    const { agents } = await discoverAgents(options());
    const byName = Object.fromEntries(agents.map((agent) => [agent.name, agent]));

    expect(byName["research-assistant"]?.effectiveTools).toContain("ssh-bash");
    expect(byName.experiment?.effectiveTools).toContain("ssh-bash");
    expect(byName.custom?.effectiveTools).not.toContain("ssh-bash");
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

  it("resolves project Skills only when an exact cwd is supplied", async () => {
    const project = join(root, "project");
    const bundledSkillsDir = join(root, "bundled-skills");
    writeAgent(agentDir, "research-assistant", ["skills: [project-only]"]);
    writeAgent(join(project, ".easyresearch"), "project-custom");
    mkdirSync(join(project, ".easyresearch", "skills", "project-only"), { recursive: true });
    writeFileSync(join(project, ".easyresearch", "skills", "project-only", "SKILL.md"), "# Project only\n");

    const catalog = await loadAgentCatalog({ agentDir, bundledAgentsDir: bundledDir });
    const projectAgents = resolveAgentCatalog(catalog, {
      cwd: project,
      agentDir,
      bundledSkillsDir,
      platform: "linux",
    });
    const { agents: globalAgents } = await discoverGlobalAgents({
      cwd: project,
      agentDir,
      bundledAgentsDir: bundledDir,
      bundledSkillsDir,
      platform: "linux",
    });

    expect(catalog.definitions.find((agent) => agent.name === "research-assistant")).not.toHaveProperty("effectiveSkills");
    expect(projectAgents.agents.map((agent) => agent.name)).not.toContain("project-custom");
    expect(projectAgents.agents.find((agent) => agent.name === "research-assistant")).toMatchObject({
      source: "global",
      effectiveSkills: ["project-only"],
      missingSkills: [],
    });
    expect(globalAgents.map((agent) => agent.name)).not.toContain("project-custom");
    expect(globalAgents.find((agent) => agent.name === "research-assistant")).toMatchObject({
      source: "global",
      effectiveSkills: [],
      missingSkills: ["project-only"],
    });
  });

  it("reports malformed global definitions safely and keeps valid bundled fallbacks", async () => {
    writeAgent(bundledDir, "search", ["model: bundled/search"], "Bundled search fallback");
    writeAgent(bundledDir, "broken", ["model: bundled/broken"], "Bundled custom fallback");
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(
      join(agentDir, "agents", "search.md"),
      "---\nname: [search\nprivate: SEARCH_FILE_SECRET\n---\nGLOBAL SEARCH SECRET\n",
      "utf8",
    );
    writeFileSync(
      join(agentDir, "agents", "broken.md"),
      "---\nname: [broken\nprivate: BROKEN_FILE_SECRET\n---\nGLOBAL BROKEN SECRET\n",
      "utf8",
    );

    const catalog = await loadAgentCatalog({ agentDir, bundledAgentsDir: bundledDir });

    expect(catalog.definitions.find((agent) => agent.name === "search")).toMatchObject({
      source: "bundled",
      systemPrompt: "Bundled search fallback",
    });
    expect(catalog.definitions.find((agent) => agent.name === "broken")).toMatchObject({
      source: "bundled",
      systemPrompt: "Bundled custom fallback",
    });
    expect(catalog.diagnostics).toEqual([
      expect.objectContaining({ agent: "search", source: "global" }),
      expect.objectContaining({ agent: "broken", source: "global" }),
    ]);
    expect(JSON.stringify(catalog.diagnostics)).not.toContain("SEARCH_FILE_SECRET");
    expect(JSON.stringify(catalog.diagnostics)).not.toContain("BROKEN_FILE_SECRET");
    expect(JSON.stringify(catalog.diagnostics)).not.toContain("GLOBAL SEARCH SECRET");
    expect(JSON.stringify(catalog.diagnostics)).not.toContain("GLOBAL BROKEN SECRET");
  });
});
