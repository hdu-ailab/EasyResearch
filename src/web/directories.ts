import { accessSync, closeSync, constants, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DirectoryEntryDto, FileContentDto, FileEntryDto } from "./contracts";
import { isBinaryBytes, mimeTypeFor, RawFileRangeError, type ByteRange, type RawFileDescriptor } from "./raw-file";

/** Maximum bytes read for a single file preview. */
export const FILE_PREVIEW_LIMIT = 1024 * 1024;

export interface DirectoryListing {
  path: string;
  entries: DirectoryEntryDto[];
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

/**
 * Server-backed local directory navigation. Only directories are returned,
 * sorted by name. The selected path is canonicalized to its absolute real
 * path; a project root is never inferred from an ancestor.
 */
export class DirectoryService {
  constructor(public readonly homeDir: string = homedir()) {}

  list(path?: string): DirectoryListing {
    const target = path ?? this.homeDir;
    let real: string;
    try {
      real = realpathSync(target);
    } catch (error) {
      throw new DirectoryServiceError(404, `does not exist: ${target}`);
    }
    let stat;
    try {
      stat = statSync(real);
    } catch {
      throw new DirectoryServiceError(404, `does not exist: ${target}`);
    }
    if (!stat.isDirectory()) {
      throw new DirectoryServiceError(400, `not a directory: ${target}`);
    }
    try {
      accessSync(real, constants.R_OK);
    } catch {
      throw new DirectoryServiceError(403, `Directory is not readable: ${target}`);
    }
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

  /**
   * Lists both files and directories of a directory, directories first, each
   * sorted by name. Powers the files panel tree.
   */
  listEntries(path?: string): { path: string; entries: FileEntryDto[] } {
    const listing = this.list(path);
    const dirents = readdirSync(listing.path, { withFileTypes: true });
    const entries: FileEntryDto[] = dirents
      .map((d) => ({
        kind: d.isDirectory() ? ("directory" as const) : ("file" as const),
        name: d.name,
        path: join(listing.path, d.name),
      }))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return { path: listing.path, entries };
  }

  /**
   * Reads a file's UTF-8 text for preview. Non-files and unreadable paths are
   * rejected; reads larger than {@link FILE_PREVIEW_LIMIT} truncate with a
   * `truncated` flag instead of failing. Binary or non-UTF-8 content is marked
   * `binary` with an empty `content` string while preserving `byteCount`.
   */
  readFile(path: string): FileContentDto {
    const file = this.resolveReadableFile(path);
    const buffer = readFileSync(file.path);
    const byteCount = buffer.byteLength;
    const truncated = byteCount > FILE_PREVIEW_LIMIT;
    const sample = buffer.subarray(0, FILE_PREVIEW_LIMIT);
    const binary = isBinaryBytes(sample);
    const content = binary ? "" : new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return { path: file.path, content, byteCount, truncated, binary };
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
    const file = this.resolveReadableFile(path);
    this.assertRange(range, file.size);
    const length = range.end - range.start + 1;
    const buffer = new Uint8Array(length);
    const fd = openSync(file.path, "r");
    try {
      let read = 0;
      while (read < length) {
        const count = readSync(fd, buffer, read, length - read, range.start + read);
        if (count === 0) break;
        read += count;
      }
      return read === length ? buffer : buffer.slice(0, read);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Opens a readable file and returns a web `ReadableStream` that emits only the
   * inclusive byte range (the whole file when `range` is `null`) in bounded
   * chunks, closing the descriptor on drain, error, or cancel. Used by the raw
   * file route so both full and ranged responses stream instead of buffering
   * the entire file.
   */
  readFileStream(path: string, range: ByteRange | null): ReadableStream<Uint8Array> {
    const file = this.resolveReadableFile(path);
    if (range !== null) this.assertRange(range, file.size);
    const fd = openSync(file.path, "r");
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, file.size - 1);
    const CHUNK_SIZE = 64 * 1024;
    let position = start;
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      try {
        closeSync(fd);
      } catch {
        // Best effort: the descriptor may already be closed by the kernel.
      }
    };
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        try {
          if (position > end) {
            close();
            controller.close();
            return;
          }
          const length = Math.min(CHUNK_SIZE, end - position + 1);
          const chunk = new Uint8Array(length);
          let read = 0;
          while (read < length) {
            const count = readSync(fd, chunk, read, length - read, position + read);
            if (count === 0) break;
            read += count;
          }
          position += read;
          if (read > 0) controller.enqueue(read === length ? chunk : chunk.slice(0, read));
          if (read === 0 || position > end) {
            close();
            controller.close();
          }
        } catch (error) {
          close();
          controller.error(error);
        }
      },
      cancel() {
        close();
      },
    });
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
    if (!stat.isFile()) {
      throw new DirectoryServiceError(400, `not a file: ${path}`);
    }
    try {
      accessSync(real, constants.R_OK);
    } catch {
      throw new DirectoryServiceError(403, `File is not readable: ${path}`);
    }
    return { path: real, size: stat.size };
  }

  requireCwd(path: string): string {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      throw new DirectoryServiceError(404, `does not exist: ${path}`);
    }
    if (!stat.isDirectory()) {
      throw new DirectoryServiceError(400, `not a directory: ${path}`);
    }
    try {
      return realpathSync(path);
    } catch {
      throw new DirectoryServiceError(404, `does not exist: ${path}`);
    }
  }
}
