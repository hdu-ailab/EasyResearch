import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import type { ShellOutputDto } from "../contracts";

export const MAX_SHELL_OUTPUT_BYTES = 65_536;
export class ShellOutputError extends Error {
  constructor(readonly status = 404, readonly code = "SHELL_OUTPUT_UNAVAILABLE") {
    super(status === 400 ? "Invalid shell output request." : status === 503 ? "Shell output monitoring is unavailable." : "Shell output is unavailable.");
  }
}
export const isShellTaskId = (id: unknown): id is string => typeof id === "string" && /^shell_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
type OutputMetadata = Omit<ShellOutputDto, "output" | "cursor" | "size" | "truncated" | "reset">;
export interface OwnedShellOutput { metadata: OutputMetadata; directory: string; file: string; directoryIdentity: string }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;

/** Read-only access to the manager's durable records; never creates an Agent or
 * accepts a caller/record-selected file path. Every descendant is link-checked. */
export class ShellOutputReader {
  private readonly base: string;
  private readonly logicalBase: string;
  constructor(agentDir: string) {
    this.logicalBase = resolve(agentDir);
    this.base = realpathSync(agentDir);
  }
  private directory(root: string) {
    const hash = createHash("sha256").update(root).digest("hex");
    let path = this.base;
    const identities: string[] = [];
    for (const part of ["", "background", "shell", hash]) {
      if (part) path = join(path, part);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ShellOutputError();
      identities.push(identity(stat));
    }
    return { path, identity: identities.join("/"), logical: join(this.logicalBase, "background", "shell", hash) };
  }
  private open(root: string, name: string) {
    const directory = this.directory(root);
    const path = join(directory.path, name);
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw new ShellOutputError();
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || identity(stat) !== identity(before)
        || this.directory(root).identity !== directory.identity) throw new ShellOutputError();
      return { fd, stat, directory };
    } catch (error) { closeSync(fd); throw error; }
  }
  record(root: string, id: string): OwnedShellOutput {
    if (!isShellTaskId(id)) throw new ShellOutputError();
    try {
      const { fd, stat, directory } = this.open(root, `${id}.json`);
      let value: unknown;
      try {
        if (stat.size > 1_048_576) throw new ShellOutputError();
        const bytes = Buffer.alloc(stat.size);
        let count = 0;
        while (count < bytes.length) {
          const read = readSync(fd, bytes, count, bytes.length - count, count);
          if (!read) break;
          count += read;
        }
        value = JSON.parse(bytes.subarray(0, count).toString("utf8"));
      } finally { closeSync(fd); }
      if (!object(value) || value.version !== 1 || value.id !== id || value.rootSessionID !== root
        || !object(value.owner) || value.owner.rootSessionID !== root
        || value.file !== join(directory.logical, `${id}.out`)
        || typeof value.sessionID !== "string" || !value.sessionID || typeof value.command !== "string"
        || typeof value.started !== "number" || !Number.isFinite(value.started)
        || (value.pid !== undefined && (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0))) throw new ShellOutputError();
      const result = value.result;
      if (result !== undefined && (!object(result) || typeof result.status !== "string" || !["completed", "cancelled", "error"].includes(result.status)
        || (result.exitCode !== null && !Number.isSafeInteger(result.exitCode))
        || (result.signal !== undefined && (typeof result.signal !== "string" || result.signal.length > 128))
        || (result.timeout !== undefined && typeof result.timeout !== "boolean"))) throw new ShellOutputError();
      const final = result as undefined | { status: OutputMetadata["status"]; exitCode: number | null; signal?: string; timeout?: boolean };
      return { directory: directory.path, directoryIdentity: directory.identity, file: join(directory.path, `${id}.out`), metadata: {
        id, sessionID: value.sessionID, command: value.command, startedAt: value.started,
        status: final?.status ?? "running", exitCode: final?.exitCode ?? null,
        ...(value.pid === undefined ? {} : { pid: value.pid as number }),
        ...(final?.signal === undefined ? {} : { signal: final.signal }),
        ...(final?.timeout === undefined ? {} : { timeout: final.timeout }),
      } };
    } catch { throw new ShellOutputError(); }
  }
  read(root: string, id: string, options: { cursor?: number; limit?: number } = {}): ShellOutputDto {
    if ((options.cursor !== undefined && (!Number.isSafeInteger(options.cursor) || options.cursor < 0))
      || (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0))) throw new ShellOutputError(400, "SHELL_OUTPUT_INVALID");
    const owned = this.record(root, id);
    const limit = Math.min(options.limit ?? MAX_SHELL_OUTPUT_BYTES, MAX_SHELL_OUTPUT_BYTES);
    try {
      const { fd, directory } = this.open(root, `${id}.out`);
      try {
        if (directory.identity !== owned.directoryIdentity) throw new ShellOutputError();
        // Re-read once if a concurrent truncate shortened the initial snapshot.
        for (let attempt = 0; attempt < 2; attempt++) {
          const size = fstatSync(fd).size;
          const reset = options.cursor !== undefined && options.cursor > size;
          const start = options.cursor === undefined || reset ? Math.max(0, size - limit) : options.cursor;
          const offset = Math.max(0, start - 3);
          const buffer = Buffer.alloc(Math.max(0, Math.min(size, start + limit + 3) - offset));
          let count = 0;
          while (count < buffer.length) {
            const read = readSync(fd, buffer, count, buffer.length - count, offset + count);
            if (!read) break;
            count += read;
          }
          if (fstatSync(fd).size < size) { if (!attempt) continue; throw new ShellOutputError(); }
          const bytes = buffer.subarray(0, count);
          const running = owned.metadata.status === "running";
          const from = start - offset;
          const first = crossingCharacter(bytes, from, running)?.end ?? from;
          const cut = Math.min(bytes.length, from + limit);
          const last = crossingCharacter(bytes, cut, running);
          let end = last?.start === first && last.end !== undefined ? last.end : last?.start ?? cut;
          let output = bytes.toString("utf8", first, Math.max(first, end));
          // Invalid bytes expand to replacement characters. Bound the encoded
          // response too, retaining the exact consumed source-byte cursor.
          while (Buffer.byteLength(output) > MAX_SHELL_OUTPUT_BYTES) {
            end -= Math.ceil((Buffer.byteLength(output) - MAX_SHELL_OUTPUT_BYTES) / 3);
            end = crossingCharacter(bytes, end, running)?.start ?? end;
            output = bytes.toString("utf8", first, Math.max(first, end));
          }
          return { ...owned.metadata, output, cursor: offset + Math.max(first, end), size,
            truncated: (options.cursor === undefined || reset) && start > 0, reset };
        }
        throw new ShellOutputError();
      } finally { closeSync(fd); }
    } catch { throw new ShellOutputError(); }
  }
}

// UTF-8 boundary behavior follows the reviewed reference shell.ts:819-843,1220-1231
// (ee5fe34e, MIT). A valid incomplete live EOF is held until append or settlement.
function crossingCharacter(bytes: Buffer, cut: number, running: boolean): { start: number; end?: number } | undefined {
  for (let start = cut - 1; start >= Math.max(0, cut - 3); start--) {
    const lead = bytes[start]!;
    if ((lead & 0xc0) === 0x80) continue;
    if (lead < 0xc2 || lead > 0xf4) return;
    const end = start + (lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4);
    if (end <= cut) return;
    const character = bytes.subarray(start, end);
    if (end <= bytes.length) return isUtf8(character) ? { start, end } : undefined;
    if (running && new TextDecoder().decode(character, { stream: true }) === "") return { start };
    return;
  }
}
