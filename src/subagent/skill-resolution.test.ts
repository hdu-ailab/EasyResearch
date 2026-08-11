import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSkillDirectories, type SkillResolverDeps } from "./skill-resolution";

let cwd: string;
let agentDir: string;
let deps: SkillResolverDeps;

function withSkill(siteDir: string, name: string): void {
  const dir = join(siteDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`);
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "lr-cwd-"));
  agentDir = mkdtempSync(join(tmpdir(), "lr-agent-"));
  deps = { cwd, agentDir, homeDir: join(tmpdir(), "fake-home") };
});

afterEach(() => {
  for (const dir of [cwd, agentDir, join(tmpdir(), "fake-home")]) rmSync(dir, { recursive: true, force: true });
});

describe("resolveSkillDirectories", () => {
  it("returns undefined when skills is undefined (omitted → no flags)", () => {
    expect(resolveSkillDirectories(undefined, deps)).toBeUndefined();
  });

  it("returns [] for an explicit empty array", () => {
    expect(resolveSkillDirectories([], deps)).toEqual([]);
  });

  it("resolves a name by project .easyresearch/skills first", () => {
    const projectSite = join(cwd, ".easyresearch", "skills");
    const globalSite = join(agentDir, "skills");
    withSkill(projectSite, "paper-search");
    withSkill(globalSite, "paper-search");
    const dirs = resolveSkillDirectories(["paper-search"], deps)!;
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(join(projectSite, "paper-search"));
  });

  it("falls back project .agents/skills then global agentDir/skills", () => {
    const pAgents = join(cwd, ".agents", "skills");
    const gAgent = join(agentDir, "skills");
    withSkill(pAgents, "arxiv");
    withSkill(gAgent, "arxiv");
    const dirs = resolveSkillDirectories(["arxiv"], deps)!;
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(join(pAgents, "arxiv"));
  });

  it("resolves a global .agents/skills name as last resort", () => {
    const gAgents = join(deps.homeDir!, ".agents", "skills");
    withSkill(gAgents, "latex-pdf");
    const dirs = resolveSkillDirectories(["latex-pdf"], deps)!;
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(join(gAgents, "latex-pdf"));
  });

  it("keeps absolute and ~ paths, omitting non-existent ones", () => {
    const abs = join(cwd, "custom", "drawio");
    withSkill(join(cwd, "custom"), "drawio");
    const dirs = resolveSkillDirectories([abs, "~/gone"], deps)!;
    expect(dirs).toEqual([abs]);
  });
});