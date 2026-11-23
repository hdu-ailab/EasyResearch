import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveFileReferences, validateFileReferences } from "./file-references";

const roots: string[] = [];
async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "file-references-")));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
describe("file reference resolution", () => {
  it("does not substitute a suffix match when the exact path was deliberately unprobed", async () => {
    const cwd = await workspace(); const outside = await workspace();
    await writeFile(join(outside, "report.txt"), "original");
    await symlink(outside, join(cwd, "link"), process.platform === "win32" ? "junction" : "dir");
    await mkdir(join(cwd, "nested", "link"), { recursive: true });
    await writeFile(join(cwd, "nested", "link", "report.txt"), "different file");
    expect((await resolveFileReferences(cwd, ["link/report.txt"])).references).toEqual([
      { reference: "link/report.txt", paths: [], truncated: false },
    ]);
  });
  it("prefers literal regular files, otherwise returns every workspace suffix match", async () => {
    const cwd = await workspace();
    for (const folder of ["a", "b"]) { await mkdir(join(cwd, folder)); await writeFile(join(cwd, folder, "README"), ""); }
    await writeFile(join(cwd, "a", "100% #报告.weird"), "");
    const result = await resolveFileReferences(cwd, ["README", "a/README", "100% #报告.weird", "missing", "a"]);
    expect(result.references).toEqual([
      { reference: "README", paths: [join(cwd, "a/README"), join(cwd, "b/README")], truncated: false },
      { reference: "a/README", paths: [join(cwd, "a/README")], truncated: false },
      { reference: "100% #报告.weird", paths: [join(cwd, "a/100% #报告.weird")], truncated: false },
      { reference: "missing", paths: [], truncated: false },
      { reference: "a", paths: [], truncated: false },
    ]);
    await writeFile(join(cwd, "README"), "");
    expect((await resolveFileReferences(cwd, ["README"])).references[0]?.paths).toEqual([join(cwd, "README")]);
  });
  it("never follows directory symlinks or probes network shares, but supports absolute local files", async () => {
    const cwd = await workspace(); const outside = await workspace();
    await writeFile(join(outside, "secret"), "");
    await symlink(outside, join(cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
    const result = await resolveFileReferences(cwd, ["secret", "escape/secret", "\\\\host\\share\\file", "//host/share/file", join(outside, "secret")]);
    expect(result.references.slice(0, 4).every((entry) => entry.paths.length === 0)).toBe(true);
    expect(result.references[4]?.paths).toEqual([join(outside, "secret")]);
  });
  it("marks incomplete searches and owns cancellation", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, "a")); await writeFile(join(cwd, "a", "file"), "");
    expect((await resolveFileReferences(cwd, ["file"], undefined, { maxEntries: 1 })).references[0]?.truncated).toBe(true);
    const controller = new AbortController(); controller.abort();
    await expect(resolveFileReferences(cwd, ["file"], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("accepts local workspace aliases without following an escaping descendant directory", async () => {
    const parent = await workspace(); const cwd = join(parent, "real"); await mkdir(cwd);
    await writeFile(join(cwd, "README"), "");
    const alias = join(parent, "alias"); await symlink(cwd, alias, process.platform === "win32" ? "junction" : "dir");
    expect((await resolveFileReferences(alias, ["README"])).references[0]?.paths).toEqual([join(alias, "README")]);
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("shares typed permission errors and marks unreadable subtrees incomplete", async () => {
    const cwd = await workspace(); const unreadable = join(cwd, "README");
    await writeFile(unreadable, ""); await chmod(unreadable, 0);
    await expect(resolveFileReferences(cwd, ["README"])).rejects.toMatchObject({ status: 403 });
    await chmod(unreadable, 0o600);
    const privateDir = join(cwd, "private"); await mkdir(privateDir); await chmod(privateDir, 0);
    try { expect((await resolveFileReferences(cwd, ["absent"])).references[0]?.truncated).toBe(true); }
    finally { await chmod(privateDir, 0o700); }
  });
  it("bounds and validates the literal metadata-only request", () => {
    for (const references of [[], [""], ["a\0b"], ["x".repeat(4097)], Array(65).fill("a"), [1]]) {
      expect(() => validateFileReferences({ references })).toThrow();
    }
    expect(validateFileReferences({ references: ["a", "a", "100%#b"] })).toEqual(["a", "100%#b"]);
    expect(() => validateFileReferences({ references: ["a"], cwd: "/elsewhere" })).toThrow();
  });
});
