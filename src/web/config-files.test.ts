import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprintSkillRoot } from "../runtime/resource-fingerprint";
import { ConfigFileService, ConfigPathError, ConfigServiceError, resolveAllowedConfigPath } from "./config-files";

const { renameSyncMock, realRenameSync } = vi.hoisted(() => ({
  renameSyncMock: vi.fn<typeof fs.renameSync>(),
  realRenameSync: { impl: null as unknown as typeof fs.renameSync },
}));

vi.mock("node:fs", async (importOriginal) => {
  const mod = await importOriginal<typeof fs>();
  realRenameSync.impl = mod.renameSync;
  renameSyncMock.mockImplementation(mod.renameSync);
  return { ...mod, renameSync: renameSyncMock };
});

const tempDirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "easyresearch-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  renameSyncMock.mockReset();
  renameSyncMock.mockImplementation(realRenameSync.impl);
});

describe("resolveAllowedConfigPath", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = freshDir();
    outside = freshDir();
    writeFileSync(join(outside, "secret.txt"), "out");
    symlinkSync(outside, join(root, "escape"));
    symlinkSync(join(root, "inside"), join(root, "link-in"));
    mkdirSync(join(root, "inside"), { recursive: true });
    writeFileSync(join(root, "inside", "file.txt"), "in");
  });

  it("rejects an empty relative path", () => {
    expect(() => resolveAllowedConfigPath(root, "", "read")).toThrow(ConfigPathError);
    expect(() => resolveAllowedConfigPath(root, "", "write")).toThrow(ConfigPathError);
  });

  it("resolves ordinary nested files inside the root", () => {
    expect(resolveAllowedConfigPath(root, "a/b/c", "write")).toBe(join(root, "a/b/c"));
    expect(resolveAllowedConfigPath(root, "inside/file.txt", "read")).toBe(join(root, "inside/file.txt"));
  });

  it("rejects parent-directory escapes", () => {
    expect(() => resolveAllowedConfigPath(root, "..", "read")).toThrow(ConfigPathError);
    expect(() => resolveAllowedConfigPath(root, "../x", "read")).toThrow(ConfigPathError);
    expect(() => resolveAllowedConfigPath(root, "a/../../x", "read")).toThrow(ConfigPathError);
    expect(() => resolveAllowedConfigPath(root, "../x", "write")).toThrow(ConfigPathError);
  });

  it("rejects absolute paths and NUL bytes", () => {
    expect(() => resolveAllowedConfigPath(root, "/etc/passwd", "read")).toThrow(ConfigPathError);
    expect(() => resolveAllowedConfigPath(root, "/etc/passwd", "write")).toThrow(ConfigPathError);
    expect(() => resolveAllowedConfigPath(root, "a\0b", "write")).toThrow(ConfigPathError);
  });

  it("rejects an existing symlink that escapes the root", () => {
    expect(() => resolveAllowedConfigPath(root, "escape/secret.txt", "read")).toThrow(ConfigPathError);
    expect(() => resolveAllowedConfigPath(root, "escape/secret.txt", "write")).toThrow(ConfigPathError);
  });

  it("rejects a missing target below a symlinked parent that escapes", () => {
    expect(() => resolveAllowedConfigPath(root, "escape/new.txt", "write")).toThrow(ConfigPathError);
  });

  it("allows an in-root symlink whose canonical target stays in root", () => {
    expect(resolveAllowedConfigPath(root, "link-in/file.txt", "read")).toBe(join(root, "inside/file.txt"));
  });

  it("returns 404 for missing targets in read mode, keeping 403 for escapes", () => {
    expect(() => resolveAllowedConfigPath(root, "missing.txt", "read")).toThrow(ConfigServiceError);
    try {
      resolveAllowedConfigPath(root, "missing.txt", "read");
    } catch (error) {
      expect((error as ConfigServiceError).status).toBe(404);
    }
    expect(() => resolveAllowedConfigPath(root, "missing.txt", "write")).not.toThrow();
  });
});

