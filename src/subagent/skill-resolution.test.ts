import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isDotAgentsSkillEnabled,
  readGlobalDotAgentsSkillSetting,
  resolveAgentSkillDirectories,
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

  it("resolves nested names with project, global, enabled-home, then bundled precedence", () => {
    expect(deps.homeDir).toBeDefined();
    const project = join(cwd, ".easyresearch", "skills", "namespace", "shared");
    const global = join(agentDir, "skills", "namespace", "shared");
    const home = join(deps.homeDir ?? "", ".agents", "skills", "namespace", "shared");
    const bundled = join(bundledSkillsDir, "shared");
    for (const directory of [project, global, home, bundled]) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "SKILL.md"), directory, "utf8");
    }
    const enabled = { ...deps, enableDotAgentsSkill: true };

    expect(resolveSkillDirectories(["shared"], enabled)).toEqual([project]);
    rmSync(project, { recursive: true });
    expect(resolveSkillDirectories(["shared"], enabled)).toEqual([global]);
    rmSync(global, { recursive: true });
    expect(resolveSkillDirectories(["shared"], enabled)).toEqual([home]);
    rmSync(home, { recursive: true });
    expect(resolveSkillDirectories(["shared"], enabled)).toEqual([bundled]);
  });

  it("uses canonical bytewise first-name-wins for root-file and directory collisions", () => {
    const globalSite = join(agentDir, "skills");
    mkdirSync(join(globalSite, "foo"), { recursive: true });
    writeFileSync(join(globalSite, "foo.md"), "root file", "utf8");
    writeFileSync(join(globalSite, "foo", "SKILL.md"), "directory", "utf8");

    expect(resolveSkillDirectories(["foo"], deps)).toEqual([join(globalSite, "foo.md")]);
    expect(resolveSkillSelection(undefined, deps)).toEqual({
      effectiveSkills: ["foo"],
      effectiveSkillPaths: [join(globalSite, "foo.md")],
      missingSkills: [],
    });
    expect(resolveAgentSkillDirectories({ skills: undefined }, deps)).toEqual([join(globalSite, "foo.md")]);
  });

  it("excludes out-of-root symlinks, terminates cycles, and propagates canonical depth bounds", () => {
    const globalSite = join(agentDir, "skills");
    const inside = join(globalSite, "namespace", "deep");
    const outside = join(cwd, "outside");
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(inside, "SKILL.md"), "inside", "utf8");
    writeFileSync(join(outside, "SKILL.md"), "outside", "utf8");
    symlinkSync("..", join(globalSite, "namespace", "cycle"), "dir");
    symlinkSync(outside, join(globalSite, "outside"), "dir");

    expect(resolveSkillSelection(undefined, deps)).toEqual({
      effectiveSkills: ["deep"],
      effectiveSkillPaths: [inside],
      missingSkills: [],
    });
    expect(resolveSkillDirectories(["outside"], deps)).toEqual([]);

    const tooDeep = join(globalSite, ...Array.from({ length: 17 }, (_, index) => `level-${index}`));
    mkdirSync(tooDeep, { recursive: true });
    writeFileSync(join(tooDeep, "SKILL.md"), "too deep", "utf8");
    expect(() => resolveSkillSelection(undefined, deps)).toThrow(/depth/i);
  });

  it("rejects existing directories without SKILL.md and non-Markdown files", () => {
    const projectSite = join(cwd, ".easyresearch", "skills");
    mkdirSync(join(projectSite, "invalid-dir"), { recursive: true });
    writeFileSync(join(projectSite, "invalid-file.txt"), "not a skill\n");

    expect(resolveSkillSelection(["invalid-dir", "./.easyresearch/skills/invalid-file.txt"], deps)).toEqual({
      effectiveSkills: [],
      effectiveSkillPaths: [],
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
      effectiveSkillPaths: [
        join(bundledSkillsDir, "available-skill"),
        join(bundledSkillsDir, "file-skill.md"),
      ],
      missingSkills: [],
    });
  });

  it("keeps valid configured Skills while reporting unresolved names", () => {
    withSkill(bundledSkillsDir, "available-skill");

    expect(resolveSkillSelection(["available-skill", "missing-skill"], deps)).toEqual({
      effectiveSkills: ["available-skill"],
      effectiveSkillPaths: [join(bundledSkillsDir, "available-skill")],
      missingSkills: ["missing-skill"],
    });
  });

  it("returns exact first-name-wins names and load paths from one resolution", () => {
    const projectSite = join(cwd, ".easyresearch", "skills");
    const globalSite = join(agentDir, "skills");
    const homeSite = join(tmpdir(), "fake-home", ".agents", "skills");
    const staticSite = join(cwd, "static-skills");

    for (const site of [projectSite, globalSite, homeSite, bundledSkillsDir]) {
      withSkill(site, "shared");
    }
    writeFileSync(join(globalSite, "global-file.md"), "# global file\n");
    withSkill(homeSite, "home-directory");
    writeFileSync(join(bundledSkillsDir, "bundled-file.md"), "# bundled file\n");
    withSkill(globalSite, "controlled-explicit");
    withSkill(staticSite, "outside-explicit");

    const controlledExplicit = join(globalSite, "controlled-explicit");
    const outsideExplicit = join(staticSite, "outside-explicit");
    const selection = resolveSkillSelection([
      "shared",
      "global-file",
      "home-directory",
      "bundled-file",
      controlledExplicit,
      outsideExplicit,
      "missing-skill",
    ], {
      ...deps,
      enableDotAgentsSkill: true,
    });

    expect(selection).toEqual({
      effectiveSkills: [
        "shared",
        "global-file",
        "home-directory",
        "bundled-file",
        controlledExplicit,
        outsideExplicit,
      ],
      effectiveSkillPaths: [
        join(projectSite, "shared"),
        join(globalSite, "global-file.md"),
        join(homeSite, "home-directory"),
        join(bundledSkillsDir, "bundled-file.md"),
        controlledExplicit,
        outsideExplicit,
      ],
      missingSkills: ["missing-skill"],
    });
    expect(selection.effectiveSkills).toHaveLength(selection.effectiveSkillPaths.length);
  });
});

describe("resolveAgentSkillDirectories", () => {
  it("returns no paths without an agent", () => {
    expect(resolveAgentSkillDirectories(undefined, deps)).toEqual([]);
  });

  it("resolves the agent allowlist against the skill sites", () => {
    withSkill(bundledSkillsDir, "paper-search");
    expect(resolveAgentSkillDirectories({ skills: ["paper-search"] }, deps)).toEqual([
      join(bundledSkillsDir, "paper-search"),
    ]);
    expect(resolveAgentSkillDirectories({ skills: ["no-such-skill"] }, deps)).toEqual([]);
  });

  it("loads canonical selected Skill paths when the allowlist is omitted", () => {
    withSkill(bundledSkillsDir, "available-skill");
    writeFileSync(join(bundledSkillsDir, "file-skill.md"), "# file skill\n", "utf8");

    expect(resolveAgentSkillDirectories({ skills: undefined }, deps)).toEqual([
      join(bundledSkillsDir, "available-skill"),
      join(bundledSkillsDir, "file-skill.md"),
    ]);
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
