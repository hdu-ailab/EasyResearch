import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { installBundledSkills } from "./install";

let seedDir = "";
let targetDir = "";
let seedRoot = "";
let targetRoot = "";

function makeSkill(name: string, file: string, content: string): void {
  const path = join(seedDir, name, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function makeSource(name: string): void {
  mkdirSync(join(seedDir, name), { recursive: true });
}

function makeTargetFile(rel: string, content: string): void {
  const path = join(targetDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  seedRoot = join(tmpdir(), `lazy-install-seed-${Math.random().toString(36).slice(2)}`);
  targetRoot = join(tmpdir(), `lazy-install-target-${Math.random().toString(36).slice(2)}`);
  seedDir = join(seedRoot, "skills");
  targetDir = join(targetRoot, "agent", "skills");
  mkdirSync(seedDir, { recursive: true });
});

afterAll(() => {
  // temp dirs only; nothing outside is touched
});

describe("installBundledSkills", () => {
  it("installs skill directories containing SKILL.md", () => {
    makeSource("paper-search");
    makeSkill("paper-search", "SKILL.md", "---\nname: paper-search\n---\nbody");
    makeSource("not-a-skill");
    writeFileSync(join(seedDir, "not-a-skill", "notes.txt"), "no skill here");

    const result = installBundledSkills({ sourceDir: seedDir, targetDir });

    expect(result.installed).toEqual(["paper-search"]);
    expect(result.skipped).toEqual([]);
    // behavior contract: target mirror matches source structure
    expect(readFileSync(join(targetDir, "paper-search", "SKILL.md"), "utf-8")).toBe(
      readFileSync(join(seedDir, "paper-search", "SKILL.md"), "utf-8"),
    );
  });

  it("skips directories that already exist in the target (user wins)", () => {
    makeSource("paper-search");
    makeSkill("paper-search", "SKILL.md", "bundled version");
    makeTargetFile("paper-search/SKILL.md", "user version");

    const result = installBundledSkills({ sourceDir: seedDir, targetDir });

    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual(["paper-search"]);
    expect(readFileSync(join(targetDir, "paper-search", "SKILL.md"), "utf-8")).toBe(
      "user version",
    );
  });

  it("never copies machine-local artifacts (.venv, __pycache__)", () => {
    makeSource("paper-search");
    makeSkill("paper-search", "SKILL.md", "body");
    makeSkill("paper-search", ".venv/bin/python", "junk");
    makeSkill("paper-search", "__pycache__/x.pyc", "junk");

    installBundledSkills({ sourceDir: seedDir, targetDir });

    expect(existsSync(join(targetDir, "paper-search", ".venv"))).toBe(false);
    expect(existsSync(join(targetDir, "paper-search", "__pycache__"))).toBe(false);
  });

  it("returns empty result when the source dir does not exist", () => {
    const result = installBundledSkills({ sourceDir: join(seedRoot, "missing"), targetDir });
    expect(result).toEqual({ installed: [], skipped: [] });
  });
});