describe("ConfigFileService", () => {
  let agentDir: string;
  let cwd: string;
  let service: ConfigFileService;

  beforeEach(() => {
    agentDir = freshDir();
    cwd = freshDir();
    service = new ConfigFileService(agentDir);
  });

  it("writes and reads a project settings.json", async () => {
    await service.write({
      scope: "project",
      cwd,
      path: "settings.json",
      content: '{\n  "defaultModel": "x"\n}\n',
    });
    expect(await service.read({ scope: "project", cwd, path: "settings.json" })).toContain("defaultModel");
  });

  it("validates BOM-prefixed global and project settings while preserving submitted text", async () => {
    const content = '\uFEFF{\n  "defaultModel": "x"\n}\n';

    await service.write({ scope: "global", path: "settings.json", content });
    await service.write({ scope: "project", cwd, path: "settings.json", content });

    expect(await service.read({ scope: "global", path: "settings.json" })).toBe(content);
    expect(await service.read({ scope: "project", cwd, path: "settings.json" })).toBe(content);
  });

  it("does not extend settings BOM compatibility to other JSON files", async () => {
    await expect(
      service.write({ scope: "global", path: "models.json", content: '\uFEFF{"providers":{}}' }),
    ).rejects.toThrow(/Invalid JSON/);
  });

  it("returns 404 when reading a missing settings.json", async () => {
    await expect(service.read({ scope: "project", cwd, path: "settings.json" })).rejects.toThrow(ConfigServiceError);
    try {
      await service.read({ scope: "project", cwd, path: "settings.json" });
    } catch (error) {
      expect((error as ConfigServiceError).status).toBe(404);
    }
  });

  it("rejects invalid JSON and leaves the existing file unchanged", async () => {
    const modelsPath = join(agentDir, "models.json");
    const original = '{"providers":{}}';
    writeFileSync(modelsPath, original);
    await expect(service.write({ scope: "global", path: "models.json", content: "{" })).rejects.toThrow(/Invalid JSON/);
    expect(readFileSync(modelsPath, "utf8")).toBe(original);
  });

  it("notifies after atomic direct global Agent, Agent-default, and models.json writes", async () => {
    const observations: Array<{ change: unknown; bytes: string }> = [];
    const notifying = new ConfigFileService(agentDir, {
      onAuthoritativeWrite: async (change) => {
        const path = change.modelsChanged
          ? join(agentDir, "models.json")
          : fs.existsSync(join(agentDir, "settings.json"))
            ? join(agentDir, "settings.json")
            : join(agentDir, "agents", "search.md");
        observations.push({ change, bytes: readFileSync(path, "utf8") });
      },
    });

    await notifying.write({
      scope: "global",
      path: "agents/search.md",
      content: "---\nname: search\n---\nPrompt\n",
    });
    await notifying.write({
      scope: "global",
      path: "settings.json",
      content: '{"easyresearch":{"agentDefaults":{"search":{"thinking":"high"}}}}',
    });
    await notifying.write({
      scope: "global",
      path: "models.json",
      content: '{"providers":{}}',
    });

    expect(observations).toEqual([
      { change: { agentsChanged: true }, bytes: "---\nname: search\n---\nPrompt\n" },
      {
        change: {},
        bytes: '{"easyresearch":{"agentDefaults":{"search":{"thinking":"high"}}}}',
      },
      { change: { modelsChanged: true }, bytes: '{"providers":{}}' },
    ]);
  });

  it("notifies exactly once after atomic root and nested global Skill descriptor writes", async () => {
    const observations: Array<{ change: unknown; path: string; bytes: string }> = [];
    let expectedPath = "";
    const notifying = new ConfigFileService(agentDir, {
      onAuthoritativeWrite: async (change) => {
        observations.push({
          change,
          path: expectedPath,
          bytes: readFileSync(join(agentDir, expectedPath), "utf8"),
        });
      },
    });

    expectedPath = "skills/root-skill.md";
    await notifying.write({
      scope: "global",
      path: expectedPath,
      content: "root descriptor",
    });
    expectedPath = "skills/namespace/deep/SKILL.md";
    await notifying.write({
      scope: "global",
      path: expectedPath,
      content: "nested descriptor",
    });

    expect(observations).toEqual([
      {
        change: { skillsChanged: true },
        path: "skills/root-skill.md",
        bytes: "root descriptor",
      },
      {
        change: { skillsChanged: true },
        path: "skills/namespace/deep/SKILL.md",
        bytes: "nested descriptor",
      },
    ]);
  });

  it("acquires an exact project before each descriptor write, synchronizes persisted bytes once, and releases", async () => {
    const events: string[] = [];
    let owned = false;
    const notifying = new ConfigFileService(agentDir, {
      acquireProject: async (observedCwd) => {
        events.push(`acquire:${observedCwd}`);
        owned = true;
        return {
          cwd: observedCwd,
          release: async () => {
            expect(owned).toBe(true);
            owned = false;
            events.push(`release:${observedCwd}`);
          },
        };
      },
      synchronizeProject: async (observedCwd) => {
        expect(owned).toBe(true);
        const descriptorRoot = join(cwd, ".easyresearch", "skills");
        const descriptor = fs.existsSync(join(descriptorRoot, "root-project.md"))
          ? join(descriptorRoot, "root-project.md")
          : join(descriptorRoot, "namespace", "deep", "SKILL.md");
        events.push(`synchronize:${observedCwd}:${readFileSync(descriptor, "utf8")}`);
      },
    });

    await notifying.write({
      scope: "project",
      cwd,
      path: "skills/namespace/deep/SKILL.md",
      content: "nested project descriptor",
    });
    await notifying.write({
      scope: "project",
      cwd,
      path: "skills/root-project.md",
      content: "root project descriptor",
    });

    expect(events).toEqual([
      `acquire:${cwd}`,
      `synchronize:${cwd}:nested project descriptor`,
      `release:${cwd}`,
      `acquire:${cwd}`,
      `synchronize:${cwd}:root project descriptor`,
      `release:${cwd}`,
    ]);
    expect(owned).toBe(false);
    expect(readFileSync(join(cwd, ".easyresearch", "skills", "namespace", "deep", "SKILL.md"), "utf8"))
      .toBe("nested project descriptor");
    expect(readFileSync(join(cwd, ".easyresearch", "skills", "root-project.md"), "utf8"))
      .toBe("root project descriptor");
  });

  it("resolves a project descriptor target only after exact-cwd acquisition", async () => {
    const projectA = freshDir();
    const projectB = freshDir();
    const alias = join(freshDir(), "project-link");
    symlinkSync(projectA, alias, process.platform === "win32" ? "junction" : "dir");
    const previousDescriptor = join(projectA, ".easyresearch", "skills", "retargeted", "SKILL.md");
    mkdirSync(join(previousDescriptor, ".."), { recursive: true });
    writeFileSync(previousDescriptor, "accepted project", "utf8");
    const events: string[] = [];
    const notifying = new ConfigFileService(agentDir, {
      acquireProject: async (observedCwd) => {
        events.push(`acquire:${observedCwd}`);
        fs.unlinkSync(alias);
        symlinkSync(projectB, alias, process.platform === "win32" ? "junction" : "dir");
        return {
          cwd: observedCwd,
          release: async () => {
            events.push(`release:${observedCwd}`);
          },
        };
      },
      synchronizeProject: async (observedCwd) => {
        events.push(`synchronize:${observedCwd}`);
      },
    });

    await notifying.write({
      scope: "project",
      cwd: alias,
      path: "skills/retargeted/SKILL.md",
      content: "current project",
    });

    expect(readFileSync(previousDescriptor, "utf8")).toBe("accepted project");
    expect(readFileSync(join(projectB, ".easyresearch", "skills", "retargeted", "SKILL.md"), "utf8"))
      .toBe("current project");
    expect(events).toEqual([`acquire:${alias}`, `synchronize:${alias}`, `release:${alias}`]);
  });

  it("rolls back a project descriptor when the exact cwd retargets during atomic rename", async () => {
    const projectA = freshDir();
    const projectB = freshDir();
    const alias = join(freshDir(), "project-link");
    symlinkSync(projectA, alias, process.platform === "win32" ? "junction" : "dir");
    const previousDescriptor = join(projectA, ".easyresearch", "skills", "retargeted", "SKILL.md");
    mkdirSync(join(previousDescriptor, ".."), { recursive: true });
    writeFileSync(previousDescriptor, "accepted project", "utf8");
    const events: string[] = [];
    const notifying = new ConfigFileService(agentDir, {
      acquireProject: async (observedCwd) => ({
        cwd: observedCwd,
        release: async () => {
          events.push(`release:${observedCwd}`);
        },
      }),
      synchronizeProject: async (observedCwd) => {
        events.push(`synchronize:${observedCwd}`);
      },
    });
    let retargeted = false;
    renameSyncMock.mockImplementation((source, target) => {
      if (!retargeted && String(target).endsWith(join("retargeted", "SKILL.md"))) {
        retargeted = true;
        fs.unlinkSync(alias);
        symlinkSync(projectB, alias, process.platform === "win32" ? "junction" : "dir");
      }
      realRenameSync.impl(source, target);
    });

    await expect(notifying.write({
      scope: "project",
      cwd: alias,
      path: "skills/retargeted/SKILL.md",
      content: "stale project",
    })).rejects.toThrow(/project.*changed/i);

    expect(readFileSync(previousDescriptor, "utf8")).toBe("accepted project");
    expect(fs.existsSync(join(projectB, ".easyresearch", "skills", "retargeted", "SKILL.md"))).toBe(false);
    expect(events).toEqual([`release:${alias}`]);
  });

  it("keeps auxiliary Skills, empty directories, project Agents, and unrelated writes silent", async () => {
    const onAuthoritativeWrite = vi.fn(async () => {});
    const projectEvents: string[] = [];
    const notifying = new ConfigFileService(agentDir, {
      onAuthoritativeWrite,
      acquireProject: async (observedCwd) => {
        projectEvents.push(`acquire:${observedCwd}`);
        return {
          cwd: observedCwd,
          release: async () => {
            projectEvents.push(`release:${observedCwd}`);
          },
        };
      },
      synchronizeProject: async (observedCwd) => {
        projectEvents.push(`synchronize:${observedCwd}`);
      },
    });
    const globalBefore = await fingerprintSkillRoot(join(agentDir, "skills"), "global");
    const projectBefore = await fingerprintSkillRoot(join(cwd, ".easyresearch", "skills"), `project:${cwd}`);

    await notifying.write({ scope: "global", path: "notes.json", content: "{}" });
    await notifying.write({ scope: "global", path: "agents/nested/search.md", content: "nested" });
    await notifying.write({ scope: "global", path: "agents/search.txt", content: "text" });
    await notifying.write({ scope: "global", path: "skills/tool/helper.ts", content: "helper" });
    await notifying.write({ scope: "global", path: "skills/tool/README.md", content: "readme" });
    await notifying.write({ scope: "project", cwd, path: "agents/search.md", content: "project" });
    await notifying.write({ scope: "project", cwd, path: "skills/tool/helper.ts", content: "helper" });
    await notifying.write({ scope: "project", cwd, path: "skills/tool/README.md", content: "readme" });
    await notifying.createDirectory({ scope: "global", path: "skills/empty/nested" });
    await notifying.createDirectory({ scope: "project", cwd, path: "skills/empty/nested" });

    expect(onAuthoritativeWrite).not.toHaveBeenCalled();
    expect(projectEvents).toEqual([]);
    expect(await fingerprintSkillRoot(join(agentDir, "skills"), "global")).toEqual(globalBefore);
    expect(await fingerprintSkillRoot(join(cwd, ".easyresearch", "skills"), `project:${cwd}`)).toEqual(projectBefore);
  });

  it("does not notify when validation or the atomic rename fails", async () => {
    const onAuthoritativeWrite = vi.fn(async () => {});
    const notifying = new ConfigFileService(agentDir, { onAuthoritativeWrite });
    const skillBefore = await fingerprintSkillRoot(join(agentDir, "skills"), "global");

    await expect(
      notifying.write({ scope: "global", path: "models.json", content: "{" }),
    ).rejects.toThrow(/Invalid JSON/);
    renameSyncMock.mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(
      notifying.write({ scope: "global", path: "agents/search.md", content: "candidate" }),
    ).rejects.toThrow("disk full");
    await expect(
      notifying.write({ scope: "global", path: "skills/search.md", content: "candidate" }),
    ).rejects.toThrow("disk full");

    expect(onAuthoritativeWrite).not.toHaveBeenCalled();
    expect(await fingerprintSkillRoot(join(agentDir, "skills"), "global")).toEqual(skillBefore);
  });

  it("releases project ownership without synchronization when atomic persistence fails", async () => {
    const events: string[] = [];
    const skillRoot = join(cwd, ".easyresearch", "skills");
    const skillBefore = await fingerprintSkillRoot(skillRoot, `project:${cwd}`);
    const notifying = new ConfigFileService(agentDir, {
      acquireProject: async (observedCwd) => {
        events.push(`acquire:${observedCwd}`);
        return {
          cwd: observedCwd,
          release: async () => {
            events.push(`release:${observedCwd}`);
          },
        };
      },
      synchronizeProject: async (observedCwd) => {
        events.push(`synchronize:${observedCwd}`);
      },
    });
    renameSyncMock.mockImplementation(() => {
      throw new Error("disk full");
    });

    await expect(notifying.write({
      scope: "project",
      cwd,
      path: "skills/failed/SKILL.md",
      content: "candidate",
    })).rejects.toThrow("disk full");

    expect(events).toEqual([`acquire:${cwd}`, `release:${cwd}`]);
    expect(fs.existsSync(join(cwd, ".easyresearch", "skills", "failed", "SKILL.md"))).toBe(false);
    expect(await fingerprintSkillRoot(skillRoot, `project:${cwd}`)).toEqual(skillBefore);
  });

  it("releases project ownership after a post-persistence synchronization failure", async () => {
    const events: string[] = [];
    const target = join(cwd, ".easyresearch", "skills", "saved", "SKILL.md");
    const notifying = new ConfigFileService(agentDir, {
      acquireProject: async (observedCwd) => {
        events.push(`acquire:${observedCwd}`);
        return {
          cwd: observedCwd,
          release: async () => {
            events.push(`release:${observedCwd}`);
          },
        };
      },
      synchronizeProject: async (observedCwd) => {
        events.push(`synchronize:${observedCwd}:${readFileSync(target, "utf8")}`);
        throw new Error("synchronization failed");
      },
    });

    await expect(notifying.write({
      scope: "project",
      cwd,
      path: "skills/saved/SKILL.md",
      content: "persisted before synchronization",
    })).rejects.toThrow("synchronization failed");

    expect(events).toEqual([
      `acquire:${cwd}`,
      `synchronize:${cwd}:persisted before synchronization`,
      `release:${cwd}`,
    ]);
    expect(readFileSync(target, "utf8")).toBe("persisted before synchronization");
  });

  it("writes via a same-directory temporary file and atomic rename", async () => {
    await service.write({ scope: "global", path: "settings.json", content: '{"defaultModel":"a"}' });
    expect(renameSyncMock).toHaveBeenCalledTimes(1);
    const [tmp, target] = renameSyncMock.mock.calls[0] as [string, string];
    expect(target).toBe(join(agentDir, "settings.json"));
    expect(tmp).not.toBe(target);
    expect(tmp.startsWith(join(agentDir, "."))).toBe(true);
    expect(readdirSync(agentDir)).not.toContain(tmp.split("/").pop());
    expect(readFileSync(target, "utf8")).toBe('{"defaultModel":"a"}');
  });

  it("serializes global settings read-modify-write operations without losing sibling fields", async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));

    await Promise.all([
      service.mutateGlobalSettings((settings) => ({
        settings: {
          ...settings,
          easyresearch: { agentDefaults: { search: { thinking: "high" } } },
        },
        result: "agents",
      })),
      service.mutateGlobalSettings((settings) => ({
        settings: {
          ...settings,
          easyresearch: {
            ...(settings.easyresearch as Record<string, unknown> | undefined),
            compaction: { triggerPercent: 80 },
          },
        },
        result: "compaction",
      })),
    ]);

    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
      theme: "dark",
      easyresearch: {
        agentDefaults: { search: { thinking: "high" } },
        compaction: { triggerPercent: 80 },
      },
    });
  });

  it("mutates BOM-prefixed global settings with the existing formatted output", async () => {
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(settingsPath, '\uFEFF{"theme":"dark","future":{"keep":true}}', "utf8");

    await service.mutateGlobalSettings((settings) => ({
      settings: { ...settings, easyresearch: { compaction: { triggerPercent: 80 } } },
      result: undefined,
    }));

    expect(readFileSync(settingsPath, "utf8")).toBe(
      '{\n  "theme": "dark",\n  "future": {\n    "keep": true\n  },\n  "easyresearch": {\n    "compaction": {\n      "triggerPercent": 80\n    }\n  }\n}\n',
    );
  });

  it("retries a settings mutation when BOM-prefixed source bytes change after its read", async () => {
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(settingsPath, `\uFEFF${JSON.stringify({ theme: "dark" })}`);
    let attempts = 0;

    await service.mutateGlobalSettings((settings) => {
      attempts += 1;
      if (attempts === 1) {
        writeFileSync(settingsPath, JSON.stringify({ theme: "light", external: { keep: true } }));
      }
      return {
        settings: { ...settings, easyresearch: { agentDefaults: { search: { thinking: "high" } } } },
        result: undefined,
      };
    });

    expect(attempts).toBe(2);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      theme: "light",
      external: { keep: true },
      easyresearch: { agentDefaults: { search: { thinking: "high" } } },
    });
  });

  it("rejects malformed current global settings without overwriting their bytes", async () => {
    const settingsPath = join(agentDir, "settings.json");
    writeFileSync(settingsPath, "{malformed", "utf8");

    await expect(service.mutateGlobalSettings((settings) => ({ settings, result: undefined })))
      .rejects.toMatchObject({ status: 409 });
    expect(readFileSync(settingsPath, "utf8")).toBe("{malformed");
  });

  it("cleans up the temporary file when rename fails", async () => {
    renameSyncMock.mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(
      service.write({ scope: "global", path: "settings.json", content: '{"defaultModel":"a"}' }),
    ).rejects.toThrow("disk full");
    expect(renameSyncMock).toHaveBeenCalledTimes(1);
    expect(readdirSync(agentDir).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("lists global root entries and created directories", async () => {
    writeFileSync(join(agentDir, "settings.json"), "{}");
    const initial = await service.list({ scope: "global" });
    expect(initial.map((e) => e.name)).toEqual(["settings.json"]);
    await service.createDirectory({ scope: "global", path: "agents" });
    const after = await service.list({ scope: "global" });
    expect(after.map((e) => e.name)).toEqual(["agents", "settings.json"]);
    expect(after.find((e) => e.name === "agents")?.type).toBe("directory");
    expect(after.find((e) => e.name === "settings.json")?.type).toBe("file");
  });

  it("creates the project .easyresearch root lazily on write", async () => {
    expect(await service.list({ scope: "project", cwd })).toEqual([]);
    await service.createDirectory({ scope: "project", cwd, path: "sub" });
    const entries = await service.list({ scope: "project", cwd });
    expect(entries.map((e) => e.name)).toEqual(["sub"]);
  });

  it("returns paths relative to the allowed root so clients can round-trip them", async () => {
    writeFileSync(join(agentDir, "settings.json"), "{}");
    writeFileSync(join(agentDir, "models.json"), "{}");
    await service.createDirectory({ scope: "global", path: "agents" });
    writeFileSync(join(agentDir, "agents", "x.json"), "{}");
    const top = await service.list({ scope: "global" });
    for (const entry of top) {
      expect(entry.path).not.toBe(join(agentDir, entry.name));
      expect(entry.path).toBe(entry.name);
    }
    const sub = await service.list({ scope: "global", path: "agents" });
    expect(sub.map((e) => e.path)).toEqual(["agents/x.json"]);
  });

  it("refuses to escape the project root via traversal", async () => {
    await expect(
      service.write({ scope: "project", cwd, path: "../evil.txt", content: "x" }),
    ).rejects.toThrow(ConfigPathError);
  });
});
