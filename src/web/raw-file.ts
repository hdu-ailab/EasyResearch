/**
 * Pure helpers for MIME-correct ranged raw file responses.
 *
 * Ranges use inclusive byte offsets as specified by RFC 9110: a `bytes=a-b`
 * header selects bytes `a` through `b` inclusive, suffix ranges (`bytes=-n`)
 * select the last `n` bytes, and open ranges (`bytes=a-`) select through the
 * end of the file.
 */

export interface ByteRange {
  start: number;
  end: number;
}

/** Rejected or unsatisfiable byte range, converted to HTTP 416 by routes. */
export class RawFileRangeError extends Error {}

export function parseByteRange(value: string | null, size: number): ByteRange | null {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || size === 0) throw new RawFileRangeError("Invalid byte range");
  const [, first, last] = match;
  if (!first && !last) throw new RawFileRangeError("Invalid byte range");
  const start = first ? Number(first) : Math.max(0, size - Number(last));
  const end = last && first ? Math.min(Number(last), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
    throw new RawFileRangeError("Unsatisfiable byte range");
  }
  return { start, end };
}

export interface RawFileDescriptor {
  path: string;
  size: number;
  mimeType: string;
}

const EXTENSION_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".text": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".toml": "text/toml; charset=utf-8",
  ".py": "text/x-python; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".ts": "text/typescript; charset=utf-8",
  ".tsx": "text/typescript; charset=utf-8",
  ".ipynb": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".epub": "application/epub+zip",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const DEFAULT_MIME_TYPE = "application/octet-stream";

/** Maps a file name to a conservative MIME type, falling back to octet-stream. */
export function mimeTypeFor(file: string): string {
  const dot = file.lastIndexOf(".");
  if (dot === -1 || dot === file.length - 1) return DEFAULT_MIME_TYPE;
  return EXTENSION_MIME[file.slice(dot).toLowerCase()] ?? DEFAULT_MIME_TYPE;
}

/**
 * Marks a byte sample as binary when it contains a NUL byte or is not
 * decodable as strict UTF-8.
 */
export function isBinaryBytes(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}
