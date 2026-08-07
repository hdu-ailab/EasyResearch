import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents, mergeRegistryChain } from "./agents";
import type { AgentRegistry } from "./registry";

let dir: string;

function md(name: string, body = "You run things."): string {
  return `---\nname: ${name}\ndescription: ${name} stage agent\n---\n${body}`;
}

function writeAgent(name: string, body?: string): void {
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", `${name}.md`), md(name, body), "utf-8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lazy-agents-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const REG: AgentRegistry = {
  search: { definition: "agents/search.md", tools: ["bash"], skills: [] },
  experiment: { definition: "agents/experiment.md" },
};

describe("discoverAgents (registry)", () => {
  it("discovers only registry entries; unregistered .md is ignored", async () => {
    writeAgent("search");
    writeAgent("experiment");
    writeAgent("ghost");
    const { agents } = await discoverAgents({ agentDir: dir, registry: REG });
    expect(agents.map((a) => a.name)).toEqual(["experiment", "search"]);
  });

  it("loads tools/skills/subagents/model from the registry entry and identity from frontmatter", async () => {
    writeAgent("search");
    const search = {
      ...REG.search,
      model: "p/m",
      subagents: ["experiment"],
    };
    const { agents } = await discoverAgents({ agentDir: dir, registry: { search } });
    const got = agents.find((a) => a.name === "search")!;
    expect(got.tools).toEqual(["bash"]);
    expect(got.skills).toEqual([]);
    expect(got.subagents).toEqual(["experiment"]);
    expect(got.model).toBe("p/m");
    expect(got.description).toContain("stage agent");
  });

  it("deactivates entries whose definition file is missing", async () => {
    const { agents } = await discoverAgents({ agentDir: dir, registry: REG });
    expect(agents.map((a) => a.name)).not.toContain("experiment");
  });

  it("uses the registry-only discovery when registry given (no dir scan fallback)", async () => {
    const { agents } = await discoverAgents({ agentDir: join(dir, "missing"), registry: REG });
    expect(agents.every((a) => a.name !== "ghost")).toBe(true);
  });
});

describe("mergeRegistryChain (ADR-034)", () => {
  it("uses bundled defaults when no user layer configures an agent", () => {
    const bundled = { search: { definition: "agents/search.md", tools: ["bash"], skills: ["paper-search"] } };
    const merged = mergeRegistryChain(bundled, {}, {});
    expect(merged.search).toEqual({
      definition: "agents/search.md",
      tools: ["bash"],
      skills: ["paper-search"],
    });
  });

  it("lets project override global and global override bundled per field", () => {
    const bundled = {
      search: { definition: "agents/search.md", model: "b/m", tools: ["read"], skills: ["paper-search"] },
    };
    const global = { search: { model: "g/m" } };
    const project = { search: { tools: ["search"] } };
    const merged = mergeRegistryChain(bundled, global, project);
    expect(merged.search).toEqual({
      definition: "agents/search.md",
      model: "g/m",
      tools: ["search"],
      skills: ["paper-search"],
    });
  });

  it("keeps bundled-only agents that no user layer touches", () => {
    const bundled = {
      search: { definition: "agents/search.md" },
      figures: { definition: "agents/figures.md" },
    };
    const merged = mergeRegistryChain(bundled, { search: { model: "g/m" } }, {});
    expect(Object.keys(merged).sort()).toEqual(["figures", "search"]);
  });
});

describe("disabled agents (ADR-034)", () => {
  it("skips an entry whose merged registry disables it", async () => {
    writeAgent("search");
    writeAgent("figures");
    const { agents } = await discoverAgents({
      agentDir: dir,
      registry: {
        search: { definition: "agents/search.md", disabled: true },
        figures: { definition: "agents/figures.md" },
      },
    });
    expect(agents.map((a) => a.name)).toEqual(["figures"]);
  });

  it("ignores disabled on the orchestrator", async () => {
    writeAgent("orchestrator");
    writeAgent("search");
    const { agents } = await discoverAgents({
      agentDir: dir,
      registry: {
        orchestrator: { definition: "agents/orchestrator.md", disabled: true },
        search: { definition: "agents/search.md" },
      },
    });
    expect(agents.map((a) => a.name)).toEqual(["orchestrator", "search"]);
  });
});
