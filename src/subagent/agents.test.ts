import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents, filterEnabledAgents, type AgentConfig } from "./agents";

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
    writeAgent(bundledDir, "assistant", ["enable: true", "tools: [read, bash]", "skills: [workflow]"]);
    const { agents } = await discoverAgents(options());

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: "assistant", enabled: true, builtin: true, source: "bundled" });
  });

  it("lets a project Markdown file completely replace a global file", async () => {
    writeAgent(bundledDir, "search", ["tools: [read]", "skills: [bundled]"]);
    writeAgent(agentDir, "search", ["tools: [bash]", "skills: [global]", "model: global/model"]);
    writeAgent(join(root, "project", ".easyresearch"), "search", ["enable: false", "tools: [grep]"]);
    const { agents } = await discoverAgents(options());

    expect(agents[0]).toMatchObject({ name: "search", enabled: false, tools: ["grep"], skills: undefined, model: undefined });
  });

  it("appends custom Markdown agents and keeps built-ins before them", async () => {
    writeAgent(bundledDir, "assistant");
    writeAgent(bundledDir, "search");
    writeAgent(agentDir, "审稿人", ["description: Custom reviewer"]);
    const { agents } = await discoverAgents(options());

    expect(agents.map((agent) => agent.name)).toEqual(["assistant", "search", "审稿人"]);
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

  it("keeps disabled agents visible and filters them from dispatch targets", async () => {
    writeAgent(bundledDir, "assistant");
    writeAgent(bundledDir, "search", ["enable: false"]);
    writeAgent(bundledDir, "writing");
    const { agents } = await discoverAgents(options());

    expect(agents.map((agent) => [agent.name, agent.enabled])).toEqual([
      ["assistant", true],
      ["search", false],
      ["writing", true],
    ]);
    expect(filterEnabledAgents(agents).map((agent) => agent.name)).toEqual(["assistant", "writing"]);
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
});
