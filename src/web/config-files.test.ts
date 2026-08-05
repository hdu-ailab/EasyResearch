import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigFileService, ConfigPathError, resolveAllowedConfigPath } from "./config-files";

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
  const dir = mkdtempSync(join(tmpdir(), "lazyresearch-config-"));
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

  it("requires existing targets in read mode", () => {
    expect(() => resolveAllowedConfigPath(root, "missing.txt", "read")).toThrow(ConfigPathError);
    expect(resolveAllowedConfigPath(root, "missing.txt", "write")).toBe(join(root, "missing.txt"));
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

  it("rejects invalid JSON and leaves the existing file unchanged", async () => {
    const modelsPath = join(agentDir, "models.json");
    const original = '{"providers":{}}';
    writeFileSync(modelsPath, original);
    await expect(service.write({ scope: "global", path: "models.json", content: "{" })).rejects.toThrow(/Invalid JSON/);
    expect(readFileSync(modelsPath, "utf8")).toBe(original);
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

  it("creates the project .lazyresearch root lazily on write", async () => {
    expect(await service.list({ scope: "project", cwd })).toEqual([]);
    await service.createDirectory({ scope: "project", cwd, path: "sub" });
    const entries = await service.list({ scope: "project", cwd });
    expect(entries.map((e) => e.name)).toEqual(["sub"]);
  });

  it("refuses to escape the project root via traversal", async () => {
    await expect(
      service.write({ scope: "project", cwd, path: "../evil.txt", content: "x" }),
    ).rejects.toThrow(ConfigPathError);
  });
});
