import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isDotAgentsSkillEnabled,
  readGlobalDotAgentsSkillSetting,
  resolveSkillSelection,
  resolveSkillDirectories,
  type SkillResolverDeps,
} from "./skill-resolution";

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

  it("resolves effective default skill names from the allowed roots", async () => {
    const projectSkill = join(cwd, ".easyresearch", "skills", "project-only");
    mkdirSync(projectSkill, { recursive: true });
    writeFileSync(join(projectSkill, "SKILL.md"), "# project-only\n");
    const { resolveEffectiveSkillNames } = await import("./skill-resolution");
    expect(resolveEffectiveSkillNames(undefined, deps)).toEqual(["project-only"]);
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

  it("does not resolve a global .agents/skills name by default", () => {
    const gAgents = join(deps.homeDir!, ".agents", "skills");
    withSkill(gAgents, "latex-pdf");
    withSkill(bundledSkillsDir, "latex-pdf");
    const dirs = resolveSkillDirectories(["latex-pdf"], deps)!;
    expect(dirs).toEqual([join(bundledSkillsDir, "latex-pdf")]);
  });

  it("resolves a global .agents/skills name only when explicitly enabled", () => {
    const gAgents = join(deps.homeDir!, ".agents", "skills");
    withSkill(gAgents, "latex-pdf");
    const dirs = resolveSkillDirectories(["latex-pdf"], { ...deps, enableDotAgentsSkill: true })!;
    expect(dirs).toEqual([join(gAgents, "latex-pdf")]);
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

  it("resolves both Pi-native directory and root Markdown Skill shapes", () => {
    const projectSite = join(cwd, ".easyresearch", "skills");
    withSkill(projectSite, "directory-skill");
    writeFileSync(join(projectSite, "file-skill.md"), "# file skill\n");

    expect(resolveSkillDirectories(["directory-skill", "file-skill"], deps)).toEqual([
      join(projectSite, "directory-skill"),
      join(projectSite, "file-skill.md"),
    ]);
  });

  it("rejects existing directories without SKILL.md and non-Markdown files", () => {
    const projectSite = join(cwd, ".easyresearch", "skills");
    mkdirSync(join(projectSite, "invalid-dir"), { recursive: true });
    writeFileSync(join(projectSite, "invalid-file.txt"), "not a skill\n");

    expect(resolveSkillSelection(["invalid-dir", "./.easyresearch/skills/invalid-file.txt"], deps)).toEqual({
      effectiveSkills: [],
      missingSkills: ["invalid-dir", "./.easyresearch/skills/invalid-file.txt"],
    });
  });

  it("resolves relative path references from the exact dependency cwd", () => {
    const relativeSkill = join(cwd, "local-skills", "relative");
    withSkill(join(cwd, "local-skills"), "relative");

    expect(resolveSkillDirectories(["./local-skills/relative"], deps)).toEqual([relativeSkill]);
  });
});

describe("resolveSkillSelection", () => {
  it("returns all controlled Skills without missing diagnostics when configuration means all", () => {
    withSkill(bundledSkillsDir, "available-skill");
    writeFileSync(join(bundledSkillsDir, "file-skill.md"), "# file skill\n");

    expect(resolveSkillSelection(undefined, deps)).toEqual({
      effectiveSkills: ["available-skill", "file-skill"],
      missingSkills: [],
    });
  });

  it("keeps valid configured Skills while reporting unresolved names", () => {
    withSkill(bundledSkillsDir, "available-skill");

    expect(resolveSkillSelection(["available-skill", "missing-skill"], deps)).toEqual({
      effectiveSkills: ["available-skill"],
      missingSkills: ["missing-skill"],
    });
  });
});

describe("enable_dot_agents_skill", () => {
  it("requires an exact boolean true in the global easyresearch namespace", () => {
    expect(isDotAgentsSkillEnabled({})).toBe(false);
    expect(isDotAgentsSkillEnabled({ easyresearch: { enable_dot_agents_skill: false } })).toBe(false);
    expect(isDotAgentsSkillEnabled({ easyresearch: { enable_dot_agents_skill: "true" } })).toBe(false);
    expect(isDotAgentsSkillEnabled({ easyresearch: { enable_dot_agents_skill: true } })).toBe(true);
  });

  it("reads the global setting through Pi SettingsManager", async () => {
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ easyresearch: { enable_dot_agents_skill: true } }),
    );
    await expect(readGlobalDotAgentsSkillSetting(cwd, agentDir)).resolves.toBe(true);
  });
});

function dirnameForTest(): string {
  return join(process.cwd(), "src", "skills");
}
