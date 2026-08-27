import type * as fs from "node:fs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSkillDirectories, resolveSkillSelection } from "../subagent/skill-resolution";
import { ConfigFileService } from "./config-files";

const { cpSyncMock, realCpSync } = vi.hoisted(() => ({
  cpSyncMock: vi.fn<typeof fs.cpSync>(),
  realCpSync: { impl: null as unknown as typeof fs.cpSync },
}));

vi.mock("node:fs", async (importOriginal) => {
  const mod = await importOriginal<typeof fs>();
  realCpSync.impl = mod.cpSync;
  cpSyncMock.mockImplementation(mod.cpSync);
  return { ...mod, cpSync: cpSyncMock };
});
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
const originalBundledRoot = process.env.EASYRESEARCH_BUNDLED_ROOT;

afterEach(() => {
  cpSyncMock.mockReset();
  cpSyncMock.mockImplementation(realCpSync.impl);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalBundledRoot === undefined) delete process.env.EASYRESEARCH_BUNDLED_ROOT;
  else process.env.EASYRESEARCH_BUNDLED_ROOT = originalBundledRoot;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function skillResourceOptions(options: {
  enableDotAgentsSkill?: boolean;
  homeDir?: string;
  bundledSkillsDir?: string;
} = {}) {
  return {
    skillPolicy: { enableDotAgentsSkill: options.enableDotAgentsSkill ?? false },
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.bundledSkillsDir ? { bundledSkillsDir: options.bundledSkillsDir } : {}),
  };
}

