import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
        change: { agentsChanged: true },
        bytes: '{"easyresearch":{"agentDefaults":{"search":{"thinking":"high"}}}}',
      },
      { change: { modelsChanged: true }, bytes: '{"providers":{}}' },
    ]);
  });

  it("does not notify for project, unrelated global, or nested Agent writes", async () => {
    const onAuthoritativeWrite = vi.fn(async () => {});
    const notifying = new ConfigFileService(agentDir, { onAuthoritativeWrite });

    await notifying.write({ scope: "global", path: "notes.json", content: "{}" });
    await notifying.write({ scope: "global", path: "agents/nested/search.md", content: "nested" });
    await notifying.write({ scope: "global", path: "agents/search.txt", content: "text" });
    await notifying.write({ scope: "project", cwd, path: "agents/search.md", content: "project" });

    expect(onAuthoritativeWrite).not.toHaveBeenCalled();
  });

  it("does not notify when validation or the atomic rename fails", async () => {
    const onAuthoritativeWrite = vi.fn(async () => {});
    const notifying = new ConfigFileService(agentDir, { onAuthoritativeWrite });

    await expect(
      notifying.write({ scope: "global", path: "models.json", content: "{" }),
    ).rejects.toThrow(/Invalid JSON/);
    renameSyncMock.mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(
      notifying.write({ scope: "global", path: "agents/search.md", content: "candidate" }),
    ).rejects.toThrow("disk full");

    expect(onAuthoritativeWrite).not.toHaveBeenCalled();
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
