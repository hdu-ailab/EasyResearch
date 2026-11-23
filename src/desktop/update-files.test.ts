import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, lstat, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { backupWindowsInstallation, physicalUpdateFilePath, updateFileHash } from "./update-files";

it("uses the supplied physical reader for both identity checks and exact file bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-raw-update-"));
  try {
    const file = join(root, "app.asar"); const bytes = Buffer.from([0, 255, 128, 13, 10, 42]);
    await writeFile(file, bytes);
    const reader = { lstat, realpath, read: (path: string) => createReadStream(path) };
    expect(await updateFileHash(file, reader)).toBe(createHash("sha256").update(bytes).digest("hex"));
    let streamed = false;
    await expect(updateFileHash(file, { ...reader,
      lstat: async () => { throw new Error("physical identity unavailable"); },
      read: path => { streamed = true; return createReadStream(path); },
    })).rejects.toThrow("physical identity unavailable");
    expect(streamed).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("normalizes filesystem aliases while rejecting symbolic links in any path component", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-update-alias-"));
  try {
    const directory = join(root, "long installation"); await mkdir(directory);
    const physical = join(directory, "app.asar"); await writeFile(physical, "archive bytes");
    const alias = join(root, "SHORT~1", "app.asar");
    let linked: string | undefined;
    const reader = {
      lstat: async (path: string) => {
        const stat = await lstat(path === alias ? physical : path === dirname(alias) ? directory : path);
        return path === linked ? Object.assign(stat, { isSymbolicLink: () => true }) : stat;
      },
      realpath: async () => physical,
      read: (path: string) => createReadStream(path),
    };
    expect(await physicalUpdateFilePath(alias, reader)).toBe(physical);
    expect(await updateFileHash(await physicalUpdateFilePath(alias, reader), reader)).toBe(createHash("sha256").update("archive bytes").digest("hex"));
    for (const path of [alias, dirname(alias)]) {
      linked = path;
      await expect(physicalUpdateFilePath(alias, reader)).rejects.toThrow(/link/i);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("copies binary installation files and never adopts an existing recovery directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-update-backup-"));
  try {
    const source = join(root, "installed"); const backup = join(root, "backup");
    await mkdir(source); await writeFile(join(source, "EasyResearch.exe"), Buffer.from([0, 255, 128]));
    const created = vi.fn(); await backupWindowsInstallation(source, backup, new AbortController().signal, created);
    expect(created).toHaveBeenCalledOnce(); expect(await readFile(join(backup, "EasyResearch.exe"))).toEqual(Buffer.from([0, 255, 128]));
    const foreign = vi.fn();
    await expect(backupWindowsInstallation(source, backup, new AbortController().signal, foreign)).rejects.toThrow();
    expect(foreign).not.toHaveBeenCalled(); expect(await readFile(join(backup, "EasyResearch.exe"))).toEqual(Buffer.from([0, 255, 128]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === "win32")("refuses to follow a linked installation file into user work", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-update-backup-"));
  try {
    const source = join(root, "installed"); await mkdir(source);
    await writeFile(join(root, "user-work"), "preserve"); await symlink(join(root, "user-work"), join(source, "linked"));
    const owned = vi.fn();
    await expect(backupWindowsInstallation(source, join(root, "backup"), new AbortController().signal, owned)).rejects.toThrow(/Linked/);
    expect(owned).toHaveBeenCalledOnce(); expect(await readFile(join(root, "user-work"), "utf8")).toBe("preserve");
  } finally { await rm(root, { recursive: true, force: true }); }
});
