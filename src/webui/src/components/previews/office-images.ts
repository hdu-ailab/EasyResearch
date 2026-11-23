/** Raster dimensions are inspected before browser decoding or Worker-side TIFF conversion. */
export function officeRasterInfo(bytes: Uint8Array): { mime: string; width: number; height: number } | undefined {
  if (bytes.byteLength > 32 * 1024 * 1024 || bytes.byteLength < 12) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bounded = (width: number, height: number, mime: string) =>
    width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_000_000
      ? { mime, width, height }
      : undefined;
  if (view.getUint16(0) === 0x424d && bytes.byteLength >= 26) {
    const header = view.getUint32(14, true);
    const dataOffset = view.getUint32(10, true);
    if (
      14 + header > bytes.byteLength ||
      dataOffset < 14 + header ||
      dataOffset >= bytes.byteLength ||
      view.getUint32(2, true) > bytes.byteLength
    )
      return;
    if (header === 12 && view.getUint16(22, true) === 1) {
      return bounded(view.getUint16(18, true), view.getUint16(20, true), "image/bmp");
    }
    if (header >= 40 && view.getUint16(26, true) === 1) {
      return bounded(view.getInt32(18, true), Math.abs(view.getInt32(22, true)), "image/bmp");
    }
    return;
  }
  if (view.getUint32(0) === 0x49492a00 || view.getUint32(0) === 0x4d4d002a) {
    const little = view.getUint16(0) === 0x4949;
    const offset = view.getUint32(4, little);
    if (offset < 8 || offset + 2 > bytes.byteLength) return;
    const count = view.getUint16(offset, little);
    if (count > 4096 || offset + 2 + count * 12 + 4 > bytes.byteLength) return;
    let width: number | undefined;
    let height: number | undefined;
    // The public helper decodes the first TIFF image. Read its scalar geometry
    // directly from the bounded classic-TIFF IFD before invoking that decoder.
    for (let index = 0; index < count; index++) {
      const entry = offset + 2 + index * 12;
      const tag = view.getUint16(entry, little);
      if (tag !== 256 && tag !== 257) continue;
      const type = view.getUint16(entry + 2, little);
      if ((type !== 3 && type !== 4) || view.getUint32(entry + 4, little) !== 1) return;
      const value = type === 3 ? view.getUint16(entry + 8, little) : view.getUint32(entry + 8, little);
      if (tag === 256) {
        if (width !== undefined) return;
        width = value;
      } else {
        if (height !== undefined) return;
        height = value;
      }
    }
    return bounded(width ?? 0, height ?? 0, "image/tiff");
  }
  if (view.getUint32(0) === 0x89504e47 && bytes.byteLength >= 24 && view.getUint32(4) === 0x0d0a1a0a) {
    return bounded(view.getUint32(16), view.getUint32(20), "image/png");
  }
  if (view.getUint32(0) === 0x47494638) return bounded(view.getUint16(6, true), view.getUint16(8, true), "image/gif");
  if (view.getUint16(0) === 0xffd8) {
    let cursor = 2;
    while (cursor + 4 <= bytes.byteLength) {
      if (bytes[cursor] !== 0xff) return;
      const marker = view.getUint8(cursor + 1);
      if (marker === 0xff) {
        cursor++;
        continue;
      }
      if (marker === 0xda || marker === 0xd9) return;
      const length = view.getUint16(cursor + 2);
      if (length < 2 || cursor + 2 + length > bytes.byteLength) return;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 7) {
        return bounded(view.getUint16(cursor + 7), view.getUint16(cursor + 5), "image/jpeg");
      }
      cursor += length + 2;
    }
  }
  if (view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250 && bytes.byteLength >= 30) {
    const chunk = view.getUint32(12);
    if (chunk === 0x56503858) {
      const uint24 = (offset: number) =>
        view.getUint8(offset) + view.getUint8(offset + 1) * 256 + view.getUint8(offset + 2) * 65536;
      return bounded(uint24(24) + 1, uint24(27) + 1, "image/webp");
    }
    if (chunk === 0x56503820 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      return bounded(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff, "image/webp");
    }
    if (chunk === 0x5650384c && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return bounded((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, "image/webp");
    }
  }
  return undefined;
}

export function officeRasterType(bytes: Uint8Array): string | undefined {
  return officeRasterInfo(bytes)?.mime;
}

export function officeMediaPart(id: string): boolean {
  return (
    id.startsWith("ppt/media/") &&
    !/[\\:?#]/.test(id) &&
    ![...id].some((character) => character.charCodeAt(0) < 32) &&
    !id.split("/").some((part) => !part || part === "." || part === "..")
  );
}
