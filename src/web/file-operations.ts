import fs, { type BigIntStats } from "node:fs";
import promises, { type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { FILE_UPLOAD_LIMIT, type FileRenameResultDto, type FileUploadResultDto } from "./contracts";

export class FileOperationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

interface UploadInput { cwd: string; directory: string; name: string }
interface RenameInput { cwd: string; path: string; name: string }
interface UploadBody {
  body: ReadableStream<Uint8Array> | null;
  signal?: AbortSignal;
  contentLength?: string | null;
}
interface ParentIdentity {
  cwd: string;
  directory: string;
  root: string;
  parent: string;
  rootStat: BigIntStats;
  parentStat: BigIntStats;
}
interface Operation {
  scopes: string[];
  exclusive: boolean;
  controller: AbortController;
  done: Promise<unknown>;
  settled: boolean;
  /** Failed cleanup remains owned after the request settles, until a close retry succeeds. */
  cleanup?: () => Promise<void>;
  /** Reserved before open can expose the staging name; identity follows the owned handle. */
  staging?: { path: string; identity?: BigIntStats };
}

function failure(status: number, code: string, message: string): FileOperationError {
  return new FileOperationError(status, code, message);
}

function classify(error: unknown): FileOperationError {
  if (error instanceof FileOperationError) return error;
  switch ((error as NodeJS.ErrnoException | null)?.code) {
    case "ENOENT": case "ENOTDIR": return failure(404, "FILE_NOT_FOUND", "The file or folder no longer exists.");
    case "EACCES": case "EPERM": case "EROFS": return failure(403, "FILE_ACCESS_DENIED", "The file operation was denied.");
    case "EEXIST": return failure(409, "FILE_EXISTS", "A file or folder with this name already exists.");
    case "ENOTSUP": case "EOPNOTSUPP": case "ENOSYS": case "EXDEV":
      return failure(409, "FILE_OPERATION_UNSUPPORTED", "This filesystem does not support exclusive file publication.");
    default: return failure(500, "FILE_IO_ERROR", "The file operation could not be completed.");
  }
}

function contains(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}

function absolute(path: string): void {
  if (typeof path !== "string" || path.includes("\0") || !isAbsolute(path) || resolve(path) !== path) {
    throw failure(400, "FILE_PATH_INVALID", "An exact absolute file or folder path is required.");
  }
}

function validName(name: string): void {
  if (typeof name !== "string" || !name || name.trim() !== name || name === "." || name === ".."
    || /[<>:"/\\|?*\x00-\x1f\x7f]/u.test(name) || /[. ]$/u.test(name)
    || /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:[ .]|$)/iu.test(name)
    || Buffer.byteLength(name, "utf8") > 255 || Buffer.from(name).toString("utf8") !== name) {
    throw failure(400, "FILE_NAME_INVALID", "Enter a valid file name.");
  }
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

function assertRegular(stat: BigIntStats): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw failure(400, "FILE_NOT_REGULAR", "Choose a regular file, not a folder or symbolic link.");
  }
}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw failure(499, "FILE_CANCELLED", "The file operation was cancelled.");
}

