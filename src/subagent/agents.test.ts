import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents } from "./agents";
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
