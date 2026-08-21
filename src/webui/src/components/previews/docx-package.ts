export interface DocxPackageLimits {
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
}

export type DocxPackageErrorCode =
  | "malformed"
  | "encrypted"
  | "zip64"
  | "not-docx"
  | "too-many-entries"
  | "entry-too-large"
  | "archive-too-large";

export class DocxPackageError extends Error {
  override readonly name = "DocxPackageError";

  constructor(public readonly code: DocxPackageErrorCode) {
    super(code);
  }
}

export interface DocxPackageSummary {
  entryCount: number;
  totalUncompressedBytes: number;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_ENTRY = 0x04034b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const ZIP64_EXTRA_FIELD = 0x0001;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const MAX_ZIP_COMMENT_BYTES = 0xffff;
const REQUIRED_DOCX_ENTRIES = new Set(["[Content_Types].xml", "word/document.xml"]);

function fail(code: DocxPackageErrorCode): never {
  throw new DocxPackageError(code);
}

function findEndOfCentralDirectory(view: DataView): number {
  if (view.byteLength < 22) fail("malformed");
  const earliest = Math.max(0, view.byteLength - 22 - MAX_ZIP_COMMENT_BYTES);
  for (let offset = view.byteLength - 4; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY) continue;
    if (offset + 22 > view.byteLength) fail("malformed");
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength !== view.byteLength) fail("malformed");
    return offset;
  }
  fail("malformed");
}

function checkedEnd(start: number, length: number, limit: number): number {
  const end = start + length;
  if (!Number.isSafeInteger(end) || start < 0 || length < 0 || end > limit) fail("malformed");
  return end;
}

function inspectExtraFields(view: DataView, start: number, length: number): void {
  const end = checkedEnd(start, length, view.byteLength);
  let cursor = start;
  while (cursor < end) {
    if (cursor + 4 > end) fail("malformed");
    const id = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    cursor = checkedEnd(cursor + 4, size, end);
    if (id === ZIP64_EXTRA_FIELD) fail("zip64");
  }
}

function equalBytes(bytes: ArrayBuffer, left: number, right: number, length: number): boolean {
  const values = new Uint8Array(bytes);
  for (let index = 0; index < length; index += 1) {
    if (values[left + index] !== values[right + index]) return false;
  }
  return true;
}

export function inspectDocxPackage(bytes: ArrayBuffer, limits: DocxPackageLimits): DocxPackageSummary {
  const view = new DataView(bytes);
  const eocdOffset = findEndOfCentralDirectory(view);
  const disk = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);

  if (
    disk === ZIP64_SENTINEL_16 ||
    centralDisk === ZIP64_SENTINEL_16 ||
    entriesOnDisk === ZIP64_SENTINEL_16 ||
    entryCount === ZIP64_SENTINEL_16 ||
    centralSize === ZIP64_SENTINEL_32 ||
    centralOffset === ZIP64_SENTINEL_32
  ) {
    fail("zip64");
  }
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) fail("malformed");
  if (entryCount > limits.maxEntries) fail("too-many-entries");

  const centralEnd = centralOffset + centralSize;
  if (eocdOffset >= 20 && view.getUint32(eocdOffset - 20, true) === ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR) {
    fail("zip64");
  }
  if (centralEnd < eocdOffset && view.getUint32(centralEnd, true) === ZIP64_END_OF_CENTRAL_DIRECTORY) fail("zip64");
  if (!Number.isSafeInteger(centralEnd) || centralOffset > eocdOffset || centralEnd !== eocdOffset) fail("malformed");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const names = new Set<string>();
  const localRanges: Array<{ start: number; end: number }> = [];
  let totalUncompressedBytes = 0;
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralEnd || view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_ENTRY) fail("malformed");
    const flags = view.getUint16(cursor + 8, true);
    if ((flags & 0x0041) !== 0) fail("encrypted");

    const compressionMethod = view.getUint16(cursor + 10, true);
    const crc32 = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const diskStart = view.getUint16(cursor + 34, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (
      compressedSize === ZIP64_SENTINEL_32 ||
      uncompressedSize === ZIP64_SENTINEL_32 ||
      diskStart === ZIP64_SENTINEL_16 ||
      localOffset === ZIP64_SENTINEL_32
    ) {
      fail("zip64");
    }
    if (diskStart !== 0) fail("malformed");
    if (uncompressedSize > limits.maxEntryUncompressedBytes) fail("entry-too-large");
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) fail("archive-too-large");

    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > centralEnd) fail("malformed");
    const centralNameOffset = cursor + 46;
    inspectExtraFields(view, centralNameOffset + nameLength, extraLength);

    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== LOCAL_FILE_ENTRY) fail("malformed");
    const localFlags = view.getUint16(localOffset + 6, true);
    const localCompressionMethod = view.getUint16(localOffset + 8, true);
    const localCrc32 = view.getUint32(localOffset + 14, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localUncompressedSize = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if (localCompressedSize === ZIP64_SENTINEL_32 || localUncompressedSize === ZIP64_SENTINEL_32) fail("zip64");
    if ((localFlags & 0x0041) !== 0) fail("encrypted");
    if (localFlags !== flags || localCompressionMethod !== compressionMethod || localNameLength !== nameLength) {
      fail("malformed");
    }
    const localNameOffset = localOffset + 30;
    const localDataOffset = checkedEnd(localNameOffset, localNameLength + localExtraLength, centralOffset);
    inspectExtraFields(view, localNameOffset + localNameLength, localExtraLength);
    if (!equalBytes(bytes, centralNameOffset, localNameOffset, nameLength)) fail("malformed");
    if ((flags & 0x0008) === 0) {
      if (
        localCrc32 !== crc32 ||
        localCompressedSize !== compressedSize ||
        localUncompressedSize !== uncompressedSize
      ) {
        fail("malformed");
      }
    } else if (
      (localCrc32 !== 0 && localCrc32 !== crc32) ||
      (localCompressedSize !== 0 && localCompressedSize !== compressedSize) ||
      (localUncompressedSize !== 0 && localUncompressedSize !== uncompressedSize)
    ) {
      fail("malformed");
    }
    localRanges.push({ start: localOffset, end: checkedEnd(localDataOffset, compressedSize, centralOffset) });

    try {
      names.add(decoder.decode(new Uint8Array(bytes, centralNameOffset, nameLength)));
    } catch {
      fail("malformed");
    }
    cursor = next;
  }

  if (cursor !== centralEnd) fail("malformed");
  localRanges.sort((left, right) => left.start - right.start);
  let previousLocalEnd = 0;
  for (const range of localRanges) {
    if (range.start < previousLocalEnd) fail("malformed");
    previousLocalEnd = range.end;
  }
  for (const required of REQUIRED_DOCX_ENTRIES) {
    if (!names.has(required)) fail("not-docx");
  }
  return { entryCount, totalUncompressedBytes };
}
