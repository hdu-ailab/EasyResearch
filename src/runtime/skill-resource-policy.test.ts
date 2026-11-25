import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importPi } from "./pi-import";
import { fingerprintProjectSkillResources, fingerprintSkillRoot } from "./resource-fingerprint";
import { isSkillResourceEnabled, removeSkillResourceOverrides, setSkillResourceEnabled, skillResourceOverrides } from "./skill-resource-policy";
import { resolveSkillSelection } from "../subagent/skill-resolution";

let root: string;
let agentDir: string;
let cwd: string;
let descriptor: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "er-skill-policy-"));
  agentDir = join(root, ".easyresearch", "agent");
  cwd = join(root, "paper");
  descriptor = join(agentDir, "skills", "fixture", "SKILL.md");
  mkdirSync(join(descriptor, ".."), { recursive: true });
  mkdirSync(cwd);
  writeFileSync(descriptor, "---\nname: fixture\ndescription: fixture\n---\n");
  vi.stubEnv("HOME", root);
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", agentDir);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("native Skill override parity", () => {
  it.each([
    [], ["-skills/fixture"], ["-./skills/fixture/SKILL.md"], ["!**/fixture/**"],
    ["!fixture"], ["!SKILL.md"], ["!skills/{fixture,other}/**"],
    ["!**/fixture/**", "+skills/fixture"], ["+skills/fixture", "-skills/fixture"],
    ["-skills/fixture", "+skills/fixture"], ["!**", "+skills/fixture/SKILL.md"],
  ].map((entries) => ({ entries })))("matches real Pi resource filtering for $entries", async ({ entries }) => {
    const pi = await importPi();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: entries }));
    const manager = new pi.DefaultPackageManager({ cwd, agentDir, settingsManager: pi.SettingsManager.create(cwd, agentDir) });
    const native = (await manager.resolve()).skills.find((resource) => resource.path === descriptor);
    expect(native).toBeDefined();
    expect(isSkillResourceEnabled(descriptor, entries, { baseDir: agentDir, homeDir: root })).toBe(native!.enabled);
  });

  it("matches native absolute, home, file-URL and standalone descriptor exclusions", async () => {
    const pi = await importPi();
    const standalone = join(agentDir, "skills", "single.md");
    writeFileSync(standalone, "---\nname: single\ndescription: fixture\n---\n");
    for (const entries of [[`-${descriptor}`, "-~/.easyresearch/agent/skills/single.md"], [`-${pathToFileURL(descriptor).href}`]]) {
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: entries }));
      const native = await new pi.DefaultPackageManager({ cwd, agentDir, settingsManager: pi.SettingsManager.create(cwd, agentDir) }).resolve();
      for (const path of [descriptor, standalone]) {
        expect(isSkillResourceEnabled(path, entries, { baseDir: agentDir, homeDir: root }))
          .toBe(native.skills.find((resource) => resource.path === path)?.enabled);
      }
    }
  });

  it("re-enables exact resources without weakening a broader glob or unrelated exact exclusions", () => {
    const scope = { baseDir: agentDir, homeDir: root };
    const entries = ["plain-unrelated-path", "!**/fixture/**", "-skills/fixture", "-skills/other", "+skills/other"];
    const enabled = setSkillResourceEnabled(entries, descriptor, true, scope);
    expect(isSkillResourceEnabled(descriptor, enabled, scope)).toBe(true);
    expect(enabled).toEqual(expect.arrayContaining(["plain-unrelated-path", "!**/fixture/**", "-skills/other", "+skills/other"]));
    expect(setSkillResourceEnabled(enabled, descriptor, true, scope)).toEqual(enabled);
    const disabled = setSkillResourceEnabled(enabled, descriptor, false, scope);
    expect(isSkillResourceEnabled(descriptor, disabled, scope)).toBe(false);
    expect(removeSkillResourceOverrides(disabled, descriptor, scope)).toEqual(entries.filter((entry) => entry !== "-skills/fixture"));
    expect(skillResourceOverrides({ skills: ["additional-path", "!x", "+y", "-z"] })).toEqual(["!x", "+y", "-z"]);
  });

  it("preserves selected names before filtering and applies original paths before snapshots", async () => {
    const bundledSkillsDir = join(root, "bundled");
    mkdirSync(join(bundledSkillsDir, "fixture"), { recursive: true });
    writeFileSync(join(bundledSkillsDir, "fixture/SKILL.md"), "---\nname: fixture\ndescription: fallback\n---\n");
    const accepted = await fingerprintSkillRoot(join(agentDir, "skills"), "global", join(root, "snapshots"));
    const deps = { cwd, agentDir, homeDir: root, bundledSkillsDir, includeProject: false,
      acceptedSkillDescriptors: { global: accepted.skillDescriptors, home: null }, resourceOverrides: [`-${descriptor}`] };
    expect(resolveSkillSelection(undefined, deps).effectiveSkills).toEqual([]);
    expect(resolveSkillSelection(["fixture", descriptor, "missing"], deps)).toMatchObject({ effectiveSkillPaths: [], missingSkills: ["missing"] });
    const enabled = resolveSkillSelection(["fixture", descriptor], { ...deps, resourceOverrides: [] });
    expect(enabled.effectiveSkillPaths).toEqual([join(accepted.skillDescriptors[0]!.snapshotPath!, ".."), join(accepted.skillDescriptors[0]!.snapshotPath!, "..")]);
  });

  it("isolates accepted project overrides and retains the snapshot until the next accepted generation", async () => {
    const baseDir = join(cwd, ".easyresearch");
    mkdirSync(join(baseDir, "skills", "fixture"), { recursive: true });
    const projectDescriptor = join(baseDir, "skills", "fixture", "SKILL.md");
    writeFileSync(projectDescriptor, "---\nname: fixture\ndescription: project\n---\n");
    const before = await fingerprintProjectSkillResources(cwd, join(root, "snapshots"));
    writeFileSync(join(baseDir, "settings.json"), JSON.stringify({ skills: ["-skills/fixture"] }));
    const after = await fingerprintProjectSkillResources(cwd, join(root, "snapshots"));
    expect(after.value).not.toBe(before.value);
    const deps = { cwd, agentDir, homeDir: root, bundledSkillsDir: join(root, "empty"),
      resourceOverrides: [`-${descriptor}`], acceptedSkillDescriptors: { global: [], home: null, project: before.skillDescriptors } };
    expect(resolveSkillSelection(undefined, deps).effectiveSkills).toEqual(["fixture"]);
    expect(resolveSkillSelection(undefined, { ...deps, acceptedSkillDescriptors: { ...deps.acceptedSkillDescriptors, project: after.skillDescriptors } }).effectiveSkills).toEqual([]);
  });
});
