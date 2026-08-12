import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSkillDirectories, type SkillResolverDeps } from "./skill-resolution";

let cwd: string;
let agentDir: string;
let bundledSkillsDir: string;
let deps: SkillResolverDeps;

function withSkill(siteDir: string, name: string): void {
  const dir = join(siteDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`);
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "lr-cwd-"));
  agentDir = mkdtempSync(join(tmpdir(), "lr-agent-"));
  bundledSkillsDir = mkdtempSync(join(tmpdir(), "lr-bundled-skills-"));
  deps = { cwd, agentDir, homeDir: join(tmpdir(), "fake-home"), bundledSkillsDir };
});

afterEach(() => {
  for (const dir of [cwd, agentDir, bundledSkillsDir, join(tmpdir(), "fake-home")]) rmSync(dir, { recursive: true, force: true });
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

  it("falls back global EasyResearch skills before ~/.agents skills", () => {
    const gAgent = join(agentDir, "skills");
    const gAgents = join(deps.homeDir!, ".agents", "skills");
    withSkill(gAgents, "arxiv");
    withSkill(gAgent, "arxiv");
    const dirs = resolveSkillDirectories(["arxiv"], deps)!;
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(join(gAgent, "arxiv"));
  });

  it("resolves a global .agents/skills name as last resort", () => {
    const gAgents = join(deps.homeDir!, ".agents", "skills");
    withSkill(gAgents, "latex-pdf");
    const dirs = resolveSkillDirectories(["latex-pdf"], deps)!;
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(join(gAgents, "latex-pdf"));
  });

  it("falls back to the bundled skill directory", () => {
    withSkill(bundledSkillsDir, "paper-search");
    const dirs = resolveSkillDirectories(["paper-search"], deps)!;
    expect(dirs).toEqual([join(bundledSkillsDir, "paper-search")]);
  });

  it("uses the source bundled skill directory when no override is supplied", () => {
    expect(resolveSkillDirectories(["paper-search"], { cwd, agentDir, homeDir: deps.homeDir })).toEqual([
      join(dirnameForTest(), "paper-search"),
    ]);
  });

  it("keeps absolute and ~ paths, omitting non-existent ones", () => {
    const abs = join(cwd, "custom", "drawio");
    withSkill(join(cwd, "custom"), "drawio");
    const dirs = resolveSkillDirectories([abs, "~/gone"], deps)!;
    expect(dirs).toEqual([abs]);
  });
});

function dirnameForTest(): string {
  return join(process.cwd(), "src", "skills");
}
