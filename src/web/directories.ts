import fs, { accessSync, closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";
import type { DirectoryEntryDto, FileContentDto, FileEntryDto } from "./contracts";
import { mimeTypeFor, RawFileRangeError, type ByteRange, type RawFileDescriptor } from "./raw-file";

/** Maximum bytes read for a single file preview. */
export const FILE_PREVIEW_LIMIT = 1024 * 1024;

export interface DirectoryListing {
  path: string;
  entries: DirectoryEntryDto[];
}

export interface DirectoryServiceOptions {
  platform?: NodeJS.Platform;
  resolveRoot?: (candidate: string) => string | null;
}

/** Typed service error mapping to a 4xx HTTP status in routes. */
export class DirectoryServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Expected file failures share one classification before and during body open. */
export function fileServiceError(error: unknown, path: string): DirectoryServiceError | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  switch (error.code) {
    case "ENOENT":
    case "ENOTDIR":
      return new DirectoryServiceError(404, `does not exist: ${path}`);
    case "EISDIR":
      return new DirectoryServiceError(400, `not a file: ${path}`);
    case "EACCES":
    case "EPERM":
      return new DirectoryServiceError(403, `File is not readable: ${path}`);
    default:
      return undefined;
  }
}

/**
 * Server-backed local directory navigation. Only directories are returned,
 * sorted by name. The selected path is canonicalized to its absolute real
 * path; a project root is never inferred from an ancestor.
 */
export class DirectoryService {
  constructor(
    public readonly homeDir: string = homedir(),
    private readonly options: DirectoryServiceOptions = {},
  ) {}

  listRoots(): DirectoryEntryDto[] {
    const platform = this.options.platform ?? process.platform;
    const candidates = platform === "win32" ? this.windowsRootCandidates() : ["/"];
    const roots: DirectoryEntryDto[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const path = this.options.resolveRoot ? this.options.resolveRoot(candidate) : this.tryReadableDirectory(candidate);
      if (!path) continue;
      const key = platform === "win32" ? path.toLowerCase() : path;
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push({ name: path, path });
    }
    return roots;
  }

