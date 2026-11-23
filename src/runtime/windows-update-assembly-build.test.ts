import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withGeneratedWindowsUpdateAssembly, withWindowsUpdateAssembly } from "../../scripts/windows-update-assembly";

const directories: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "update-assembly-build-")); directories.push(root);
  const path = join(root, "assembly.mjs");
  const original = Buffer.from("// original stub\r\nexport const WINDOWS_UPDATE_JOB_ASSEMBLY = undefined;\r\n");
  await writeFile(path, original);
  return { path, original };
}
afterEach(async () => { for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("Windows update assembly build ownership", () => {
  it.each([false, true])("restores exact prior module bytes after an operation (failure=%s)", async (fail) => {
    const f = await fixture();
    const bytes = Buffer.from([77, 90, 0, 128, 255, 10]);
    const operation = withGeneratedWindowsUpdateAssembly(f.path, bytes, async () => {
      // Evaluate the generated artifact, rather than testing its source spelling.
      const code = await readFile(f.path, "utf8");
      const artifact = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
      expect(Buffer.from(artifact.WINDOWS_UPDATE_JOB_ASSEMBLY, "base64")).toEqual(bytes);
      if (fail) throw new Error("bundle failed");
      return "bundled";
    });
    if (fail) await expect(operation).rejects.toThrow("bundle failed");
    else await expect(operation).resolves.toBe("bundled");
    expect(await readFile(f.path)).toEqual(f.original);
  });

  it("rejects invalid or oversized input before replacing the module or starting a bundle", async () => {
    const f = await fixture(); let invoked = false;
    for (const bytes of [Buffer.from("source code"), Buffer.alloc(2 * 1024 * 1024, 77)]) {
      await expect(withGeneratedWindowsUpdateAssembly(f.path, bytes, async () => { invoked = true; })).rejects.toThrow(/assembly/);
      expect(await readFile(f.path)).toEqual(f.original);
    }
    expect(invoked).toBe(false);
  });

  it("builds other targets without requiring a Windows compiler", async () => {
    expect(await withWindowsUpdateAssembly(false, async () => "non-windows-bundle")).toBe("non-windows-bundle");
  });
});
