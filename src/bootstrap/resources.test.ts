import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapBundledResources } from "./resources";

const tempDirs: string[] = [];

function setUpFixture(): { agentDir: string; bundledAgentsDir: string; bundledSkillsDir: string } {
  const agentDir = mkdtempSync(join(tmpdir(), "easyresearch-agent-"));
  const bundledAgentsDir = mkdtempSync(join(tmpdir(), "bundled-agents-"));
  const bundledSkillsDir = mkdtempSync(join(tmpdir(), "bundled-skills-"));
  tempDirs.push(agentDir, bundledAgentsDir, bundledSkillsDir);
  writeFileSync(join(bundledAgentsDir, "research-assistant.md"), "# research-assistant\n");
  mkdirSync(join(bundledSkillsDir, "paper-search"));
  writeFileSync(join(bundledSkillsDir, "paper-search", "SKILL.md"), "# paper-search\n");
  return { agentDir, bundledAgentsDir, bundledSkillsDir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bootstrapBundledResources", () => {
  it("does not seed bundled resources during startup", async () => {
    const { agentDir, bundledAgentsDir, bundledSkillsDir } = setUpFixture();

    const result = await bootstrapBundledResources({ agentDir, bundledAgentsDir, bundledSkillsDir });
    expect(result).toEqual({ copiedAgents: [], copiedSkills: [] });
    expect(existsSync(join(agentDir, "agents"))).toBe(false);
    expect(existsSync(join(agentDir, "skills"))).toBe(false);
  });

  it("skips machine-local artifacts when copying a fresh skill", async () => {
    const { agentDir, bundledAgentsDir, bundledSkillsDir } = setUpFixture();
    const skillSrc = join(bundledSkillsDir, "paper-search");
    mkdirSync(join(skillSrc, "scripts"));
    writeFileSync(join(skillSrc, "scripts", "run.py"), "print('ok')\n");
    mkdirSync(join(skillSrc, "scripts", ".venv"));
    mkdirSync(join(skillSrc, "scripts", "__pycache__"), { recursive: true });
    writeFileSync(join(skillSrc, "scripts", "__pycache__", "x.pyc"), "");
    writeFileSync(join(skillSrc, "scripts", "stale.pyc"), "");

    await bootstrapBundledResources({ agentDir, bundledAgentsDir, bundledSkillsDir });
    expect(existsSync(join(agentDir, "skills"))).toBe(false);
  });
});
