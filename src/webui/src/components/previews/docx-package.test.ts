import { describe, expect, it } from "vitest";
import { DocxPackageError, type DocxPackageLimits, inspectDocxPackage } from "./docx-package";

interface ZipEntrySpec {
  name: string;
  flags?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  extra?: Uint8Array;
}

const encoder = new TextEncoder();

function zipWithCentralDirectory(entries: ZipEntrySpec[]): ArrayBuffer {
  const names = entries.map((entry) => encoder.encode(entry.name));
  const extras = entries.map((entry) => entry.extra ?? new Uint8Array());
  const localSize = names.reduce((total, name, index) => total + 30 + name.byteLength + extras[index]!.byteLength, 0);
  const centralSize = names.reduce((total, name, index) => total + 46 + name.byteLength + extras[index]!.byteLength, 0);
  const bytes = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(bytes.buffer);
  let localOffset = 0;
  const localOffsets: number[] = [];

  entries.forEach((entry, index) => {
    const name = names[index]!;
    const extra = extras[index]!;
    localOffsets.push(localOffset);
    view.setUint32(localOffset, 0x04034b50, true);
    view.setUint16(localOffset + 4, 20, true);
    view.setUint16(localOffset + 6, entry.flags ?? 0, true);
    view.setUint16(localOffset + 8, 0, true);
    view.setUint32(localOffset + 18, entry.compressedSize ?? 0, true);
    view.setUint32(localOffset + 22, entry.uncompressedSize ?? 0, true);
    view.setUint16(localOffset + 26, name.byteLength, true);
    view.setUint16(localOffset + 28, extra.byteLength, true);
    bytes.set(name, localOffset + 30);
    bytes.set(extra, localOffset + 30 + name.byteLength);
    localOffset += 30 + name.byteLength + extra.byteLength;
  });

  const centralOffset = localOffset;
  entries.forEach((entry, index) => {
    const name = names[index]!;
    const extra = extras[index]!;
    view.setUint32(localOffset, 0x02014b50, true);
    view.setUint16(localOffset + 4, 20, true);
    view.setUint16(localOffset + 6, 20, true);
    view.setUint16(localOffset + 8, entry.flags ?? 0, true);
    view.setUint16(localOffset + 10, 0, true);
    view.setUint32(localOffset + 20, entry.compressedSize ?? 0, true);
    view.setUint32(localOffset + 24, entry.uncompressedSize ?? 0, true);
    view.setUint16(localOffset + 28, name.byteLength, true);
    view.setUint16(localOffset + 30, extra.byteLength, true);
    view.setUint32(localOffset + 42, localOffsets[index]!, true);
    bytes.set(name, localOffset + 46);
    bytes.set(extra, localOffset + 46 + name.byteLength);
    localOffset += 46 + name.byteLength + extra.byteLength;
  });

  view.setUint32(localOffset, 0x06054b50, true);
  view.setUint16(localOffset + 8, entries.length, true);
  view.setUint16(localOffset + 10, entries.length, true);
  view.setUint32(localOffset + 12, centralSize, true);
  view.setUint32(localOffset + 16, centralOffset, true);
  return bytes.buffer;
}

const requiredEntries: ZipEntrySpec[] = [{ name: "[Content_Types].xml" }, { name: "word/document.xml" }];

const generousLimits: DocxPackageLimits = {
  maxEntries: 10,
  maxEntryUncompressedBytes: 100,
  maxTotalUncompressedBytes: 200,
};

