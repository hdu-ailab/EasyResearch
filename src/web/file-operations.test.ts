import fs from "node:fs";
import promises from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileOperationService } from "./file-operations";

describe("owned workspace file operations", () => {
  let root: string;
  let cwd: string;
  let service: FileOperationService;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "file-operations-")));
    cwd = join(root, "workspace");
    fs.mkdirSync(cwd);
    service = new FileOperationService({ isKnownCwd: async (path) => path === cwd, uploadLimit: 32 });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    try { await service.close(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  const body = (...chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  } });
  const bytes = (value: string) => new TextEncoder().encode(value);
  const upload = (name: string, stream = body(bytes("original")), signal?: AbortSignal, contentLength?: string) =>
    service.upload({ cwd, directory: cwd, name }, { body: stream, signal, contentLength });

  it("publishes exact empty, binary and Unicode bytes with the requested filename", async () => {
    for (const [name, data] of [["empty.txt", new Uint8Array()], ["研究 🐬.bin", Uint8Array.of(0, 255, 128, 13, 10)]] as const) {
      const result = await upload(name, body(data.subarray(0, 2), data.subarray(2)));
      expect(result).toEqual({ entry: { kind: "file", name, path: join(cwd, name) } });
      expect(fs.readFileSync(result.entry.path)).toEqual(Buffer.from(data));
    }
    expect(fs.readdirSync(cwd).sort()).toEqual(["empty.txt", "研究 🐬.bin"].sort());
  });

  it("streams to staging with backpressure and exposes no final file before completion", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const pending = upload("result.bin", new ReadableStream({ start(controller) { source = controller; } }));
    source.enqueue(bytes("first"));
    await vi.waitFor(() => {
      const names = fs.readdirSync(cwd);
      expect(names).toHaveLength(1);
      expect(fs.readFileSync(join(cwd, names[0]!)).toString()).toBe("first");
    });
    expect(fs.existsSync(join(cwd, "result.bin"))).toBe(false);
    source.enqueue(bytes("last"));
    source.close();
    await pending;
    expect(fs.readFileSync(join(cwd, "result.bin"), "utf8")).toBe("firstlast");
    expect(fs.readdirSync(cwd)).toEqual(["result.bin"]);
  });

  it("never overwrites existing or concurrently published files", async () => {
    await upload("same.bin");
    await expect(upload("same.bin", body(bytes("replacement")))).rejects.toMatchObject({ status: 409, code: "FILE_EXISTS" });
    expect(fs.readFileSync(join(cwd, "same.bin"), "utf8")).toBe("original");
    const results = await Promise.allSettled([upload("race.bin", body(bytes("one"))), upload("race.bin", body(bytes("two")))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "FILE_EXISTS" } });
    expect(["one", "two"]).toContain(fs.readFileSync(join(cwd, "race.bin"), "utf8"));
    expect(fs.readdirSync(cwd).sort()).toEqual(["race.bin", "same.bin"]);
  });

  it("rejects a destination appearing at the publication boundary", async () => {
    const link = fs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementation((source, target) => {
      fs.writeFileSync(target, "concurrent", { flag: "wx" });
      link(source, target);
    });
    await expect(upload("race.bin")).rejects.toMatchObject({ code: "FILE_EXISTS" });
    expect(fs.readFileSync(join(cwd, "race.bin"), "utf8")).toBe("concurrent");
    expect(fs.readdirSync(cwd)).toEqual(["race.bin"]);
  });

  it.each(["", ".", "..", "../escape", "a/b", "a\\b", "bad\0name", "bad\nname", "bad:name", "a?", "CON", "CON .txt", "CONIN$", "nul.txt", "LPT1.csv", "end.", "end ", " leading"])("rejects non-portable basename %j", async (name) => {
    await expect(upload(name)).rejects.toMatchObject({ status: 400, code: "FILE_NAME_INVALID" });
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("requires an exact known cwd and lexical/physical parent containment", async () => {
    await expect(service.upload({ cwd: root, directory: root, name: "file" }, { body: body() })).rejects.toMatchObject({ code: "WORKSPACE_UNKNOWN" });
    await expect(service.upload({ cwd, directory: root, name: "file" }, { body: body() })).rejects.toMatchObject({ code: "FILE_PATH_INVALID" });
    const outside = join(root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, join(cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(service.upload({ cwd, directory: join(cwd, "escape"), name: "file" }, { body: body() })).rejects.toMatchObject({ code: "FILE_PATH_INVALID" });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("retains a known symlink workspace's spelling for upload and rename", async () => {
    const physical = cwd;
    const alias = join(root, "alias");
    fs.symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
    cwd = alias;
    const created = await upload("before.bin");
    const renamed = await service.rename({ cwd, path: created.entry.path, name: "after.bin" });
    expect(renamed).toEqual({ oldPath: join(alias, "before.bin"), entry: { kind: "file", name: "after.bin", path: join(alias, "after.bin") } });
    expect(fs.readFileSync(join(physical, "after.bin"), "utf8")).toBe("original");
  });

  it("rejects directories and symlink leaves without changing their targets", async () => {
    const path = join(cwd, "folder");
    fs.mkdirSync(path);
    await expect(service.rename({ cwd, path, name: "new" })).rejects.toMatchObject({ code: "FILE_NOT_REGULAR" });
    fs.writeFileSync(join(cwd, "original"), "unchanged");
    fs.symlinkSync(join(cwd, "original"), join(cwd, "alias"));
    await expect(service.rename({ cwd, path: join(cwd, "alias"), name: "new" })).rejects.toMatchObject({ code: "FILE_NOT_REGULAR" });
    await expect(upload("alias")).rejects.toMatchObject({ code: "FILE_EXISTS" });
    expect(fs.readFileSync(join(cwd, "original"), "utf8")).toBe("unchanged");
  });

  it("cleans oversize, incorrect declared size and interrupted streams", async () => {
    for (const contentLength of ["33", "-1", "1.5", "invalid"]) {
      await expect(upload("bad", body(), undefined, contentLength)).rejects.toMatchObject({ status: contentLength === "33" ? 413 : 400 });
    }
    const cancel = vi.fn();
    await expect(upload("large", new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(33)); }, cancel }))).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledOnce();
    await expect(upload("short", body(bytes("x")), undefined, "2")).rejects.toMatchObject({ code: "FILE_SIZE_MISMATCH" });
    await expect(upload("interrupted", new ReadableStream({ pull(controller) { controller.error(new Error("disconnected")); } }))).rejects.toMatchObject({ code: "FILE_IO_ERROR" });
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("cancels readers, drains their cleanup promises, and blocks new work on close", async () => {
    let release!: () => void;
    const cancelled = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const result = upload("partial", new ReadableStream({ start(source) { source.enqueue(bytes("part")); }, cancel: cancelled }), controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ code: "FILE_CANCELLED" });
    await vi.waitFor(() => expect(fs.readdirSync(cwd)).toHaveLength(1));
    controller.abort();
    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    await expect(upload("late")).rejects.toMatchObject({ code: "FILE_SERVICE_CLOSED" });
    release();
    await rejected;
    await closing;
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("reserves workspace scope before known-cwd lookup and keeps it until cleanup", async () => {
    let resolveKnown!: (known: boolean) => void;
    service = new FileOperationService({ isKnownCwd: () => new Promise((resolve) => { resolveKnown = resolve; }) });
    const pending = upload("file");
    const move = vi.fn();
    await expect(service.withWorkspaceMutation([root], move)).rejects.toMatchObject({ code: "FILE_OPERATION_CONFLICT", status: 409 });
    expect(move).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(resolveKnown).toBeTypeOf("function"));
    resolveKnown(true);
    await pending;
    let finish!: () => void;
    const moving = service.withWorkspaceMutation([cwd], () => new Promise<void>((resolve) => { finish = resolve; }));
    await expect(upload("another")).rejects.toMatchObject({ code: "FILE_OPERATION_CONFLICT" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    finish();
    await moving;
  });

  it("preserves both originals on rename conflict and fails explicitly without hard-link support", async () => {
    await upload("from");
    await upload("to", body(bytes("target")));
    await expect(service.rename({ cwd, path: join(cwd, "from"), name: "to" })).rejects.toMatchObject({ code: "FILE_EXISTS" });
    vi.spyOn(fs, "linkSync").mockImplementation(() => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); });
    await expect(service.rename({ cwd, path: join(cwd, "from"), name: "new" })).rejects.toMatchObject({ code: "FILE_OPERATION_UNSUPPORTED" });
    expect(fs.readFileSync(join(cwd, "from"), "utf8")).toBe("original");
    expect(fs.readFileSync(join(cwd, "to"), "utf8")).toBe("target");
    expect(fs.readdirSync(cwd).sort()).toEqual(["from", "to"]);
  });

  it("allows exactly one winner when rename and upload publish the same target", async () => {
    await upload("from");
    const results = await Promise.allSettled([
      service.rename({ cwd, path: join(cwd, "from"), name: "to" }),
      upload("to", body(bytes("uploaded"))),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "FILE_EXISTS" } });
    if (results[0]!.status === "fulfilled") {
      expect(fs.readFileSync(join(cwd, "to"), "utf8")).toBe("original");
      expect(fs.readdirSync(cwd)).toEqual(["to"]);
    } else {
      expect(fs.readFileSync(join(cwd, "to"), "utf8")).toBe("uploaded");
      expect(fs.readFileSync(join(cwd, "from"), "utf8")).toBe("original");
      expect(fs.readdirSync(cwd).sort()).toEqual(["from", "to"]);
    }
  });

  it("rolls back only its own destination after source-unlink failure", async () => {
    await upload("from");
    const unlink = fs.unlinkSync;
    const source = join(cwd, "from");
    vi.spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (path === source) throw Object.assign(new Error("denied"), { code: "EACCES" });
      unlink(path);
    });
    await expect(service.rename({ cwd, path: source, name: "new" })).rejects.toMatchObject({ code: "FILE_ACCESS_DENIED" });
    expect(fs.readdirSync(cwd)).toEqual(["from"]);
    vi.mocked(fs.unlinkSync).mockImplementation((path) => {
      if (path === source) {
        unlink(join(cwd, "new"));
        fs.writeFileSync(join(cwd, "new"), "foreign");
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      unlink(path);
    });
    await expect(service.rename({ cwd, path: source, name: "new" })).rejects.toMatchObject({ code: "FILE_CLEANUP_FAILED" });
    expect(fs.readFileSync(source, "utf8")).toBe("original");
    expect(fs.readFileSync(join(cwd, "new"), "utf8")).toBe("foreign");
  });

  it("does not report success when staging cleanup fails", async () => {
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (String(path).endsWith(".part")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      unlink(path);
    });
    await expect(upload("result")).rejects.toMatchObject({ code: "FILE_CLEANUP_FAILED" });
    expect(fs.existsSync(join(cwd, "result"))).toBe(false);
    expect(fs.readdirSync(cwd)).toHaveLength(1);
  });

  it("cancels an already-aborted or immediately closed upload before reading or creating files", async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(upload("early", new ReadableStream({ cancel }), controller.signal)).rejects.toMatchObject({ code: "FILE_CANCELLED" });
    expect(cancel).toHaveBeenCalledOnce();
    const secondCancel = vi.fn();
    const pending = upload("closing", new ReadableStream({ cancel: secondCancel }));
    const rejected = expect(pending).rejects.toMatchObject({ code: "FILE_CANCELLED" });
    await service.close();
    await rejected;
    expect(secondCancel).toHaveBeenCalledOnce();
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("rejects parent symlink retargeting during streaming and cleans the original staging inode", async () => {
    const real = join(cwd, "real");
    const outside = join(root, "outside");
    const alias = join(cwd, "alias");
    fs.mkdirSync(real);
    fs.mkdirSync(outside);
    fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    const pending = service.upload({ cwd, directory: alias, name: "final" }, {
      body: new ReadableStream({ start(controller) { writer = controller; controller.enqueue(bytes("part")); } }),
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: "FILE_CHANGED" });
    await vi.waitFor(() => expect(fs.readdirSync(real)).toHaveLength(1));
    fs.unlinkSync(alias);
    fs.symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
    writer.close();
    await rejected;
    expect(fs.readdirSync(real)).toEqual([]);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("detects replaced parent directories without deleting a foreign staging path", async () => {
    const directory = join(cwd, "dir");
    fs.mkdirSync(directory);
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    const pending = service.upload({ cwd, directory, name: "final" }, {
      body: new ReadableStream({ start(controller) { writer = controller; controller.enqueue(bytes("part")); } }),
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: "FILE_CLEANUP_FAILED" });
    await vi.waitFor(() => expect(fs.readdirSync(directory)).toHaveLength(1));
    const staging = fs.readdirSync(directory)[0]!;
    fs.renameSync(directory, directory + "-old");
    fs.mkdirSync(directory);
    fs.writeFileSync(join(directory, staging), "foreign");
    writer.close();
    await rejected;
    expect(fs.readFileSync(join(directory, staging), "utf8")).toBe("foreign");
    expect(fs.existsSync(join(directory, "final"))).toBe(false);
    // Recover the physical parent so retained owned cleanup can finish at teardown.
    fs.renameSync(directory, directory + "-foreign");
    fs.renameSync(directory + "-old", directory);
  });

  it("keeps unrelated workspaces independent and conflicts through physical aliases", async () => {
    const alias = join(root, "alias");
    fs.symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
    const pending = upload("held", new ReadableStream());
    const rejected = expect(pending).rejects.toMatchObject({ code: "FILE_CANCELLED" });
    await expect(service.withWorkspaceMutation([alias], async () => {})).rejects.toMatchObject({ code: "FILE_OPERATION_CONFLICT" });
    await expect(service.withWorkspaceMutation([join(root, "unrelated")], async () => "ok")).resolves.toBe("ok");
    await service.close();
    await rejected;
  });

  it("retains failed staging cleanup across close attempts without repeating successful steps", async () => {
    const cancel = vi.fn();
    const pending = upload("final", new ReadableStream({ start(source) { source.enqueue(bytes("partial")); }, cancel }));
    const rejected = expect(pending).rejects.toMatchObject({ code: "FILE_CLEANUP_FAILED" });
    await vi.waitFor(() => expect(fs.readdirSync(cwd)).toHaveLength(1));
    const staging = join(cwd, fs.readdirSync(cwd)[0]!);
    const unlink = fs.unlinkSync;
    let blocked = true;
    const remove = vi.spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (path === staging && blocked) throw Object.assign(new Error("transient"), { code: "EACCES" });
      unlink(path);
    });
    await expect(service.close()).rejects.toThrow("cleanup failed");
    await rejected;
    expect(fs.existsSync(staging)).toBe(true);
    expect(fs.existsSync(join(cwd, "final"))).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    await expect(upload("late")).rejects.toMatchObject({ code: "FILE_SERVICE_CLOSED" });
    blocked = false;
    await service.close();
    expect(fs.readdirSync(cwd)).toEqual([]);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
    await service.close();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("retries failed reader cancellation and handle close while leaving successful cleanup one-shot", async () => {
    const cancelSource = vi.fn().mockRejectedValueOnce(new Error("cancel failed"));
    const stream = new ReadableStream<Uint8Array>({ start(source) { source.enqueue(bytes("part")); }, cancel: cancelSource });
    const reader = stream.getReader();
    const cancel = vi.spyOn(reader, "cancel");
    vi.spyOn(stream, "getReader").mockReturnValue(reader);
    const open = promises.open;
    let closeCalls = 0;
    vi.spyOn(promises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        if (++closeCalls === 1) throw new Error("close failed");
        await close();
      });
      return handle;
    });
    const pending = upload("final", stream);
    const rejected = expect(pending).rejects.toMatchObject({ code: "FILE_CLEANUP_FAILED" });
    await vi.waitFor(() => expect(fs.readdirSync(cwd)).toHaveLength(1));
    await expect(service.close()).rejects.toThrow("cleanup failed");
    await rejected;
    expect(closeCalls).toBe(1);
    expect(cancel).toHaveBeenCalledOnce();
    const removals = vi.spyOn(fs, "unlinkSync");
    await service.close();
    expect(closeCalls).toBe(2);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancelSource).toHaveBeenCalledOnce(); // Closed streams do not repeat their underlying callback.
    expect(removals).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("retries cleanup after an earlier request failure and preserves foreign replacement files", async () => {
    const unlink = fs.unlinkSync;
    let staging = "";
    const remove = vi.spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (String(path).endsWith(".part")) {
        staging = String(path);
        throw Object.assign(new Error("transient"), { code: "EACCES" });
      }
      unlink(path);
    });
    await expect(upload("final", body(new Uint8Array(33)))).rejects.toMatchObject({ code: "FILE_CLEANUP_FAILED" });
    remove.mockRestore();
    fs.renameSync(staging, staging + ".owned");
    fs.writeFileSync(staging, "foreign");
    await expect(service.close()).rejects.toThrow("cleanup failed");
    expect(fs.readFileSync(staging, "utf8")).toBe("foreign");
    fs.renameSync(staging, staging + ".foreign");
    fs.renameSync(staging + ".owned", staging);
    await service.close();
    expect(fs.readFileSync(staging + ".foreign", "utf8")).toBe("foreign");
    expect(fs.existsSync(staging)).toBe(false);
  });

  it.each(["direct", "physical-alias", "hardlink"])("rejects renaming an active staging source through %s until settlement", async (kind) => {
    const directory = join(cwd, "files");
    fs.mkdirSync(directory);
    const controller = new AbortController();
    const pending = service.upload({ cwd, directory, name: "final" }, {
      body: new ReadableStream({ start(source) { source.enqueue(bytes("partial")); } }), signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: "FILE_CANCELLED" });
    await vi.waitFor(() => expect(fs.readdirSync(directory)).toHaveLength(1));
    const staging = join(directory, fs.readdirSync(directory)[0]!);
    await vi.waitFor(() => expect(fs.readFileSync(staging, "utf8")).toBe("partial"));
    let source = staging;
    if (kind === "physical-alias") {
      fs.symlinkSync(directory, join(cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
      source = join(cwd, "alias", fs.readdirSync(directory)[0]!);
    } else if (kind === "hardlink") {
      source = join(directory, "hardlink");
      fs.linkSync(staging, source);
    }
    await expect(service.rename({ cwd, path: source, name: "final" })).rejects.toMatchObject({ status: 409, code: "FILE_OPERATION_CONFLICT" });
    expect(fs.existsSync(join(directory, "final"))).toBe(false);
    controller.abort();
    await rejected;
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.existsSync(join(directory, "final"))).toBe(false);
    if (kind === "hardlink") {
      // This alias was created by the fixture, not by the upload. After the
      // writer settles, an ordinary rename is allowed again.
      await expect(service.rename({ cwd, path: source, name: "settled" })).resolves.toMatchObject({ entry: { name: "settled" } });
      expect(fs.readFileSync(join(directory, "settled"), "utf8")).toBe("partial");
    } else expect(fs.readdirSync(directory)).toEqual([]);
  });

  it.each([false, true])("reserves staging before asynchronous open exposes a file (hardlink=%s)", async (hardlink) => {
    const open = promises.open;
    let expose!: () => void;
    let staging = "";
    const opened = new Promise<void>((resolve) => { expose = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(promises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      staging = String(args[0]);
      expose();
      await gate;
      return handle;
    });
    const controller = new AbortController();
    const pending = upload("final", new ReadableStream(), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "FILE_CANCELLED" });
    await opened;
    const source = hardlink ? join(cwd, "alias") : staging;
    if (hardlink) fs.linkSync(staging, source);
    try {
      await expect(service.rename({ cwd, path: source, name: "final" })).rejects.toMatchObject({ status: 409, code: "FILE_OPERATION_CONFLICT" });
      expect(fs.existsSync(join(cwd, "final"))).toBe(false);
    } finally {
      controller.abort();
      release();
      await rejected;
    }
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.existsSync(join(cwd, "final"))).toBe(false);
  });
});
