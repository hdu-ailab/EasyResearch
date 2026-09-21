import { createHash } from "node:crypto";
import { link, mkdir, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEvidence, checkEvidence } from "./evidence.js";
import { MEMORY_LIMITS } from "./policy.js";
import { fixture } from "./test-fixture.js";

describe("bounded local evidence", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.cleanup(); });

  it("captures exact bytes and rejects stale proofs", async () => {
    const bytes = Buffer.from([0, 1, 2, 255, 13, 10]);
    await writeFile(join(f.cwd, "report.bin"), bytes);
    const proof = await captureEvidence(f.cwd, ["report.bin"]);
    expect(proof).toEqual([{ path: "report.bin", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length }]);
    await expect(checkEvidence(f.cwd, proof)).resolves.toBeUndefined();
    await writeFile(join(f.cwd, "report.bin"), Buffer.from([0, 1, 2, 254, 13, 10]));
    await expect(checkEvidence(f.cwd, proof)).rejects.toThrow(/changed|stale/i);
  });

  it("rejects lexical escapes, absolute paths, missing files and directories without leaking raw errors", async () => {
    for (const path of ["../outside", "/etc/passwd", "C:\\private\\file", "source.md/../source.md", ".", "missing.md"]) {
      await expect(captureEvidence(f.cwd, [path])).rejects.toThrow();
      try { await captureEvidence(f.cwd, [path]); } catch (error) { expect(String(error)).not.toContain(f.root); }
    }
    await mkdir(join(f.cwd, "directory"));
    await expect(captureEvidence(f.cwd, ["directory"])).rejects.toThrow(/regular|evidence/i);
  });

  it("rejects file/directory symlink escapes and multi-linked evidence", async () => {
    await writeFile(join(f.otherCwd, "private.md"), "private");
    await symlink(join(f.otherCwd, "private.md"), join(f.cwd, "escape.md"));
    await symlink(f.otherCwd, join(f.cwd, "escape-dir"), "junction");
    await link(join(f.otherCwd, "private.md"), join(f.cwd, "linked.md"));
    for (const path of ["escape.md", "escape-dir/private.md", "linked.md"]) await expect(captureEvidence(f.cwd, [path])).rejects.toThrow();
  });

  it("bounds file count and bytes before accepting evidence", async () => {
    await writeFile(join(f.cwd, "large.md"), "");
    await truncate(join(f.cwd, "large.md"), MEMORY_LIMITS.evidenceFileBytes + 1);
    await expect(captureEvidence(f.cwd, ["large.md"])).rejects.toThrow(/bound|limit|large/i);
    await expect(captureEvidence(f.cwd, Array.from({ length: MEMORY_LIMITS.evidenceFiles + 1 }, (_, i) => `file-${i}`))).rejects.toThrow(/bound|limit|many/i);
    await expect(captureEvidence(f.cwd, ["source.md", "source.md"])).rejects.toThrow();
    const count = Math.floor(MEMORY_LIMITS.evidenceTotalBytes / MEMORY_LIMITS.evidenceFileBytes) + 1;
    const files = Array.from({ length: count }, (_, i) => `aggregate-${i}.md`);
    for (const path of files) {
      await writeFile(join(f.cwd, path), "");
      await truncate(join(f.cwd, path), MEMORY_LIMITS.evidenceFileBytes);
    }
    await expect(captureEvidence(f.cwd, files)).rejects.toThrow(/bound|limit|large/i);
  });
});