describe("inspectDocxPackage", () => {
  it("accepts a bounded DOCX package and reports its declared expansion", () => {
    const bytes = zipWithCentralDirectory([...requiredEntries, { name: "word/media/image.png", uncompressedSize: 12 }]);

    expect(inspectDocxPackage(bytes, generousLimits)).toEqual({ entryCount: 3, totalUncompressedBytes: 12 });
  });

  it.each([
    ["malformed", new Uint8Array([1, 2, 3]).buffer, "malformed"],
    ["encrypted", zipWithCentralDirectory([{ ...requiredEntries[0]!, flags: 1 }, requiredEntries[1]!]), "encrypted"],
    [
      "ZIP64",
      zipWithCentralDirectory([...requiredEntries, { name: "word/media/a.bin", uncompressedSize: 0xffffffff }]),
      "zip64",
    ],
    ["not a DOCX", zipWithCentralDirectory([{ name: "plain.txt" }]), "not-docx"],
  ])("rejects a %s package", (_case, bytes, code) => {
    expect(() => inspectDocxPackage(bytes, generousLimits)).toThrowError(expect.objectContaining({ code }));
  });

  it("rejects a package with too many entries before rendering", () => {
    const bytes = zipWithCentralDirectory([...requiredEntries, { name: "word/styles.xml" }]);
    expect(() => inspectDocxPackage(bytes, { ...generousLimits, maxEntries: 2 })).toThrowError(
      expect.objectContaining({ code: "too-many-entries" }),
    );
  });

  it("rejects one oversized expanded entry", () => {
    const bytes = zipWithCentralDirectory([...requiredEntries, { name: "word/media/a.bin", uncompressedSize: 11 }]);
    expect(() => inspectDocxPackage(bytes, { ...generousLimits, maxEntryUncompressedBytes: 10 })).toThrowError(
      expect.objectContaining({ code: "entry-too-large" }),
    );
  });

  it("rejects excessive total declared expansion", () => {
    const bytes = zipWithCentralDirectory([
      ...requiredEntries,
      { name: "word/media/a.bin", uncompressedSize: 6 },
      { name: "word/media/b.bin", uncompressedSize: 6 },
    ]);
    expect(() => inspectDocxPackage(bytes, { ...generousLimits, maxTotalUncompressedBytes: 10 })).toThrowError(
      expect.objectContaining({ code: "archive-too-large" }),
    );
  });

  it("rejects a rebased shadow directory that the renderer would consume", () => {
    const benign = new Uint8Array(zipWithCentralDirectory(requiredEntries));
    const shadow = new Uint8Array(
      zipWithCentralDirectory([requiredEntries[0]!, { ...requiredEntries[1]!, uncompressedSize: 101 }]),
    );
    const eocdSize = 22;
    const directoryEnd = benign.byteLength - eocdSize;
    const bytes = new Uint8Array(directoryEnd * 2 + eocdSize);
    bytes.set(benign.subarray(0, directoryEnd));
    bytes.set(shadow.subarray(0, directoryEnd), directoryEnd);
    bytes.set(benign.subarray(directoryEnd), directoryEnd * 2);

    expect(() => inspectDocxPackage(bytes.buffer, generousLimits)).toThrowError(
      expect.objectContaining({ code: "malformed" }),
    );
  });

  it("rejects a later EOCD signature hidden in the ZIP comment", () => {
    const source = new Uint8Array(zipWithCentralDirectory(requiredEntries));
    const bytes = new Uint8Array(source.byteLength + 4);
    bytes.set(source);
    const view = new DataView(bytes.buffer);
    view.setUint16(source.byteLength - 2, 4, true);
    view.setUint32(source.byteLength, 0x06054b50, true);

    expect(() => inspectDocxPackage(bytes.buffer, generousLimits)).toThrowError(
      expect.objectContaining({ code: "malformed" }),
    );
  });

  it.each([
    ["EOCD disk number", "eocd", 4, 0xffff],
    ["EOCD central-directory disk", "eocd", 6, 0xffff],
    ["central-directory disk start", "central", 34, 0xffff],
    ["central-directory local offset", "central", 42, 0xffffffff],
    ["local compressed size", "local", 18, 0xffffffff],
    ["local uncompressed size", "local", 22, 0xffffffff],
  ])("rejects the ZIP64 sentinel in %s", (_case, section, relativeOffset, value) => {
    const bytes = zipWithCentralDirectory(requiredEntries);
    const view = new DataView(bytes);
    const eocdOffset = bytes.byteLength - 22;
    const centralOffset = view.getUint32(eocdOffset + 16, true);
    const base = section === "eocd" ? eocdOffset : section === "central" ? centralOffset : 0;
    if (value === 0xffff) view.setUint16(base + relativeOffset, value, true);
    else view.setUint32(base + relativeOffset, value, true);

    expect(() => inspectDocxPackage(bytes, generousLimits)).toThrowError(expect.objectContaining({ code: "zip64" }));
  });

  it("rejects ZIP64 extra fields even without sentinel sizes", () => {
    const zip64Extra = new Uint8Array([0x01, 0x00, 0x00, 0x00]);
    const bytes = zipWithCentralDirectory([{ ...requiredEntries[0]!, extra: zip64Extra }, requiredEntries[1]!]);

    expect(() => inspectDocxPackage(bytes, generousLimits)).toThrowError(expect.objectContaining({ code: "zip64" }));
  });

  it("rejects local headers that disagree with the validated central directory", () => {
    const bytes = zipWithCentralDirectory(requiredEntries);
    const view = new DataView(bytes);
    view.setUint16(6, 1, true);

    expect(() => inspectDocxPackage(bytes, generousLimits)).toThrowError(
      expect.objectContaining({ code: "encrypted" }),
    );
  });

  it("rejects local filenames that disagree with the validated central directory", () => {
    const bytes = zipWithCentralDirectory(requiredEntries);
    new Uint8Array(bytes)[30] = "x".charCodeAt(0);

    expect(() => inspectDocxPackage(bytes, generousLimits)).toThrowError(
      expect.objectContaining({ code: "malformed" }),
    );
  });

  it("rejects compressed payload ranges that overlap the central directory", () => {
    const bytes = zipWithCentralDirectory([{ ...requiredEntries[0]!, compressedSize: 1 }, requiredEntries[1]!]);

    expect(() => inspectDocxPackage(bytes, generousLimits)).toThrowError(
      expect.objectContaining({ code: "malformed" }),
    );
  });

  it("uses one typed error for package validation failures", () => {
    expect(() => inspectDocxPackage(new Uint8Array([1]).buffer, generousLimits)).toThrow(DocxPackageError);
  });
});
