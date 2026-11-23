import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { backupWindowsInstallation } from "./update-files";

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
