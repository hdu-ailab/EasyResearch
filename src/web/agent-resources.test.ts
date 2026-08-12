import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigFileService } from "./config-files";
import { listGlobalSkills } from "./agent-resources";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeHomeSkill(home: string, name: string): void {
  const skillDir = join(home, ".agents", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: home-only\n---\n`);
}

describe("listGlobalSkills", () => {
  it("hides home skills unless the global opt-in is true", async () => {
    const home = mkdtempSync(join("/dev/shm", "easyresearch-skill-home-"));
    const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-skill-agent-"));
    tempDirs.push(home, agentDir);
    process.env.HOME = home;
    const name = "home-only-resource";
    writeHomeSkill(home, name);
    const config = new ConfigFileService(agentDir);

    expect((await listGlobalSkills(config)).some((skill) => skill.name === name)).toBe(false);

    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ easyresearch: { enable_dot_agents_skill: true } }),
    );
    const enabled = (await listGlobalSkills(config)).find((skill) => skill.name === name);
    expect(enabled).toMatchObject({ name, source: "home", path: join(home, ".agents", "skills", name) });
  });
});
