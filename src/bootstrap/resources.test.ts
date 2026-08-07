import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapBundledResources } from "./resources";

const tempDirs: string[] = [];

function setUpFixture(): { agentDir: string; bundledAgentsDir: string; bundledSkillsDir: string } {
  const agentDir = mkdtempSync(join(tmpdir(), "lazyresearch-agent-"));
  const bundledAgentsDir = mkdtempSync(join(tmpdir(), "bundled-agents-"));
  const bundledSkillsDir = mkdtempSync(join(tmpdir(), "bundled-skills-"));
  tempDirs.push(agentDir, bundledAgentsDir, bundledSkillsDir);
  writeFileSync(join(bundledAgentsDir, "orchestrator.md"), "# orchestrator\n");
  mkdirSync(join(bundledSkillsDir, "paper-search"));
  writeFileSync(join(bundledSkillsDir, "paper-search", "SKILL.md"), "# paper-search\n");
  return { agentDir, bundledAgentsDir, bundledSkillsDir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bootstrapBundledResources", () => {
  it("copies only missing agents and skills and then no-ops", async () => {
    const { agentDir, bundledAgentsDir, bundledSkillsDir } = setUpFixture();

    const first = await bootstrapBundledResources({ agentDir, bundledAgentsDir, bundledSkillsDir });
    expect(first.copiedAgents).toEqual(["orchestrator.md"]);
    expect(first.copiedSkills).toEqual(["paper-search"]);

    writeFileSync(join(agentDir, "agents", "orchestrator.md"), "user edit");
    writeFileSync(join(agentDir, "skills", "paper-search", "SKILL.md"), "user skill");
    const second = await bootstrapBundledResources({ agentDir, bundledAgentsDir, bundledSkillsDir });
    expect(second).toEqual({ copiedAgents: [], copiedSkills: [] });
    expect(readFileSync(join(agentDir, "agents", "orchestrator.md"), "utf8")).toBe("user edit");
    expect(readFileSync(join(agentDir, "skills", "paper-search", "SKILL.md"), "utf8")).toBe("user skill");
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

    const target = join(agentDir, "skills", "paper-search");
    expect(readFileSync(join(target, "scripts", "run.py"), "utf8")).toBe("print('ok')\n");
    expect(existsSync(join(target, "scripts", ".venv"))).toBe(false);
    expect(existsSync(join(target, "scripts", "__pycache__"))).toBe(false);
    expect(existsSync(join(target, "scripts", "stale.pyc"))).toBe(false);
  });
});