function writeDirectorySkill(root: string, name: string, marker: string): string {
  const skillDir = join(root, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${marker}\n---\n${marker}\n`);
  return skillDir;
}

function writeHomeSkill(home: string, name: string, marker = "home-only"): void {
  const skillDir = join(home, ".agents", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${marker}\n---\n`);
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("listGlobalSkills", () => {
  it("uses the accepted last-known-good home policy instead of current settings bytes", async () => {
    const home = mkdtempSync(join("/dev/shm", "easyresearch-skill-home-"));
    const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-skill-agent-"));
    tempDirs.push(home, agentDir);
    process.env.HOME = home;
    const name = "home-only-resource";
    writeHomeSkill(home, name);
    const config = new ConfigFileService(agentDir);

    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ easyresearch: { enable_dot_agents_skill: true } }),
    );
    expect((await listGlobalSkills(config, skillResourceOptions({
      enableDotAgentsSkill: false,
      homeDir: home,
    }))).some((skill) => skill.name === name)).toBe(false);

    writeFileSync(join(agentDir, "settings.json"), "{ malformed candidate", "utf8");
    const enabled = (await listGlobalSkills(config, skillResourceOptions({
      enableDotAgentsSkill: true,
      homeDir: home,
    }))).find((skill) => skill.name === name);
    expect(enabled).toMatchObject({ name, source: "home", path: join(home, ".agents", "skills", name) });
  });

  it("lists canonical root Markdown and nested SKILL.md descriptors and stops below a discovered ancestor", async () => {
    const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-skill-agent-"));
    const bundledRoot = mkdtempSync(join("/dev/shm", "easyresearch-skill-bundled-"));
    const bundledSkillsDir = join(bundledRoot, "skills");
    tempDirs.push(agentDir, bundledRoot);
    mkdirSync(join(agentDir, "skills", "namespace", "deep"), { recursive: true });
    mkdirSync(join(agentDir, "skills", "parent", "hidden"), { recursive: true });
    mkdirSync(bundledSkillsDir, { recursive: true });
    writeFileSync(join(agentDir, "skills", "alpha.md"), "root alpha", "utf8");
    writeFileSync(join(agentDir, "skills", "namespace", "deep", "SKILL.md"), "deep skill", "utf8");
    writeFileSync(join(agentDir, "skills", "namespace", "README.md"), "not a skill", "utf8");
    writeFileSync(join(agentDir, "skills", "parent", "SKILL.md"), "parent skill", "utf8");
    writeFileSync(join(agentDir, "skills", "parent", "hidden", "SKILL.md"), "hidden skill", "utf8");
    const config = new ConfigFileService(agentDir);

    const listed = await listGlobalSkills(config, skillResourceOptions({ bundledSkillsDir }));

    expect(listed).toEqual([
      {
        name: "alpha",
        source: "global",
        path: join(agentDir, "skills", "alpha.md"),
        skillPath: join(agentDir, "skills", "alpha.md"),
      },
      {
        name: "deep",
        source: "global",
        path: join(agentDir, "skills", "namespace", "deep"),
        skillPath: join(agentDir, "skills", "namespace", "deep", "SKILL.md"),
      },
      {
        name: "parent",
        source: "global",
        path: join(agentDir, "skills", "parent"),
        skillPath: join(agentDir, "skills", "parent", "SKILL.md"),
      },
    ]);
    await expect(readGlobalSkill(config, "alpha", skillResourceOptions({ bundledSkillsDir })))
      .resolves.toMatchObject({ content: "root alpha", source: "global" });
    await expect(readGlobalSkill(config, "deep", skillResourceOptions({ bundledSkillsDir })))
      .resolves.toMatchObject({ content: "deep skill", source: "global" });
  });

  it("applies global over accepted home over bundled precedence", async () => {
    const home = mkdtempSync(join("/dev/shm", "easyresearch-skill-home-"));
    const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-skill-agent-"));
    const bundledRoot = mkdtempSync(join("/dev/shm", "easyresearch-skill-bundled-"));
    const bundledSkillsDir = join(bundledRoot, "skills");
    tempDirs.push(home, agentDir, bundledRoot);
    mkdirSync(bundledSkillsDir, { recursive: true });
    writeDirectorySkill(bundledSkillsDir, "shared", "bundled");
    writeHomeSkill(home, "shared", "home");
    const config = new ConfigFileService(agentDir);
    const acceptedHome = skillResourceOptions({
      enableDotAgentsSkill: true,
      homeDir: home,
      bundledSkillsDir,
    });

    expect((await readGlobalSkill(config, "shared", acceptedHome))).toMatchObject({
      source: "home",
      content: expect.stringContaining("description: home"),
    });

    mkdirSync(join(agentDir, "skills"), { recursive: true });
    writeFileSync(join(agentDir, "skills", "shared.md"), "global", "utf8");
    expect((await readGlobalSkill(config, "shared", acceptedHome))).toMatchObject({
      source: "global",
      path: join(agentDir, "skills", "shared.md"),
      content: "global",
    });

    rmSync(join(agentDir, "skills", "shared.md"));
    const disabledHome = await readGlobalSkill(config, "shared", skillResourceOptions({
      enableDotAgentsSkill: false,
      homeDir: home,
      bundledSkillsDir,
    }));
    expect(disabledHome).toMatchObject({
      source: "bundled",
      content: expect.stringContaining("description: bundled"),
    });
  });

  it("discovers descriptors from a materialized bundled source root", async () => {
    const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-skill-agent-"));
    const bundledRoot = mkdtempSync(join("/dev/shm", "easyresearch-materialized-bundle-"));
    tempDirs.push(agentDir, bundledRoot);
    mkdirSync(join(bundledRoot, "skills"), { recursive: true });
    writeFileSync(join(bundledRoot, "skills", "root-bundled.md"), "materialized root", "utf8");
    writeDirectorySkill(join(bundledRoot, "skills", "namespace"), "nested-bundled", "materialized nested");
    process.env.EASYRESEARCH_BUNDLED_ROOT = bundledRoot;
    const config = new ConfigFileService(agentDir);

    const listed = await listGlobalSkills(config, skillResourceOptions());

    expect(listed).toEqual([
      {
        name: "nested-bundled",
        source: "bundled",
        path: join(bundledRoot, "skills", "namespace", "nested-bundled"),
        skillPath: join(bundledRoot, "skills", "namespace", "nested-bundled", "SKILL.md"),
      },
      {
        name: "root-bundled",
        source: "bundled",
        path: join(bundledRoot, "skills", "root-bundled.md"),
        skillPath: join(bundledRoot, "skills", "root-bundled.md"),
      },
    ]);
  });

  it("returns the same effective names and paths as runtime discovery", async () => {
    const home = mkdtempSync(join("/dev/shm", "easyresearch-skill-home-"));
    const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-skill-agent-"));
    const bundledRoot = mkdtempSync(join("/dev/shm", "easyresearch-skill-bundled-"));
    const bundledSkillsDir = join(bundledRoot, "skills");
    const globalSkillsDir = join(agentDir, "skills");
    tempDirs.push(home, agentDir, bundledRoot);
    mkdirSync(join(globalSkillsDir, "foo"), { recursive: true });
    mkdirSync(join(globalSkillsDir, "namespace", "deep"), { recursive: true });
    mkdirSync(bundledSkillsDir, { recursive: true });
    writeFileSync(join(globalSkillsDir, "foo.md"), "global root file", "utf8");
    writeFileSync(join(globalSkillsDir, "foo", "SKILL.md"), "global directory collision", "utf8");
    writeFileSync(join(globalSkillsDir, "namespace", "deep", "SKILL.md"), "global nested", "utf8");
    writeHomeSkill(home, "deep", "home fallback");
    writeDirectorySkill(bundledSkillsDir, "deep", "bundled fallback");
    const config = new ConfigFileService(agentDir);
    const options = skillResourceOptions({
      enableDotAgentsSkill: true,
      homeDir: home,
      bundledSkillsDir,
    });
    const runtime = {
      cwd: agentDir,
      agentDir,
      homeDir: home,
      bundledSkillsDir,
      enableDotAgentsSkill: true,
      includeProject: false,
    };

    const listed = await listGlobalSkills(config, options);

    expect(resolveSkillSelection(undefined, runtime).effectiveSkills).toEqual(listed.map((skill) => skill.name));
    for (const skill of listed) {
      expect(resolveSkillDirectories([skill.name], runtime)).toEqual([skill.path]);
    }
    expect(listed.find((skill) => skill.name === "foo")?.path).toBe(join(globalSkillsDir, "foo.md"));
    expect(listed.find((skill) => skill.name === "deep")?.path).toBe(join(globalSkillsDir, "namespace", "deep"));
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

  it("validates a global Research Assistant alias against its actual filename", async () => {
    const { agentDir, config } = tempConfig();
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    const aliasPath = join(agentDir, "agents", "Research Assistant.md");
    const edited = "---\nname: Research Assistant\ndescription: edited alias\n---\nAlias prompt\n";
    writeFileSync(aliasPath, "---\nname: Research Assistant\ndescription: alias\n---\nAlias prompt\n");

    const saved = await writeGlobalAgent(config, "research-assistant", edited);

    expect(saved.name).toBe("research-assistant");
    expect(readFileSync(aliasPath, "utf8")).toBe(edited);
    expect(existsSync(join(agentDir, "agents", "research-assistant.md"))).toBe(false);
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
    const read = await readGlobalSkill(config, "arxiv", skillResourceOptions());
    expect(read.source).toBe("bundled");
    expect(read.content).toBeDefined();
    expect((read.content ?? "").length).toBeGreaterThan(0);
    expect(existsSync(join(agentDir, "skills", "arxiv"))).toBe(false);
  });

  it("saving a bundled skill materializes the global skill dir and writes the edit", async () => {
    const { agentDir, config } = tempConfig();
    const edited = await writeGlobalSkill(
      config,
      "arxiv",
      "---\nname: arxiv\ndescription: edited\n---\nEdited skill\n",
      skillResourceOptions(),
    );
    expect(existsSync(join(agentDir, "skills", "arxiv", "SKILL.md"))).toBe(true);
    expect(edited.source).toBe("global");
    expect(edited.content).toContain("description: edited");
    expect(readFileSync(join(agentDir, "skills", "arxiv", "SKILL.md"), "utf8")).toContain("description: edited");
  });

  it("reading an unknown skill raises 404", async () => {
    const { config } = tempConfig();
    await expect(readGlobalSkill(config, "no-such-skill", skillResourceOptions())).rejects.toMatchObject({ status: 404 });
  });

  it("copies materialized root-file and nested-directory Skills on save using one atomic descriptor notification", async () => {
    const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-skill-res-"));
    const bundledRoot = mkdtempSync(join("/dev/shm", "easyresearch-materialized-bundle-"));
    tempDirs.push(agentDir, bundledRoot);
    mkdirSync(join(bundledRoot, "skills"), { recursive: true });
    writeFileSync(join(bundledRoot, "skills", "root-copy.md"), "root original", "utf8");
    const nestedSource = writeDirectorySkill(
      join(bundledRoot, "skills", "namespace"),
      "nested-copy",
      "nested original",
    );
    writeFileSync(join(nestedSource, "asset.bin"), Buffer.from([0, 1, 2, 255]));
    process.env.EASYRESEARCH_BUNDLED_ROOT = bundledRoot;
    const observations: Array<{ change: unknown; descriptors: string[] }> = [];
    const config = new ConfigFileService(agentDir, {
      onAuthoritativeWrite: async (change) => {
        const rootPath = join(agentDir, "skills", "root-copy.md");
        const nestedPath = join(agentDir, "skills", "nested-copy", "SKILL.md");
        observations.push({
          change,
          descriptors: [rootPath, nestedPath]
            .filter((path) => existsSync(path))
            .map((path) => readFileSync(path, "utf8")),
        });
      },
    });

    await writeGlobalSkill(config, "root-copy", "root edited", skillResourceOptions());
    await writeGlobalSkill(config, "nested-copy", "nested edited", skillResourceOptions());

    expect(observations).toEqual([
      { change: { skillsChanged: true }, descriptors: ["root edited"] },
      { change: { skillsChanged: true }, descriptors: ["root edited", "nested edited"] },
    ]);
    expect(readFileSync(join(agentDir, "skills", "root-copy.md"), "utf8")).toBe("root edited");
    expect(readFileSync(join(agentDir, "skills", "nested-copy", "SKILL.md"), "utf8")).toBe("nested edited");
    expect(readFileSync(join(agentDir, "skills", "nested-copy", "asset.bin"))).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it("serializes same-name selection through final write and recovers after a queued writer fails", async () => {
    const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-skill-res-"));
    const bundledRoot = mkdtempSync(join("/dev/shm", "easyresearch-materialized-bundle-"));
    tempDirs.push(agentDir, bundledRoot);
    const source = writeDirectorySkill(join(bundledRoot, "skills"), "queued-copy", "bundled source");
    writeFileSync(join(source, "asset.bin"), Buffer.from([11, 22, 33]));
    process.env.EASYRESEARCH_BUNDLED_ROOT = bundledRoot;
    const firstNotification = deferred();
    const releaseFirst = deferred();
    let notifications = 0;
    const config = new ConfigFileService(agentDir, {
      onAuthoritativeWrite: async () => {
        notifications += 1;
        if (notifications === 1) {
          firstNotification.resolve();
          await releaseFirst.promise;
        }
      },
    });
    const realWrite = config.write.bind(config);
    let writeCalls = 0;
    vi.spyOn(config, "write").mockImplementation(async (input) => {
      writeCalls += 1;
      if (writeCalls === 2) throw new Error("second final writer failed");
      await realWrite(input);
    });

    const first = writeGlobalSkill(config, "queued-copy", "first successful descriptor", skillResourceOptions());
    const second = writeGlobalSkill(config, "queued-copy", "second failed descriptor", skillResourceOptions());
    const secondOutcome = second.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await firstNotification.promise;
    releaseFirst.resolve();
    await first;
    const failed = await secondOutcome;

    expect(failed).toMatchObject({ ok: false, error: new Error("second final writer failed") });
    const target = join(agentDir, "skills", "queued-copy");
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("first successful descriptor");
    expect(readFileSync(join(target, "asset.bin"))).toEqual(Buffer.from([11, 22, 33]));
    expect(notifications).toBe(1);

    await writeGlobalSkill(config, "queued-copy", "retry descriptor", skillResourceOptions());

    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("retry descriptor");
    expect(readFileSync(join(target, "asset.bin"))).toEqual(Buffer.from([11, 22, 33]));
    expect(notifications).toBe(2);
  });

  it("keeps different Skill names independent while one final writer is blocked", async () => {
    const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-skill-res-"));
    const bundledRoot = mkdtempSync(join("/dev/shm", "easyresearch-materialized-bundle-"));
    tempDirs.push(agentDir, bundledRoot);
    writeDirectorySkill(join(bundledRoot, "skills"), "blocked-alpha", "alpha");
    writeDirectorySkill(join(bundledRoot, "skills"), "independent-beta", "beta");
    process.env.EASYRESEARCH_BUNDLED_ROOT = bundledRoot;
    const alphaBlocked = deferred();
    const releaseAlpha = deferred();
    const config = new ConfigFileService(agentDir);
    const realWrite = config.write.bind(config);
    vi.spyOn(config, "write").mockImplementation(async (input) => {
      if (input.path.endsWith("blocked-alpha/SKILL.md")) {
        alphaBlocked.resolve();
        await releaseAlpha.promise;
      }
      await realWrite(input);
    });

    const alpha = writeGlobalSkill(config, "blocked-alpha", "alpha edit", skillResourceOptions());
    await alphaBlocked.promise;
    let betaSettled = false;
    const beta = writeGlobalSkill(config, "independent-beta", "beta edit", skillResourceOptions()).finally(() => {
      betaSettled = true;
    });
    try {
      await vi.waitFor(() => expect(betaSettled).toBe(true));
      await beta;
      expect(readFileSync(join(agentDir, "skills", "independent-beta", "SKILL.md"), "utf8")).toBe("beta edit");
    } finally {
      releaseAlpha.resolve();
    }
    await alpha;
  });

  it.each(["home", "source-bundled", "materialized-bundled"] as const)(
    "copies a canonical in-root %s directory alias without mutating its source",
    async (sourceKind) => {
      const home = mkdtempSync(join("/dev/shm", "easyresearch-skill-home-"));
      const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-skill-res-"));
      const bundledRoot = mkdtempSync(join("/dev/shm", "easyresearch-materialized-bundle-"));
      const emptyBundled = join(bundledRoot, "empty-skills");
      tempDirs.push(home, agentDir, bundledRoot);
      mkdirSync(emptyBundled, { recursive: true });
      const sourceRoot = sourceKind === "home"
        ? join(home, ".agents", "skills")
        : join(bundledRoot, "skills");
      const aliasName = `alias-${sourceKind}`;
      const canonical = join(sourceRoot, `z-real-${sourceKind}`);
      const alias = join(sourceRoot, aliasName);
      mkdirSync(canonical, { recursive: true });
      const sourceDescriptor = join(canonical, "SKILL.md");
      const sourceAsset = join(canonical, "asset.bin");
      writeFileSync(sourceDescriptor, `source descriptor ${sourceKind}`, "utf8");
      writeFileSync(sourceAsset, Buffer.from([0, 17, 34, 255]));
      symlinkSync(`z-real-${sourceKind}`, alias, "dir");
      if (sourceKind === "materialized-bundled") process.env.EASYRESEARCH_BUNDLED_ROOT = bundledRoot;
      const options = skillResourceOptions({
        enableDotAgentsSkill: sourceKind === "home",
        homeDir: home,
        ...(sourceKind === "home" ? { bundledSkillsDir: emptyBundled } : {}),
        ...(sourceKind === "source-bundled" ? { bundledSkillsDir: join(bundledRoot, "skills") } : {}),
      });
      const notifications: unknown[] = [];
      const config = new ConfigFileService(agentDir, {
        onAuthoritativeWrite: async (change) => {
          notifications.push({
            change,
            bytes: readFileSync(join(agentDir, "skills", aliasName, "SKILL.md"), "utf8"),
          });
        },
      });

      await writeGlobalSkill(config, aliasName, `edited ${sourceKind}`, options);

      const target = join(agentDir, "skills", aliasName);
      expect(lstatSync(target).isDirectory()).toBe(true);
      expect(lstatSync(target).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(`edited ${sourceKind}`);
      expect(readFileSync(join(target, "asset.bin"))).toEqual(Buffer.from([0, 17, 34, 255]));
      expect(readFileSync(sourceDescriptor, "utf8")).toBe(`source descriptor ${sourceKind}`);
      expect(readFileSync(sourceAsset)).toEqual(Buffer.from([0, 17, 34, 255]));
      expect(notifications).toEqual([{
        change: { skillsChanged: true },
        bytes: `edited ${sourceKind}`,
      }]);
    },
  );

  it("copies logical assets when SKILL.md symlinks to a different in-root directory", async () => {
    const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-skill-res-"));
    const bundledRoot = mkdtempSync(join("/dev/shm", "easyresearch-materialized-bundle-"));
    const sourceRoot = join(bundledRoot, "skills");
    const logical = join(sourceRoot, "logical-assets");
    const descriptorTargetDirectory = join(sourceRoot, "descriptor-target");
    const descriptorTarget = join(descriptorTargetDirectory, "source-descriptor.md");
    tempDirs.push(agentDir, bundledRoot);
    mkdirSync(logical, { recursive: true });
    mkdirSync(descriptorTargetDirectory, { recursive: true });
    writeFileSync(join(logical, "asset.bin"), Buffer.from([0, 3, 6, 255]));
    writeFileSync(join(logical, "required.txt"), "logical required asset", "utf8");
    writeFileSync(descriptorTarget, "source descriptor", "utf8");
    writeFileSync(join(descriptorTargetDirectory, "unrelated-target.bin"), Buffer.from([99, 98, 97]));
    symlinkSync("../descriptor-target/source-descriptor.md", join(logical, "SKILL.md"), "file");
    const notifications: unknown[] = [];
    const config = new ConfigFileService(agentDir, {
      onAuthoritativeWrite: async (change) => {
        notifications.push({
          change,
          bytes: readFileSync(join(agentDir, "skills", "logical-assets", "SKILL.md"), "utf8"),
        });
      },
    });
    const options = skillResourceOptions({ bundledSkillsDir: sourceRoot });

    await writeGlobalSkill(config, "logical-assets", "edited descriptor", options);

    const target = join(agentDir, "skills", "logical-assets");
    expect(lstatSync(target).isDirectory()).toBe(true);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("edited descriptor");
    expect(readFileSync(join(target, "asset.bin"))).toEqual(Buffer.from([0, 3, 6, 255]));
    expect(readFileSync(join(target, "required.txt"), "utf8")).toBe("logical required asset");
    expect(existsSync(join(target, "unrelated-target.bin"))).toBe(false);
    expect(readFileSync(descriptorTarget, "utf8")).toBe("source descriptor");
    expect(readFileSync(join(descriptorTargetDirectory, "unrelated-target.bin"))).toEqual(Buffer.from([99, 98, 97]));
    expect(readFileSync(join(logical, "asset.bin"))).toEqual(Buffer.from([0, 3, 6, 255]));
    expect(lstatSync(join(logical, "SKILL.md")).isSymbolicLink()).toBe(true);
    expect(notifications).toEqual([{
      change: { skillsChanged: true },
      bytes: "edited descriptor",
    }]);
  });

  it("replaces an existing partial destination with a complete descriptor-free asset copy", async () => {
    const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-skill-res-"));
    const bundledRoot = mkdtempSync(join("/dev/shm", "easyresearch-materialized-bundle-"));
    tempDirs.push(agentDir, bundledRoot);
    const source = writeDirectorySkill(join(bundledRoot, "skills"), "partial-copy", "bundled source");
    writeFileSync(join(source, "asset.bin"), Buffer.from([1, 3, 5, 7]));
    mkdirSync(join(source, "templates"), { recursive: true });
    writeFileSync(join(source, "templates", "prompt.txt"), "required prompt", "utf8");
    const target = join(agentDir, "skills", "partial-copy");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "stale-only.txt"), "partial", "utf8");
    process.env.EASYRESEARCH_BUNDLED_ROOT = bundledRoot;
    const config = new ConfigFileService(agentDir);

    await writeGlobalSkill(config, "partial-copy", "edited descriptor", skillResourceOptions());

    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("edited descriptor");
    expect(readFileSync(join(target, "asset.bin"))).toEqual(Buffer.from([1, 3, 5, 7]));
    expect(readFileSync(join(target, "templates", "prompt.txt"), "utf8")).toBe("required prompt");
    expect(existsSync(join(target, "stale-only.txt"))).toBe(false);
  });

  it("cleans a mid-copy failure so retry materializes every asset before the descriptor", async () => {
    const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-skill-res-"));
    const bundledRoot = mkdtempSync(join("/dev/shm", "easyresearch-materialized-bundle-"));
    tempDirs.push(agentDir, bundledRoot);
    const source = writeDirectorySkill(join(bundledRoot, "skills"), "retry-copy", "bundled source");
    writeFileSync(join(source, "asset-a.bin"), Buffer.from([2, 4, 6]));
    writeFileSync(join(source, "asset-b.bin"), Buffer.from([8, 10, 12]));
    process.env.EASYRESEARCH_BUNDLED_ROOT = bundledRoot;
    const target = join(agentDir, "skills", "retry-copy");
    const config = new ConfigFileService(agentDir);
    cpSyncMock.mockImplementationOnce((sourcePath, destinationPath) => {
      const partial = String(destinationPath);
      mkdirSync(partial, { recursive: true });
      realCpSync.impl(join(String(sourcePath), "asset-a.bin"), join(partial, "asset-a.bin"));
      throw new Error("copy interrupted");
    });

    await expect(writeGlobalSkill(config, "retry-copy", "first edit", skillResourceOptions()))
      .rejects.toThrow("copy interrupted");

    expect(existsSync(target)).toBe(false);
    expect(readdirSync(agentDir).filter((name) => name.startsWith(".skill-copy-"))).toEqual([]);

    await writeGlobalSkill(config, "retry-copy", "retry edit", skillResourceOptions());

    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("retry edit");
    expect(readFileSync(join(target, "asset-a.bin"))).toEqual(Buffer.from([2, 4, 6]));
    expect(readFileSync(join(target, "asset-b.bin"))).toEqual(Buffer.from([8, 10, 12]));
    expect(readdirSync(agentDir).filter((name) => name.startsWith(".skill-copy-"))).toEqual([]);
  });

  it("does not materialize a copied descriptor when the final atomic writer fails", async () => {
    const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-skill-res-"));
    const bundledRoot = mkdtempSync(join("/dev/shm", "easyresearch-materialized-bundle-"));
    tempDirs.push(agentDir, bundledRoot);
    const source = writeDirectorySkill(join(bundledRoot, "skills"), "failed-copy", "bundled source");
    writeFileSync(join(source, "asset.bin"), Buffer.from([7, 8, 9]));
    process.env.EASYRESEARCH_BUNDLED_ROOT = bundledRoot;
    const onAuthoritativeWrite = vi.fn(async () => {});
    const config = new ConfigFileService(agentDir, { onAuthoritativeWrite });
    vi.spyOn(config, "write").mockRejectedValueOnce(new Error("atomic write failed"));

    await expect(writeGlobalSkill(config, "failed-copy", "edited", skillResourceOptions()))
      .rejects.toThrow("atomic write failed");

    expect(existsSync(join(agentDir, "skills", "failed-copy"))).toBe(false);
    expect(onAuthoritativeWrite).not.toHaveBeenCalled();
    await expect(readGlobalSkill(config, "failed-copy", skillResourceOptions()))
      .resolves.toMatchObject({ source: "bundled", content: expect.stringContaining("bundled source") });
  });

  it("restores an existing descriptor-free target when the final writer fails", async () => {
    const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-skill-res-"));
    const bundledRoot = mkdtempSync(join("/dev/shm", "easyresearch-materialized-bundle-"));
    tempDirs.push(agentDir, bundledRoot);
    const source = writeDirectorySkill(join(bundledRoot, "skills"), "restore-copy", "bundled source");
    writeFileSync(join(source, "asset.bin"), Buffer.from([7, 8, 9]));
    process.env.EASYRESEARCH_BUNDLED_ROOT = bundledRoot;
    const target = join(agentDir, "skills", "restore-copy");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "user-data.bin"), Buffer.from([1, 4, 9, 16]));
    const config = new ConfigFileService(agentDir);
    vi.spyOn(config, "write").mockRejectedValueOnce(new Error("atomic write failed"));

    await expect(writeGlobalSkill(config, "restore-copy", "edited", skillResourceOptions()))
      .rejects.toThrow("atomic write failed");

    expect(readdirSync(target)).toEqual(["user-data.bin"]);
    expect(readFileSync(join(target, "user-data.bin"))).toEqual(Buffer.from([1, 4, 9, 16]));
    expect(readdirSync(agentDir).filter((entry) => entry.startsWith(".skill-copy-"))).toEqual([]);
  });

  it("rejects a target created concurrently while staging copied Skill assets", async () => {
    const agentDir = mkdtempSync(join("/dev/shm", "easyresearch-skill-res-"));
    const bundledRoot = mkdtempSync(join("/dev/shm", "easyresearch-materialized-bundle-"));
    tempDirs.push(agentDir, bundledRoot);
    const source = writeDirectorySkill(join(bundledRoot, "skills"), "conflict-copy", "bundled source");
    writeFileSync(join(source, "asset.bin"), Buffer.from([7, 8, 9]));
    process.env.EASYRESEARCH_BUNDLED_ROOT = bundledRoot;
    const target = join(agentDir, "skills", "conflict-copy");
    const onAuthoritativeWrite = vi.fn(async () => {});
    const config = new ConfigFileService(agentDir, { onAuthoritativeWrite });
    cpSyncMock.mockImplementationOnce((sourcePath, destinationPath, options) => {
      realCpSync.impl(sourcePath, destinationPath, options);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "external.txt"), "external", "utf8");
    });

    await expect(writeGlobalSkill(config, "conflict-copy", "edited", skillResourceOptions()))
      .rejects.toThrow(/changed.*materialization/i);

    expect(readdirSync(target)).toEqual(["external.txt"]);
    expect(readFileSync(join(target, "external.txt"), "utf8")).toBe("external");
    expect(onAuthoritativeWrite).not.toHaveBeenCalled();
    expect(readdirSync(agentDir).filter((entry) => entry.startsWith(".skill-copy-"))).toEqual([]);
  });
});
