import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listBundledAgents, listBundledSkills, renameSameNameToBak } from "./setup-resources";

const tempRoots: string[] = [];
function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "setup-resources-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
});

function makeBundled(root: string): { agentsDir: string; skillsDir: string } {
  const agentsDir = join(root, "bundled", "agents");
  const skillsDir = join(root, "bundled", "skills");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(agentsDir, "search.md"), "search v2");
  writeFileSync(join(agentsDir, "bundled-agents.test.md"), "ignored");
  mkdirSync(join(skillsDir, "arxiv"), { recursive: true });
  writeFileSync(join(skillsDir, "arxiv", "SKILL.md"), "arxiv v2");
  return { agentsDir, skillsDir };
}

describe("listBundledAgents", () => {
  it("returns .md names, excluding *.test.md, sorted", () => {
    const root = tempDir();
    const { agentsDir } = makeBundled(root);
    expect(listBundledAgents(agentsDir)).toEqual(["search"]);
  });
});

describe("listBundledSkills", () => {
  it("returns skill directory names sorted", () => {
    const root = tempDir();
    const { skillsDir } = makeBundled(root);
    expect(listBundledSkills(skillsDir)).toEqual(["arxiv"]);
  });
});

describe("renameSameNameToBak", () => {
  it("renames a same-name agent .md to .md.bak, keeping the content", () => {
    const root = tempDir();
    const { agentsDir, skillsDir } = makeBundled(root);
    const userAgents = join(root, "agent", "agents");
    mkdirSync(userAgents, { recursive: true });
    writeFileSync(join(userAgents, "search.md"), "user v1");
    const result = renameSameNameToBak({
      agentDir: join(root, "agent"),
      bundledAgentsDir: agentsDir,
      bundledSkillsDir: skillsDir,
      log: () => {},
    });
    expect(result.entries).toEqual([
      {
        name: "search",
        kind: "agent",
        renamed: true,
        oldPath: join(userAgents, "search.md"),
        newPath: join(userAgents, "search.md.bak"),
      },
    ]);
    expect(existsSync(join(userAgents, "search.md"))).toBe(false);
    expect(readFileSync(join(userAgents, "search.md.bak"), "utf8")).toBe("user v1");
  });

  it("renames a same-name skill directory to .bak, keeping nested files", () => {
    const root = tempDir();
    const { agentsDir, skillsDir } = makeBundled(root);
    const userSkills = join(root, "agent", "skills");
    mkdirSync(join(userSkills, "arxiv"), { recursive: true });
    writeFileSync(join(userSkills, "arxiv", "SKILL.md"), "user skill");
    writeFileSync(join(userSkills, "arxiv", "notes.md"), "user notes");
    const result = renameSameNameToBak({
      agentDir: join(root, "agent"),
      bundledAgentsDir: agentsDir,
      bundledSkillsDir: skillsDir,
      log: () => {},
    });
    expect(result.entries).toEqual([
      {
        name: "arxiv",
        kind: "skill",
        renamed: true,
        oldPath: join(userSkills, "arxiv"),
        newPath: join(userSkills, "arxiv.bak"),
      },
    ]);
    expect(existsSync(join(userSkills, "arxiv"))).toBe(false);
    expect(readFileSync(join(userSkills, "arxiv.bak", "notes.md"), "utf8")).toBe("user notes");
  });

  it("overwrites an existing .bak with the current user copy", () => {
    const root = tempDir();
    const { agentsDir, skillsDir } = makeBundled(root);
    const userAgents = join(root, "agent", "agents");
    mkdirSync(userAgents, { recursive: true });
    writeFileSync(join(userAgents, "search.md"), "user v2");
    writeFileSync(join(userAgents, "search.md.bak"), "user v1");
    renameSameNameToBak({
      agentDir: join(root, "agent"),
      bundledAgentsDir: agentsDir,
      bundledSkillsDir: skillsDir,
      log: () => {},
    });
    expect(readFileSync(join(userAgents, "search.md.bak"), "utf8")).toBe("user v2");
  });

  it("leaves user entries without a bundled same-name untouched", () => {
    const root = tempDir();
    const { agentsDir, skillsDir } = makeBundled(root);
    const userAgents = join(root, "agent", "agents");
    const userSkills = join(root, "agent", "skills");
    mkdirSync(join(userAgents), { recursive: true });
    mkdirSync(join(userSkills, "custom"), { recursive: true });
    writeFileSync(join(userAgents, "custom.md"), "custom agent");
    writeFileSync(join(userSkills, "custom", "SKILL.md"), "custom skill");
    const result = renameSameNameToBak({
      agentDir: join(root, "agent"),
      bundledAgentsDir: agentsDir,
      bundledSkillsDir: skillsDir,
      log: () => {},
    });
    expect(result.entries).toEqual([]);
    expect(existsSync(join(userAgents, "custom.md"))).toBe(true);
    expect(existsSync(join(userSkills, "custom"))).toBe(true);
  });

  it("is a no-op when the user layer has no same-name entries", () => {
    const root = tempDir();
    const { agentsDir, skillsDir } = makeBundled(root);
    mkdirSync(join(root, "agent"), { recursive: true });
    const result = renameSameNameToBak({
      agentDir: join(root, "agent"),
      bundledAgentsDir: agentsDir,
      bundledSkillsDir: skillsDir,
      log: () => {},
    });
    expect(result.entries).toEqual([]);
    expect(readdirSync(join(root, "agent"))).toEqual([]);
  });
});
