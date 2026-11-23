import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BackgroundOutputService } from "./background-output";
import type { BackgroundOutputChangedEvent } from "../background/contracts";
import type { WatchImplementation } from "./file-watcher";
import { createManagedShellManager } from "../background/shell";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(bytes: string | Uint8Array = "", watch?: WatchImplementation) {
  const agentDir = await mkdtemp(join(tmpdir(), "background-output-"));
  cleanups.push(() => rm(agentDir, { recursive: true, force: true }));
  const root = "known-root";
  const id = `shell_${randomUUID()}`;
  const directory = join(agentDir, "background", "shell", createHash("sha256").update(root).digest("hex"));
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${id}.out`);
  const recordPath = join(directory, `${id}.json`);
  const record = {
    version: 1, id, rootSessionID: root, sessionID: "native-child", cwd: "/private/workspace",
    command: "training", file, started: 1234, pending: false, background: true, pid: 42,
    owner: { pid: process.pid, instanceID: "owner-token", rootSessionID: root },
    worker: { token: "worker-secret", port: 123, workerPID: 100, resultPath: "/private/result" },
    header: { authorization: "credential-secret" },
    result: undefined as undefined | { status: string; exitCode: number | null; signal?: string; timeout?: boolean },
  };
  await writeFile(recordPath, JSON.stringify(record));
  await writeFile(file, bytes);
  const events: { root: string; event: BackgroundOutputChangedEvent }[] = [];
  const service = new BackgroundOutputService({ agentDir,
    watch,
    isKnownRoot: async (id) => id === root || id === "other-root",
    publish: (root, event) => { events.push({ root, event }); },
  });
  cleanups.push(async () => { service.close(); });
  return { agentDir, root, id, directory, file, recordPath, record, events, service,
    save: async () => { await writeFile(recordPath, JSON.stringify(record)); },
  };
}

describe("bounded durable shell output", () => {
  it("reads exact byte-cursor chunks without splitting or duplicating Unicode", async () => {
    const f = await fixture("A😀中BéC");
    let cursor = 0;
    let text = "";
    for (let reads = 0; reads < 8 && cursor < 12; reads++) {
      const chunk = await f.service.read(f.root, f.id, { cursor, limit: 4 });
      expect(chunk.cursor).toBeGreaterThan(cursor);
      expect(chunk.output).not.toContain("�");
      text += chunk.output;
      cursor = chunk.cursor;
    }
    expect(text).toBe("A😀中BéC");
    expect(cursor).toBe(Buffer.byteLength(text));
    expect(await f.service.read(f.root, f.id, { cursor: 1, limit: 1 })).toMatchObject({ output: "😀", cursor: 5 });
    const tail = await f.service.read(f.root, f.id, { limit: 5 });
    expect(tail).toMatchObject({ output: "BéC", cursor: 12, size: 12, truncated: true, reset: false });
  });

  it("holds an incomplete live character and drains its terminal partial bytes once", async () => {
    const emoji = Buffer.from("😀");
    const f = await fixture(Buffer.concat([Buffer.from("A"), emoji.subarray(0, 2)]));
    expect(await f.service.read(f.root, f.id, { cursor: 0 })).toMatchObject({ output: "A", cursor: 1, size: 3 });
    await appendFile(f.file, emoji.subarray(2));
    expect(await f.service.read(f.root, f.id, { cursor: 1 })).toMatchObject({ output: "😀", cursor: 5 });
    await appendFile(f.file, Buffer.from([0xe2]));
    expect(await f.service.read(f.root, f.id, { cursor: 5 })).toMatchObject({ output: "", cursor: 5, status: "running" });
    f.record.result = { status: "completed", exitCode: 0 };
    await f.save();
    expect(await f.service.read(f.root, f.id, { cursor: 5 })).toMatchObject({ output: "�", cursor: 6, status: "completed" });
    expect(await f.service.read(f.root, f.id, { cursor: 6 })).toMatchObject({ output: "", cursor: 6 });
  });

  it("bounds oversized tails, resets after truncation, and retains terminal metadata without leaking descriptors", async () => {
    const f = await fixture(`private prefix${"😀".repeat(20_000)}`);
    const tail = await f.service.read(f.root, f.id, { limit: 1_000_000 });
    expect(Buffer.byteLength(tail.output)).toBeLessThanOrEqual(65536);
    expect(tail.truncated).toBe(true);
    expect(tail.output).not.toContain("private prefix");
    await writeFile(f.file, "final");
    f.record.result = { status: "cancelled", exitCode: null, signal: "SIGTERM", timeout: true };
    await f.save();
    const reset = await f.service.read(f.root, f.id, { cursor: tail.cursor });
    expect(reset).toEqual({ id: f.id, sessionID: "native-child", command: "training", status: "cancelled", startedAt: 1234,
      pid: 42, exitCode: null, signal: "SIGTERM", timeout: true, output: "final", cursor: 5, size: 5, truncated: false, reset: true });
    expect(JSON.stringify(reset)).not.toMatch(/worker-secret|credential-secret|owner-token|private\/workspace|resultPath/);
  });

  it("distinguishes missing output from an empty live stream and rejects foreign roots/paths", async () => {
    const f = await fixture();
    expect(await f.service.read(f.root, f.id)).toMatchObject({ output: "", cursor: 0, size: 0, status: "running" });
    // The unknown root has readable, otherwise valid data. Authorization, not a
    // coincidental ENOENT, must prevent access. The other known bucket has a
    // mismatched durable owner and must not authorize that foreign record either.
    for (const [bucketRoot, recordRoot] of [["unknown", "unknown"], ["other-root", f.root]]) {
      const bucket = join(f.agentDir, "background", "shell", createHash("sha256").update(bucketRoot!).digest("hex"));
      await mkdir(bucket, { recursive: true });
      const file = join(bucket, `${f.id}.out`);
      await writeFile(file, "foreign bytes");
      await writeFile(join(bucket, `${f.id}.json`), JSON.stringify({ ...f.record, rootSessionID: recordRoot,
        owner: { ...f.record.owner, rootSessionID: recordRoot }, file }));
    }
    await expect(f.service.read("unknown", f.id)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.read("other-root", f.id)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.read(f.root, "../../private")).rejects.toMatchObject({ status: 404 });
    await rm(f.file);
    await expect(f.service.read(f.root, f.id)).rejects.toMatchObject({ status: 404, code: "SHELL_OUTPUT_UNAVAILABLE" });
    f.record.file = join(f.agentDir, "foreign");
    await writeFile(f.record.file, "foreign secret");
    await f.save();
    await expect(f.service.read(f.root, f.id)).rejects.toMatchObject({ status: 404 });
  });

  it("bounds replacement-character expansion and rejects malformed or foreign durable headers", async () => {
    const f = await fixture(Buffer.alloc(70_000, 0xff));
    f.record.result = { status: "completed", exitCode: 0 };
    await f.save();
    const chunk = await f.service.read(f.root, f.id);
    expect(Buffer.byteLength(chunk.output)).toBeLessThanOrEqual(65536);
    expect(chunk.cursor).toBeGreaterThan(0);
    expect(chunk.cursor).toBeLessThan(chunk.size);
    await writeFile(f.recordPath, JSON.stringify({ ...f.record, result: { status: ["completed"], exitCode: 0 } }));
    expect(await f.service.read(f.root, f.id).then(() => "accepted malformed status", (error) => error.status)).toBe(404);
    await writeFile(f.recordPath, JSON.stringify({ ...f.record, owner: { ...f.record.owner, rootSessionID: "foreign" } }));
    await expect(f.service.read(f.root, f.id)).rejects.toMatchObject({ status: 404 });
    await writeFile(f.recordPath, "{");
    await expect(f.service.read(f.root, f.id)).rejects.toMatchObject({ status: 404 });
  });

  it("does not complete an output read after its service closes during root authorization", async () => {
    const f = await fixture("owned");
    let authorize!: (known: boolean) => void;
    const gate = new Promise<boolean>((resolve) => { authorize = resolve; });
    const service = new BackgroundOutputService({ agentDir: f.agentDir, isKnownRoot: () => gate, publish() {} });
    const pending = service.read(f.root, f.id);
    service.close();
    authorize(true);
    await expect(pending).rejects.toMatchObject({ status: 404 });
  });

  it.each(["output", "record", "directory"])("rejects a symlinked %s instead of following it", async (kind) => {
    const f = await fixture("owned");
    const path = kind === "directory" ? f.directory : kind === "record" ? f.recordPath : f.file;
    const target = join(f.agentDir, `linked-${kind}`);
    await rename(path, target);
    await symlink(target, path, kind === "directory" ? "junction" : "file");
    await expect(f.service.read(f.root, f.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("demand-scoped output invalidations", () => {
  it("observes real managed progress and final metadata without view leases owning the command", async () => {
    const f = await fixture();
    const manager = createManagedShellManager({ agentDir: f.agentDir, cwd: f.agentDir, rootSessionID: f.root, worker: false });
    manager.attachOwner({ sessionID: "native-owner", cwd: f.agentDir, notify: async () => {} });
    let advance!: () => void;
    let finish!: () => void;
    const nextPhase = new Promise<void>((resolve) => { advance = resolve; });
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    let transportSignal: AbortSignal | undefined;
    try {
      const running = await manager.executeRemote("native-owner", { command: "real managed progress", background: true }, async ({ signal, onOutput }) => {
        transportSignal = signal;
        onOutput("phase 1\n");
        await nextPhase;
        onOutput("phase 2\n");
        await finished;
        return { exitCode: 7 };
      });
      f.service.acquireLease(f.root, "managed-view");
      await f.service.replaceLease(f.root, "managed-view", 0, [running.shellID!]);
      const first = await f.service.read(f.root, running.shellID!);
      expect(first).toMatchObject({ output: "phase 1\n", status: "running", sessionID: "native-owner", startedAt: manager.tasks()[0]!.startedAt });
      await f.service.replaceLease(f.root, "managed-view", 1, []);
      expect(manager.hasWork()).toBe(true);
      expect(transportSignal?.aborted).toBe(false);
      await f.service.replaceLease(f.root, "managed-view", 2, [running.shellID!]);
      advance();
      await expect.poll(() => f.events.some(({ event }) => event.taskId === running.shellID)).toBe(true);
      expect(await f.service.read(f.root, running.shellID!, { cursor: first.cursor })).toMatchObject({ output: "phase 2\n", status: "running" });
      f.events.length = 0;
      finish();
      await expect.poll(() => f.events.some(({ event }) => event.taskId === running.shellID)).toBe(true);
      expect(await f.service.read(f.root, running.shellID!)).toMatchObject({ output: "phase 1\nphase 2\n", status: "completed", exitCode: 7 });
      await manager.dispose();
      expect(await f.service.read(f.root, running.shellID!)).toMatchObject({ output: "phase 1\nphase 2\n", status: "completed" });
    } finally {
      advance(); finish();
      await manager.dispose();
    }
  });
  it("shares one native watch, coalesces metadata only, fences replaced selections and recovers a failed watcher on demand", async () => {
    const handles: { closed: boolean; emit(name: string): void; fail(): void }[] = [];
    const watch: WatchImplementation = (_path, _options, listener) => {
      let error: (() => void) | undefined;
      const state = { closed: false, emit: (name: string) => listener("change", name), fail: () => error?.() };
      handles.push(state);
      const handle = { on(_event: "error", callback: (error: Error) => void) { error = () => callback(new Error("observer failed")); return handle; }, close() { state.closed = true; } };
      return handle;
    };
    const f = await fixture("private log bytes", watch);
    const second = `shell_${randomUUID()}`;
    await writeFile(join(f.directory, `${second}.json`), JSON.stringify({ ...f.record, id: second, file: join(f.directory, `${second}.out`) }));
    await writeFile(join(f.directory, `${second}.out`), "other output");
    f.service.acquireLease(f.root, "a");
    f.service.acquireLease(f.root, "b");
    await f.service.replaceLease(f.root, "a", 0, [f.id]);
    await f.service.replaceLease(f.root, "b", 0, [f.id]);
    expect(handles).toHaveLength(1);
    vi.useFakeTimers();
    try {
      handles[0]!.emit(`${f.id}.out`);
      handles[0]!.emit(`${f.id}.out`);
      handles[0]!.emit(`${f.id}.json`);
      await vi.advanceTimersByTimeAsync(25);
      expect(f.events).toEqual([{ root: f.root, event: { type: "background_output_changed", taskId: f.id } }]);
      f.events.length = 0;
      f.service.releaseLease(f.root, "a");
      expect(handles[0]!.closed).toBe(false);
      handles[0]!.emit(`${f.id}.out`);
      await f.service.replaceLease(f.root, "b", 2, [second]);
      expect(await f.service.replaceLease(f.root, "b", 1, [f.id])).toEqual({ applied: false, revision: 2 });
      handles[0]!.emit(`${second}.json`);
      await vi.advanceTimersByTimeAsync(25);
      expect(f.events).toEqual([{ root: f.root, event: { type: "background_output_changed", taskId: second } }]);
      handles[0]!.fail();
      expect(handles[0]!.closed).toBe(true);
      expect((await f.service.read(f.root, second)).output).toBe("other output");
      expect(handles).toHaveLength(2);
      await f.service.replaceLease(f.root, "b", 3, []);
      expect(handles[1]!.closed).toBe(true);
      expect(await f.service.replaceLease(f.root, "b", 2, [second])).toEqual({ applied: false, revision: 3 });
      expect(handles).toHaveLength(2);
      const obsolete = f.service.replaceLease(f.root, "b", 4, [second]);
      f.service.releaseLease(f.root, "b");
      await expect(obsolete).rejects.toMatchObject({ status: 404 });
    } finally { vi.useRealTimers(); }
  });
  it("replaces independently revisioned leases, coalesces appends/status, and releases on disconnect", async () => {
    const f = await fixture();
    f.service.acquireLease(f.root, "view-a");
    f.service.acquireLease(f.root, "view-b");
    expect(await f.service.replaceLease(f.root, "view-a", 2, [f.id])).toEqual({ applied: true, revision: 2 });
    expect(await f.service.replaceLease(f.root, "view-b", 0, [f.id])).toEqual({ applied: true, revision: 0 });
    expect(await f.service.replaceLease(f.root, "view-a", 1, [])).toEqual({ applied: false, revision: 2 });
    await expect(f.service.replaceLease("other-root", "view-a", 3, [f.id])).rejects.toMatchObject({ status: 404 });
    await appendFile(f.file, "progress\n");
    await expect.poll(() => f.events.length).toBeGreaterThan(0);
    expect(f.events[0]).toEqual({ root: f.root, event: { type: "background_output_changed", taskId: f.id } });
    f.events.length = 0;
    f.service.releaseLease(f.root, "view-a");
    f.record.result = { status: "completed", exitCode: 7 };
    const temporary = `${f.recordPath}.tmp`;
    await writeFile(temporary, JSON.stringify(f.record));
    await rename(temporary, f.recordPath);
    await expect.poll(() => f.events.length).toBeGreaterThan(0);
    expect(await f.service.read(f.root, f.id, { cursor: 0 })).toMatchObject({ output: "progress\n", status: "completed", exitCode: 7 });
    f.service.releaseLease(f.root, "view-b");
    await expect(f.service.replaceLease(f.root, "view-b", 10, [f.id])).rejects.toMatchObject({ status: 404 });
    f.events.length = 0;
    await appendFile(f.file, "after disconnect");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(f.events).toEqual([]);
    expect(await readFile(f.file, "utf8")).toBe("progress\nafter disconnect");
  });
});