  list(path?: string): DirectoryListing {
    const target = path ?? this.homeDir;
    const real = this.resolveReadableDirectory(target);
    let dirents;
    try {
      dirents = readdirSync(real, { withFileTypes: true });
    } catch {
      throw new DirectoryServiceError(403, `Directory is not readable: ${target}`);
    }
    const entries: DirectoryEntryDto[] = dirents
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, path: join(real, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { path: real, entries };
  }

  createDirectory(path: string): string {
    const parent = path.replace(/[\\/]+$/, "");
    if (!parent || parent.includes("\0")) throw new DirectoryServiceError(400, "invalid directory path");
    try {
      mkdirSync(parent, { recursive: true });
      return realpathSync(parent);
    } catch {
      throw new DirectoryServiceError(400, `cannot create directory: ${path}`);
    }
  }

  /**
   * Lists both files and directories of a directory, directories first, each
   * sorted by name. Powers the files panel tree.
   */
  listEntries(path?: string): { path: string; entries: FileEntryDto[] } {
    const requested = resolve(path ?? this.homeDir);
    const listing = this.list(requested);
    const dirents = readdirSync(listing.path, { withFileTypes: true });
    const entries: FileEntryDto[] = dirents
      .map((d) => ({
        kind: d.isDirectory() ? ("directory" as const) : ("file" as const),
        name: d.name,
        path: join(requested, d.name),
      }))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return { path: requested, entries };
  }

  /**
   * Reads a file's UTF-8 text for preview. Non-files and unreadable paths are
   * rejected; reads larger than {@link FILE_PREVIEW_LIMIT} truncate with a
   * `truncated` flag instead of failing. Binary or non-UTF-8 content is marked
   * `binary` with an empty `content` string while preserving `byteCount`.
   */
  readFile(path: string): FileContentDto {
    let fd: number | undefined;
    try {
      const file = this.resolveReadableFile(path);
      fd = openSync(file.path, "r");
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new DirectoryServiceError(400, `not a file: ${path}`);
      const byteCount = stat.size;
      const buffer = Buffer.allocUnsafe(Math.min(byteCount, FILE_PREVIEW_LIMIT));
      let read = 0;
      while (read < buffer.byteLength) {
        const count = readSync(fd, buffer, read, buffer.byteLength - read, read);
        if (count === 0) break;
        read += count;
      }
      const sample = buffer.subarray(0, read);
      const truncated = byteCount > read && read === FILE_PREVIEW_LIMIT;
      let binary = sample.includes(0);
      let content = "";
      if (!binary) {
        try {
          // Streaming decode retains an incomplete final code point only when capped.
          content = new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: truncated });
        } catch {
          binary = true;
        }
      }
      return { path: file.path, content, byteCount, truncated, binary };
    } catch (error) {
      throw fileServiceError(error, path) ?? error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /**
   * Describes a readable file for raw responses: its canonical path, exact
   * size, and conservative MIME type.
   */
  describeFile(path: string): RawFileDescriptor {
    const file = this.resolveReadableFile(path);
    return { path: file.path, size: file.size, mimeType: mimeTypeFor(file.path) };
  }

  /**
   * Reads an inclusive byte range of a file. The range must be valid for the
   * file's actual size; unsatisfiable ranges throw {@link RawFileRangeError}.
   * Only the requested bytes are read (bounded `openSync`/`readSync`/`closeSync`);
   * the rest of the file is never materialized in memory.
   */
  readFileBytes(path: string, range: ByteRange): Uint8Array<ArrayBuffer> {
    let fd: number | undefined;
    try {
      const file = this.resolveReadableFile(path);
      this.assertRange(range, file.size);
      const length = range.end - range.start + 1;
      const buffer = new Uint8Array(length);
      fd = openSync(file.path, "r");
      let read = 0;
      while (read < length) {
        const count = readSync(fd, buffer, read, length - read, range.start + read);
        if (count === 0) break;
        read += count;
      }
      return read === length ? buffer : buffer.slice(0, read);
    } catch (error) {
      throw fileServiceError(error, path) ?? error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /**
   * A file-backed body keeps raw reads lazy and exposes a known length to Bun's
   * HTTP server. A generic ReadableStream loses Content-Length on full responses.
   */
  async readFileBody(path: string, range: ByteRange | null): Promise<Blob> {
    try {
      const file = this.resolveReadableFile(path);
      // The pinned Node declarations omit this API supported by both test Node and Bun.
      const body = await (fs as typeof fs & { openAsBlob(path: string): Promise<Blob> }).openAsBlob(file.path);
      if (range === null) return body;
      // Bun's lazy Blob.size reports a disappeared path as zero; its native open must report that error.
      this.assertRange(range, file.size);
      return body.slice(range.start, range.end + 1);
    } catch (error) {
      throw fileServiceError(error, path) ?? error;
    }
  }

  /** Validates an inclusive range against a file's exact size. */
  private assertRange(range: ByteRange, size: number): void {
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.start > range.end ||
      range.start >= size ||
      range.end >= size
    ) {
      throw new RawFileRangeError("Unsatisfiable byte range");
    }
  }

  /** Resolves a path to a canonical readable file, sharing typed error mapping. */
  private resolveReadableFile(path: string): { path: string; size: number } {
    try {
      const real = realpathSync(path);
      const stat = statSync(real);
      if (!stat.isFile()) throw new DirectoryServiceError(400, `not a file: ${path}`);
      accessSync(real, constants.R_OK);
      return { path: real, size: stat.size };
    } catch (error) {
      throw fileServiceError(error, path) ?? error;
    }
  }

  requireCwd(path: string): string {
    return this.resolveReadableDirectory(path);
  }

  private windowsRootCandidates(): string[] {
    const roots = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`);
    const homeRoot = win32.parse(this.homeDir).root;
    if (homeRoot && !roots.some((candidate) => candidate.toLowerCase() === homeRoot.toLowerCase())) roots.push(homeRoot);
    return roots;
  }

  private tryReadableDirectory(path: string): string | null {
    try {
      return this.resolveReadableDirectory(path);
    } catch {
      return null;
    }
  }

  private resolveReadableDirectory(path: string): string {
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      throw new DirectoryServiceError(404, `does not exist: ${path}`);
    }
    let stat;
    try {
      stat = statSync(real);
    } catch {
      throw new DirectoryServiceError(404, `does not exist: ${path}`);
    }
    if (!stat.isDirectory()) throw new DirectoryServiceError(400, `not a directory: ${path}`);
    try {
      accessSync(real, constants.R_OK | constants.X_OK);
    } catch {
      throw new DirectoryServiceError(403, `Directory is not readable: ${path}`);
    }
    return real;
  }
}
