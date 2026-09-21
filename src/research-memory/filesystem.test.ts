import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryDirectory, publishRevision } from "./filesystem.js";
import { MEMORY_LIMITS } from "./policy.js";
import { createResearchMemoryStore } from "./store.js";
import { entry, fixture } from "./test-fixture.js";

describe("immutable publication and traversal bounds", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.cleanup(); });

  it("does not publish through a replaced namespace directory", async () => {
    const directory = (await memoryDirectory(f.agentDir, ["shared", randomUUID()], true))!;
    await rename(join(f.agentDir, "research-memory", "shared"), join(f.agentDir, "old-shared"));
    await symlink(f.otherCwd, join(f.agentDir, "research-memory", "shared"), "junction");
    await expect(publishRevision(directory, 1, "{}" )).rejects.toThrow();
    expect(await readdir(f.otherCwd)).toEqual([]);
  });

  it("never overwrites an existing revision or deletes another writer's draft", async () => {
    const directory = (await memoryDirectory(f.agentDir, ["shared", randomUUID()], true))!;
    await writeFile(join(directory.path, ".draft-other"), "owned by somebody else");
    await publishRevision(directory, 1, "first snapshot");
    await expect(publishRevision(directory, 1, "second snapshot")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(join(directory.path, "1.json"), "utf8")).toBe("first snapshot");
    expect((await readdir(directory.path)).sort()).toEqual([".draft-other", "1.json"]);
  });

  it("cleans only its own draft when cancellation arrives after draft creation", async () => {
    const controller = new AbortController();
    const actual = (await memoryDirectory(f.agentDir, ["shared", randomUUID()], true, controller.signal))!;
    await writeFile(join(actual.path, ".draft-other"), "unrelated partial writer");
    // Observe a real filesystem boundary, then inject Stop. The production guard
    // still performs every identity check; no filesystem operation is mocked.
    const directory = {
      path: actual.path,
      async assert() {
        await actual.assert();
        if ((await readdir(actual.path)).some(name => name.startsWith(".draft-") && name !== ".draft-other")) controller.abort();
      },
    };
    await expect(publishRevision(directory, 1, "snapshot", controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
    expect(await readdir(actual.path)).toEqual([".draft-other"]);
  });

  it.skipIf(process.platform === "win32")("creates owner-private directories and revision files", async () => {
    const directory = (await memoryDirectory(f.agentDir, ["shared", randomUUID()], true))!;
    await publishRevision(directory, 1, "snapshot");
    expect((await stat(directory.path)).mode & 0o077).toBe(0);
    expect((await stat(join(directory.path, "1.json"))).mode & 0o077).toBe(0);
  });

  it("rejects a redirected memory root before creating children in the foreign directory", async () => {
    await symlink(f.otherCwd, join(f.agentDir, "research-memory"), "junction");
    await expect(createResearchMemoryStore(f.agentDir).execute({ action: "propose", entry: entry() }, f.author)).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(await readdir(f.otherCwd)).toEqual([]);
  });

  it("rejects oversized records and excessive history rather than using an older incumbent", async () => {
    const store = createResearchMemoryStore(f.agentDir);
    const proposed = (await store.execute({ action: "propose", scope: "shared", entry: entry() }, f.assistant)).record!;
    const path = join(f.agentDir, "research-memory", "shared", proposed.id);
    await writeFile(join(path, "2.json"), "");
    await truncate(join(path, "2.json"), MEMORY_LIMITS.recordBytes + 1);
    await expect(store.execute({ action: "get", scope: "shared", id: proposed.id }, f.assistant)).rejects.toThrow(/bound|limit|large/i);
    const recall = await store.execute({ action: "recall" }, f.author);
    expect(recall.diagnostics?.length).toBeGreaterThan(0);
    await writeFile(join(path, `${MEMORY_LIMITS.revisions + 1}.json`), "{}");
    await expect(store.execute({ action: "get", scope: "shared", id: proposed.id, revision: 1 }, f.assistant)).rejects.toThrow(/bound|limit|history/i);
  });

  it("bounds namespace scans and reports truncation", async () => {
    const path = join(f.agentDir, "research-memory", "shared");
    await mkdir(path, { recursive: true });
    await Promise.all(Array.from({ length: MEMORY_LIMITS.records + 1 }, () => mkdir(join(path, randomUUID()))));
    const result = await createResearchMemoryStore(f.agentDir).execute({ action: "recall" }, f.author);
    expect(result.truncated).toBe(true);
    expect(result.diagnostics?.length).toBeGreaterThan(0);
  });
});
