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
    expect(second).toEqual({ copiedAgents: [], copiedSkills: [], seededRegistry: false });
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

  it("seeds the default registry on a fresh agentDir", async () => {
    const { agentDir, bundledAgentsDir, bundledSkillsDir } = setUpFixture();
    writeFileSync(
      join(bundledAgentsDir, "agents.json"),
      JSON.stringify({
        orchestrator: { definition: "agents/orchestrator.md", tools: ["read", "bash"], skills: ["research-project-workflow"] },
      }),
    );

    const result = await bootstrapBundledResources({ agentDir, bundledAgentsDir, bundledSkillsDir });
    expect(result.seededRegistry).toBe(true);
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
      lazyresearch: { agents: Record<string, unknown> };
    };
    expect(Object.keys(settings.lazyresearch.agents)).toContain("orchestrator");
  });

  it("seeds while preserving unrelated settings fields", async () => {
    const { agentDir, bundledAgentsDir, bundledSkillsDir } = setUpFixture();
    writeFileSync(
      join(bundledAgentsDir, "agents.json"),
      JSON.stringify({ orchestrator: { definition: "agents/orchestrator.md" } }),
    );
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", defaultModel: "gpt-4o" }));

    const result = await bootstrapBundledResources({ agentDir, bundledAgentsDir, bundledSkillsDir });
    expect(result.seededRegistry).toBe(true);
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
      theme: string;
      defaultModel: string;
      lazyresearch: { agents: Record<string, unknown> };
    };
    expect(settings.theme).toBe("dark");
    expect(settings.defaultModel).toBe("gpt-4o");
    expect(settings.lazyresearch.agents.orchestrator).toEqual({ definition: "agents/orchestrator.md" });
  });

  it("does not overwrite an existing registry", async () => {
    const { agentDir, bundledAgentsDir, bundledSkillsDir } = setUpFixture();
    writeFileSync(
      join(bundledAgentsDir, "agents.json"),
      JSON.stringify({ orchestrator: { definition: "agents/orchestrator.md" } }),
    );
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ lazyresearch: { agents: { custom: {} } } }));

    const result = await bootstrapBundledResources({ agentDir, bundledAgentsDir, bundledSkillsDir });
    expect(result.seededRegistry).toBe(false);
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
      lazyresearch: { agents: Record<string, unknown> };
    };
    expect(settings.lazyresearch.agents).toEqual({ custom: {} });
  });
});