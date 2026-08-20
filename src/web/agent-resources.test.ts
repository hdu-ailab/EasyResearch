import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigFileService } from "./config-files";
import {
  createGlobalAgent,
  listGlobalSkills,
  readGlobalAgent,
  readGlobalSkill,
  writeGlobalAgent,
  writeGlobalSkill,
} from "./agent-resources";

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

  it("notifies only after validated full Agent saves and creates", async () => {
    const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-agent-res-"));
    tempDirs.push(agentDir);
    const onAuthoritativeWrite = vi.fn(async (_change: { agentsChanged?: true; modelsChanged?: true }) => {});
    const config = new ConfigFileService(agentDir, { onAuthoritativeWrite });

    await writeGlobalAgent(
      config,
      "search",
      "---\nname: search\ndescription: edited\n---\nEdited prompt\n",
    );
    await createGlobalAgent(config, "reviewer");
    await expect(
      writeGlobalAgent(config, "search", "invalid without frontmatter"),
    ).rejects.toMatchObject({ status: 400 });

    expect(onAuthoritativeWrite.mock.calls.map(([change]) => change)).toEqual([
      { agentsChanged: true },
      { agentsChanged: true },
    ]);
  });

  it("rejects malformed bundled Agent Markdown without materializing a global copy", async () => {
    const { agentDir, config } = tempConfig();
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    const unrelatedPath = join(agentDir, "agents", "reviewer.md");
    writeFileSync(unrelatedPath, "---\nname: reviewer\ndescription: reviewer\n---\nPrompt\n");
    const unrelatedBefore = readFileSync(unrelatedPath);

    await expect(writeGlobalAgent(config, "search", "Search prompt without frontmatter\n")).rejects.toMatchObject({
      status: 400,
    });

    expect(existsSync(join(agentDir, "agents", "search.md"))).toBe(false);
    expect(readFileSync(unrelatedPath)).toEqual(unrelatedBefore);
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

  it("rejects frontmatter whose name does not match the target filename", async () => {
    const { agentDir, config } = tempConfig();
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    const target = join(agentDir, "agents", "search.md");
    writeFileSync(target, "---\nname: search\ndescription: original\n---\nOriginal prompt\n");
    const before = readFileSync(target);

    await expect(
      writeGlobalAgent(config, "search", "---\nname: writing\ndescription: wrong identity\n---\nChanged prompt\n"),
    ).rejects.toMatchObject({ status: 400 });

    expect(readFileSync(target)).toEqual(before);
  });

  it.each([
    { field: "enable", value: "enable: yes" },
    { field: "description", value: "description: 42" },
    { field: "tools", value: "tools: read" },
    { field: "skills", value: "skills: paper-search" },
    { field: "subagents", value: "subagents: search" },
  ])("rejects malformed known $field frontmatter without changing Agent bytes", async ({ field, value }) => {
    const { agentDir, config } = tempConfig();
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    const target = join(agentDir, "agents", "search.md");
    const unrelated = join(agentDir, "agents", "writing.md");
    writeFileSync(target, "---\nname: search\ndescription: original\n---\nOriginal prompt\n");
    writeFileSync(unrelated, "---\nname: writing\ndescription: writing\n---\nWriting prompt\n");
    const targetBefore = readFileSync(target);
    const unrelatedBefore = readFileSync(unrelated);
    const description = field === "description" ? "" : "description: candidate\n";
    const candidate = `---\nname: search\n${description}${value}\n---\nChanged prompt\n`;

    await expect(writeGlobalAgent(config, "search", candidate)).rejects.toMatchObject({ status: 400 });

    expect(readFileSync(target)).toEqual(targetBefore);
    expect(readFileSync(unrelated)).toEqual(unrelatedBefore);
  });

  it.each(["model: openai", "model: openai//gpt", "thinking: ultra"])(
    "accepts but ignores residual runtime frontmatter %j",
    async (value) => {
      const { agentDir, config } = tempConfig();
      mkdirSync(join(agentDir, "agents"), { recursive: true });
      const candidate = `---\nname: search\ndescription: candidate\n${value}\n---\nChanged prompt\n`;

      const saved = await writeGlobalAgent(config, "search", candidate);

      expect(saved).toMatchObject({ model: undefined, thinking: undefined });
      expect(readFileSync(join(agentDir, "agents", "search.md"), "utf8")).toBe(candidate);
    },
  );

  it("accepts missing and empty tool and Skill configuration", async () => {
    const { config } = tempConfig();
    const content = [
      "---",
      "name: search",
      "description: empty capabilities",
      "enable: false",
      "tools:",
      "skills: []",
      "subagents: []",
      "---",
      "Empty capability prompt",
      "",
    ].join("\n");

    const saved = await writeGlobalAgent(config, "search", content);

    expect(saved).toMatchObject({
      enabled: false,
      tools: undefined,
      skills: undefined,
      subagents: [],
    });
    expect(saved.effectiveTools).toContain("subagent");
  });

  it("validates a global Paper Assistant alias against its actual filename", async () => {
    const { agentDir, config } = tempConfig();
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    const aliasPath = join(agentDir, "agents", "Paper Assistant.md");
    const edited = "---\nname: Paper Assistant\ndescription: edited alias\n---\nAlias prompt\n";
    writeFileSync(aliasPath, "---\nname: Paper Assistant\ndescription: alias\n---\nAlias prompt\n");

    const saved = await writeGlobalAgent(config, "paper-assistant", edited);

    expect(saved.name).toBe("paper-assistant");
    expect(readFileSync(aliasPath, "utf8")).toBe(edited);
    expect(existsSync(join(agentDir, "agents", "paper-assistant.md"))).toBe(false);
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
