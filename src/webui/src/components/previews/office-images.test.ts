import { describe, expect, it } from "vitest";
import { officeBitmapFixture } from "./office-fixtures.test-helper";
import { officeMediaPart, officeRasterInfo, officeRasterType } from "./office-images";

describe("Office picture boundaries", () => {
  it.each(["bmp", "tiff"] as const)("bounds %s geometry before decoding or conversion", (format) => {
    const bytes = officeBitmapFixture(format);
    expect(officeRasterInfo(bytes)).toEqual({ mime: `image/${format}`, width: 2, height: 2 });
    const view = new DataView(bytes.buffer);
    view.setUint32(18, 100_000, true); // BMP width and this fixture's TIFF ImageWidth scalar both sit here.
    expect(officeRasterInfo(bytes)).toBeUndefined();
  });
  it("accepts big-endian TIFF scalar dimensions and rejects ambiguous or truncated IFDs", () => {
    const bytes = new Uint8Array(38);
    const view = new DataView(bytes.buffer);
    bytes.set([0x4d, 0x4d, 0, 42]);
    view.setUint32(4, 8);
    view.setUint16(8, 2);
    view.setUint16(10, 256);
    view.setUint16(12, 3);
    view.setUint32(14, 1);
    view.setUint16(18, 320);
    view.setUint16(22, 257);
    view.setUint16(24, 4);
    view.setUint32(26, 1);
    view.setUint32(30, 180);
    expect(officeRasterInfo(bytes)).toEqual({ mime: "image/tiff", width: 320, height: 180 });
    view.setUint16(22, 256);
    expect(officeRasterInfo(bytes)).toBeUndefined();
    view.setUint16(22, 257);
    view.setUint16(8, 4097);
    expect(officeRasterInfo(bytes)).toBeUndefined();
  });
  it("accepts top-down BMP and rejects payload offsets outside the file", () => {
    const bytes = officeBitmapFixture("bmp");
    const view = new DataView(bytes.buffer);
    view.setInt32(22, -2, true);
    expect(officeRasterInfo(bytes)).toEqual({ mime: "image/bmp", width: 2, height: 2 });
    view.setUint32(10, bytes.length + 1, true);
    expect(officeRasterInfo(bytes)).toBeUndefined();
  });
  it("accepts an embedded raster but rejects oversized declared dimensions before decode", () => {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x89504e47);
    view.setUint32(4, 0x0d0a1a0a);
    view.setUint32(16, 1024);
    view.setUint32(20, 768);
    expect(officeRasterType(bytes)).toBe("image/png");
    view.setUint32(16, 100_000);
    expect(officeRasterType(bytes)).toBeUndefined();
  });
  it("keeps SVG, executable markup and remote media targets out of the resolver", () => {
    expect(
      officeRasterType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')),
    ).toBeUndefined();
    expect(officeMediaPart("ppt/media/image1.png")).toBe(true);
    for (const value of [
      "https://remote/image.png",
      "data:image/png;base64,AAAA",
      "ppt/media/../../../secret",
      "ppt/media/https:remote",
      "ppt/media/a\\b",
      "ppt/media/a?query",
    ])
      expect(officeMediaPart(value)).toBe(false);
  });
});
