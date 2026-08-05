import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents } from "./agents";

const ORCHESTRATOR_MD = [
  "---",
  "name: orchestrator",
  "description: Orchestrates the paper pipeline",
  "tools: read, bash, subagent",
  "---",
  "You are the orchestrator.",
].join("\n");

const LITERATURE_MD = [
  "---",
  "name: literature",
  "description: Research stage agent",
  "---",
  "You research papers.",
].join("\n");

describe("discoverAgents", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lazy-agents-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads agents from the global agents dir", () => {
    writeFileSync(join(dir, "literature.md"), LITERATURE_MD, "utf-8");
    const { agents } = discoverAgents(dir);
    const lit = agents.find((a) => a.name === "literature");
    expect(lit?.source).toBe("global");
    expect(lit?.systemPrompt).toContain("You research papers.");
    expect(lit?.tools).toBeUndefined();
  });

  it("parses frontmatter fields", () => {
    writeFileSync(join(dir, "orchestrator.md"), ORCHESTRATOR_MD, "utf-8");
    const { agents } = discoverAgents(dir);
    const orch = agents.find((a) => a.name === "orchestrator");
    expect(orch?.tools).toEqual(["read", "bash", "subagent"]);
    expect(orch?.description).toContain("paper pipeline");
  });

  it("ignores files without required frontmatter", () => {
    writeFileSync(join(dir, "bad.md"), "no frontmatter here", "utf-8");
    writeFileSync(join(dir, "readme.txt"), "not md", "utf-8");
    const { agents } = discoverAgents(dir);
    expect(agents.map((a) => a.name)).not.toContain("bad");
    expect(agents.map((a) => a.name)).not.toContain("readme");
  });

  it("returns no agents when the global dir is missing", () => {
    const { agents } = discoverAgents(join(dir, "nope"));
    expect(agents).toEqual([]);
  });
});
