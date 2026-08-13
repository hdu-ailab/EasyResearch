import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigFileService } from "./config-files";
import { listGlobalSkills, readGlobalAgent, readGlobalSkill, writeGlobalAgent, writeGlobalSkill } from "./agent-resources";

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

describe("copy-on-save agent resources (ADR-058)", () => {
  function tempConfig(): { agentDir: string; config: ConfigFileService } {
    const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-agent-res-"));
    tempDirs.push(agentDir);
    return { agentDir, config: new ConfigFileService(agentDir) };
  }

  it("reading a bundled agent serves bundled content without creating a global copy", async () => {
    const { agentDir, config } = tempConfig();
    const read = await readGlobalAgent(config, "search");
    expect(read.source).toBe("bundled");
    expect(read.content).toBeDefined();
    expect(read.content).toContain("name: search");
    expect(existsSync(join(agentDir, "agents", "search.md"))).toBe(false);
  });

  it("saving a bundled agent materializes the global copy and writes the edit", async () => {
    const { agentDir, config } = tempConfig();
    const edited = await writeGlobalAgent(config, "search", "---\nname: search\ndescription: edited\n---\nEdited prompt\n");
    expect(existsSync(join(agentDir, "agents", "search.md"))).toBe(true);
    expect(edited.source).toBe("global");
    expect(edited.content).toContain("description: edited");
    const onDisk = readFileSync(join(agentDir, "agents", "search.md"), "utf8");
    expect(onDisk).toContain("description: edited");
  });

  it("reading a global agent returns the global content and does not overwrite it", async () => {
    const { agentDir, config } = tempConfig();
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "search.md"), "---\nname: search\ndescription: custom\n---\nCustom prompt\n");
    const read = await readGlobalAgent(config, "search");
    expect(read.source).toBe("global");
    expect(read.content).toContain("description: custom");
    expect(readFileSync(join(agentDir, "agents", "search.md"), "utf8")).toContain("description: custom");
  });

  it("reading an unknown agent raises 404", async () => {
    const { config } = tempConfig();
    await expect(readGlobalAgent(config, "no-such-agent")).rejects.toMatchObject({ status: 404 });
  });
});

describe("copy-on-save skill resources (ADR-058)", () => {
  function tempConfig(): { agentDir: string; config: ConfigFileService } {
    const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-skill-res-"));
    tempDirs.push(agentDir);
    return { agentDir, config: new ConfigFileService(agentDir) };
  }

  it("reading a bundled skill serves bundled SKILL.md without creating a global skill dir", async () => {
    const { agentDir, config } = tempConfig();
    const read = await readGlobalSkill(config, "arxiv");
    expect(read.source).toBe("bundled");
    expect(read.content).toBeDefined();
    expect((read.content ?? "").length).toBeGreaterThan(0);
    expect(existsSync(join(agentDir, "skills", "arxiv"))).toBe(false);
  });

  it("saving a bundled skill materializes the global skill dir and writes the edit", async () => {
    const { agentDir, config } = tempConfig();
    const edited = await writeGlobalSkill(config, "arxiv", "---\nname: arxiv\ndescription: edited\n---\nEdited skill\n");
    expect(existsSync(join(agentDir, "skills", "arxiv", "SKILL.md"))).toBe(true);
    expect(edited.source).toBe("global");
    expect(edited.content).toContain("description: edited");
    expect(readFileSync(join(agentDir, "skills", "arxiv", "SKILL.md"), "utf8")).toContain("description: edited");
  });

  it("reading an unknown skill raises 404", async () => {
    const { config } = tempConfig();
    await expect(readGlobalSkill(config, "no-such-skill")).rejects.toMatchObject({ status: 404 });
  });
});