/** Remove only the inode that this operation published/created, never a replacement. */
function unlinkOwned(path: string, identity: BigIntStats): void {
  let current: BigIntStats;
  try { current = fs.lstatSync(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!current.isFile() || !sameFile(current, identity)) {
    throw failure(500, "FILE_CLEANUP_FAILED", "File cleanup encountered a replaced path. Refresh the folder before retrying.");
  }
  fs.unlinkSync(path);
}

/** Route-owned transient I/O only; known identities come from the existing session registry/store. */
export class FileOperationService {
  private readonly active = new Set<Operation>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly input: {
    isKnownCwd(cwd: string): Promise<boolean>;
    /** Inject a smaller byte budget for streaming tests; production always uses FILE_UPLOAD_LIMIT. */
    uploadLimit?: number;
  }) {}

  upload(input: UploadInput, request: UploadBody): Promise<FileUploadResultDto> {
    return this.own([input.cwd], false, request.signal, async (signal, scopes, operation) => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let cancellation: Promise<void> | undefined;
      let handle: FileHandle | undefined;
      let parent: ParentIdentity | undefined;
      let staging: string | undefined;
      let identity: BigIntStats | undefined;
      let published: string | undefined;
      let completed = false;
      let streamErrored = false;
      let streamEnded = false;
      let readerCancelled = false;
      const cancelReader = () => {
        if (cancellation) return cancellation;
        if (!reader || readerCancelled || streamErrored || streamEnded) {
          readerCancelled = true;
          return Promise.resolve();
        }
        if (!cancellation) {
          cancellation = reader.cancel().then(() => {}, () => {
            if (streamErrored) return; // An already-errored stream owns no pending read.
            throw failure(500, "FILE_CLEANUP_FAILED", "The upload reader could not be closed.");
          });
          // The promise remains owned and is awaited in finally, including during close().
          void cancellation.catch(() => {});
        }
        return cancellation;
      };
      // EventTarget must not receive the rejecting promise as a listener result;
      // cleanup owns and awaits it, including failed cancellation retries.
      const onAbort = () => { void cancelReader(); };
      const identifyStaging = () => {
        if (handle && !identity) {
          identity = fs.fstatSync(handle.fd, { bigint: true });
          operation.staging!.identity = identity;
        }
      };
      const cleanup = async () => {
        const failures: unknown[] = [];
        if (!completed) {
          try { await cancelReader(); readerCancelled = true; }
          catch (caught) { failures.push(caught); }
          finally { cancellation = undefined; }
        }
        // A failed cancellation retains the reader and its lock for retry.
        if (reader && (completed || readerCancelled)) {
          try { reader.releaseLock(); reader = undefined; }
          catch (caught) { failures.push(caught); }
        }
        // If the initial fstat failed, retain the handle until it can establish
        // cleanup identity. Never guess ownership from a subsequently replaced path.
        try { identifyStaging(); } catch (caught) { failures.push(caught); }
        if (handle && identity) {
          try { await handle.close(); handle = undefined; }
          catch (caught) { failures.push(caught); }
        }
        if (!completed && identity) {
          if (published) {
            try { this.revalidateStorage(parent!); unlinkOwned(published, identity); published = undefined; }
            catch (caught) { failures.push(caught); }
          }
          if (staging) {
            try { this.revalidateStorage(parent!); unlinkOwned(staging, identity); staging = undefined; }
            catch (caught) { failures.push(caught); }
          }
        }
        if (failures.length) throw failure(500, "FILE_CLEANUP_FAILED", "Upload cleanup failed. Refresh the folder before retrying.");
        operation.cleanup = undefined;
      };
      operation.cleanup = cleanup;
      try {
        reader = request.body?.getReader();
        void reader?.closed.catch(() => { streamErrored = true; });
        signal.addEventListener("abort", onAbort, { once: true });
        cancelled(signal);
        validName(input.name);
        const limit = this.input.uploadLimit ?? FILE_UPLOAD_LIMIT;
        const declared = request.contentLength == null ? undefined : Number(request.contentLength);
        if (request.contentLength != null && (!/^\d+$/u.test(request.contentLength) || !Number.isSafeInteger(declared))) {
          throw failure(400, "FILE_SIZE_MISMATCH", "Invalid upload Content-Length.");
        }
        if (declared !== undefined && declared > limit) throw failure(413, "FILE_TOO_LARGE", "The file exceeds the upload limit.");
        parent = await this.parent(input.cwd, input.directory, signal, scopes);
        staging = join(parent.parent, `.easyresearch-upload-${randomUUID()}.part`);
        operation.staging = { path: staging };
        handle = await promises.open(staging, "wx", 0o600);
        identifyStaging();
        this.revalidate(parent);
        let total = 0;
        while (reader) {
          cancelled(signal);
          const chunk = await reader.read();
          cancelled(signal);
          if (chunk.done) { streamEnded = true; break; }
          if (!(chunk.value instanceof Uint8Array)) throw failure(400, "FILE_BODY_INVALID", "Upload body must contain raw bytes.");
          total += chunk.value.byteLength;
          if (total > limit) throw failure(413, "FILE_TOO_LARGE", "The file exceeds the upload limit.");
          if (declared !== undefined && total > declared) throw failure(400, "FILE_SIZE_MISMATCH", "Upload size does not match Content-Length.");
          for (let offset = 0; offset < chunk.value.byteLength;) {
            cancelled(signal);
            const { bytesWritten } = await handle.write(chunk.value, offset, Math.min(64 * 1024, chunk.value.byteLength - offset));
            if (!bytesWritten) throw failure(500, "FILE_IO_ERROR", "The upload could not be written.");
            offset += bytesWritten;
          }
        }
        if (declared !== undefined && declared !== total) throw failure(400, "FILE_SIZE_MISMATCH", "Upload size does not match Content-Length.");
        await handle.close();
        handle = undefined;
        cancelled(signal);
        // No await between the final identity checks, exclusive link and staging unlink.
        this.revalidate(parent);
        const current = fs.lstatSync(staging, { bigint: true });
        if (!current.isFile() || !sameFile(current, identity!) || current.size !== BigInt(total)) throw failure(409, "FILE_CHANGED", "The upload staging file changed.");
        const destination = join(parent.parent, input.name);
        fs.linkSync(staging, destination);
        published = destination;
        unlinkOwned(staging, identity!);
        staging = undefined;
        completed = true;
        return { entry: { kind: "file", name: input.name, path: join(input.directory, input.name) } };
      } catch (caught) {
        // A publication followed by failed staging removal is not a successful upload.
        if (published) throw failure(500, "FILE_CLEANUP_FAILED", "Upload publication could not be cleaned up. Refresh the folder before retrying.");
        cancelled(signal);
        throw classify(caught);
      } finally {
        signal.removeEventListener("abort", onAbort);
        await cleanup();
      }
    });
  }

  rename(input: RenameInput, signal?: AbortSignal): Promise<FileRenameResultDto> {
    return this.own([input.cwd], false, signal, async (ownedSignal, scopes) => {
      cancelled(ownedSignal);
      validName(input.name);
      absolute(input.path);
      const parent = await this.parent(input.cwd, dirname(input.path), ownedSignal, scopes);
      cancelled(ownedSignal);
      this.revalidate(parent);
      const source = join(parent.parent, basename(input.path));
      const identity = fs.lstatSync(source, { bigint: true });
      assertRegular(identity);
      this.assertUnownedSource(source, identity);
      const result: FileRenameResultDto = { oldPath: input.path,
        entry: { kind: "file", name: input.name, path: join(dirname(input.path), input.name) } };
      if (basename(input.path) === input.name) return result;
      const destination = join(parent.parent, input.name);
      // link() is exclusive on Linux/macOS/Windows. Never fall back to overwriting rename().
      fs.linkSync(source, destination);
      try {
        const linked = fs.lstatSync(destination, { bigint: true });
        const current = fs.lstatSync(source, { bigint: true });
        if (!linked.isFile() || !current.isFile() || !sameFile(identity, linked) || !sameFile(identity, current)) {
          throw failure(409, "FILE_CHANGED", "The source file changed during rename.");
        }
        fs.unlinkSync(source);
      } catch (error) {
        try { unlinkOwned(destination, identity); }
        catch { throw failure(500, "FILE_CLEANUP_FAILED", "Rename rollback failed. Refresh the folder before retrying."); }
        throw error;
      }
      return result;
    });
  }

  /** Small scope guard around existing workspace routes; force never cancels another transfer. */
  withWorkspaceMutation<T>(cwds: string[], run: () => Promise<T>): Promise<T> {
    return this.own(cwds, true, undefined, (signal) => { cancelled(signal); return run(); });
  }

  close(): Promise<void> {
    this.closed = true;
    if (this.closing) return this.closing;
    const operations = [...this.active];
    for (const operation of operations) operation.controller.abort();
    const attempt = Promise.allSettled(operations.map((operation) => {
      if (!operation.settled) return operation.done;
      return Promise.resolve().then(() => operation.cleanup?.()).then(() => { this.active.delete(operation); });
    })).then((results) => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected"
        && result.reason instanceof FileOperationError && result.reason.code === "FILE_CLEANUP_FAILED");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "File operation cleanup failed");
    }).finally(() => {
      if (this.closing === attempt) this.closing = undefined;
    });
    this.closing = attempt;
    return attempt;
  }

  private own<T>(cwds: string[], exclusive: boolean, caller: AbortSignal | undefined, run: (signal: AbortSignal, scopes: readonly string[], operation: Operation) => Promise<T>): Promise<T> {
    try {
      if (this.closed) throw failure(503, "FILE_SERVICE_CLOSED", "File operations are shutting down.");
      const scopes: string[] = [];
      for (const cwd of cwds) {
        absolute(cwd);
        scopes.push(cwd);
        try { scopes.push(fs.realpathSync(cwd)); }
        catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      }
      if ([...this.active].some((operation) => (exclusive || operation.exclusive)
        && operation.scopes.some((a) => scopes.some((b) => contains(a, b) || contains(b, a))))) {
        throw failure(409, "FILE_OPERATION_CONFLICT", "A file transfer or workspace operation is still in progress.");
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      caller?.addEventListener("abort", abort, { once: true });
      if (caller?.aborted) abort();
      const operation: Operation = { scopes, exclusive, controller, done: Promise.resolve(), settled: false };
      this.active.add(operation);
      const done = Promise.resolve().then(() => run(controller.signal, scopes, operation)).catch((error) => {
        throw exclusive ? error : classify(error);
      }).finally(() => {
        caller?.removeEventListener("abort", abort);
        operation.settled = true;
        if (!operation.cleanup) this.active.delete(operation);
      });
      operation.done = done;
      return done;
    } catch (error) { return Promise.reject(classify(error)); }
  }

  private assertUnownedSource(path: string, identity: BigIntStats): void {
    for (const operation of this.active) {
      const staging = operation.staging;
      if (!staging) continue;
      const conflict = () => failure(409, "FILE_OPERATION_CONFLICT", "This file belongs to an upload that has not finished.");
      if (relative(path, staging.path) === "") throw conflict();
      // open() may have created the file before returning its handle to this
      // continuation. Probe the already reserved name for alias comparison only;
      // cleanup still requires identity from our owned file descriptor.
      let reserved = staging.identity;
      if (!reserved) {
        try { reserved = fs.lstatSync(staging.path, { bigint: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw conflict(); }
      }
      if (sameFile(identity, reserved)) throw conflict();
    }
  }

  private async parent(cwd: string, directory: string, signal: AbortSignal, scopes: readonly string[]): Promise<ParentIdentity> {
    absolute(cwd);
    absolute(directory);
    if (!contains(cwd, directory)) throw failure(403, "FILE_PATH_INVALID", "The folder must be inside this workspace.");
    if (!await this.input.isKnownCwd(cwd)) throw failure(404, "WORKSPACE_UNKNOWN", "Unknown workspace.");
    cancelled(signal);
    const root = fs.realpathSync(cwd);
    if (!scopes.includes(root)) throw failure(409, "FILE_CHANGED", "The workspace folder changed during the file operation.");
    const parent = fs.realpathSync(directory);
    if (!contains(root, parent)) throw failure(403, "FILE_PATH_INVALID", "The folder resolves outside this workspace.");
    const rootStat = fs.statSync(root, { bigint: true });
    const parentStat = fs.statSync(parent, { bigint: true });
    if (!rootStat.isDirectory() || !parentStat.isDirectory()) throw failure(400, "FILE_PATH_INVALID", "Choose an existing folder.");
    return { cwd, directory, root, parent, rootStat, parentStat };
  }

  private revalidate(parent: ParentIdentity): void {
    if (fs.realpathSync(parent.cwd) !== parent.root || fs.realpathSync(parent.directory) !== parent.parent
      || !sameFile(fs.statSync(parent.root, { bigint: true }), parent.rootStat) || !sameFile(fs.statSync(parent.parent, { bigint: true }), parent.parentStat)) {
      throw failure(409, "FILE_CHANGED", "The workspace folder changed during the file operation.");
    }
  }

  private revalidateStorage(parent: ParentIdentity): void {
    const current = fs.lstatSync(parent.parent, { bigint: true });
    if (!current.isDirectory() || fs.realpathSync(parent.parent) !== parent.parent || !sameFile(current, parent.parentStat)) {
      throw failure(500, "FILE_CLEANUP_FAILED", "The staging folder moved during the file operation.");
    }
  }
}
