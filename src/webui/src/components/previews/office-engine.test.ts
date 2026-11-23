// @vitest-environment node
import { readFile } from "node:fs/promises";
import { paintSlide } from "@betteroffice/pptx";
import { fromTsv, paintDisplayList } from "@betteroffice/xlsx";
import { describe, expect, it, vi } from "vitest";
import { type OfficeEngineAssets, openOfficeEngine } from "./office-engine";
import { officeBitmapFixture, presentationFixture, workbookFixture } from "./office-fixtures.test-helper";
import { shippedOfficeFace } from "./office-fonts";
import { officeRasterInfo } from "./office-images";
import { officeCanvasSize, officeColumnLabel } from "./office-protocol";

async function assets(kind: "xlsx" | "pptx"): Promise<OfficeEngineAssets> {
  const root = new URL("../../../../../node_modules/@betteroffice/", import.meta.url);
  return {
    wasm: new Uint8Array(await readFile(new URL(`${kind}/dist/generated/${kind}_wasm_bg.wasm`, root))),
    font: async (face) => new Uint8Array(await readFile(new URL(`fonts/assets/${face.file}`, root))),
  };
}

/** Recording Canvas2D host tests the real public painters without pretending Node rasterizes pixels. */
function recordingContext() {
  const fillText = vi.fn();
  const drawImage = vi.fn();
  const fill = vi.fn();
  const context = new Proxy<Record<string, unknown>>(
    {
      canvas: { width: 960, height: 540 },
      fillText,
      drawImage,
      fill,
      measureText: (text: string) => ({
        width: text.length * 8,
        actualBoundingBoxAscent: 12,
        actualBoundingBoxDescent: 3,
      }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
    },
    {
      get: (target, property) => target[String(property)] ?? (() => {}),
      set: (target, property, value) => {
        target[String(property)] = value;
        return true;
      },
    },
  );
  return { context: context as unknown as CanvasRenderingContext2D, fillText, drawImage, fill };
}

describe("real packaged Office WASM", () => {
  it.each(["bmp", "tiff"] as const)(
    "renders an embedded %s through the public presentation image helper with bounded output",
    async (format) => {
      const source = officeBitmapFixture(format);
      const engine = await openOfficeEngine(
        "presentation",
        presentationFixture({ format, bytes: source }),
        await assets("pptx"),
        "BitmapTest",
      );
      try {
        const frame = await engine.frame({ index: 0, row: 0, column: 0 });
        if (frame.kind !== "presentation") throw new Error("wrong frame");
        expect(frame.omittedImages).toBe(false);
        const picture = frame.images[0];
        expect(picture).toBeDefined();
        const mime = format === "bmp" ? "image/bmp" : "image/png";
        expect(picture?.mime).toBe(mime);
        expect(officeRasterInfo(picture?.bytes ?? new Uint8Array())).toEqual({ mime, width: 2, height: 2 });
        if (format === "bmp") expect(picture?.bytes).toEqual(source);
        else expect(picture?.bytes.slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
      } finally {
        engine.dispose();
      }
    },
  );
  it("reads styled numeric cells, changes sheets and pages without changing the workbook", async () => {
    const bytes = workbookFixture();
    const original = new Uint8Array(bytes).slice();
    const engine = await openOfficeEngine("spreadsheet", bytes, await assets("xlsx"), "SheetTest");
    try {
      expect(engine.document.items.map((item) => item.name)).toEqual(["Numbers", "Evidence"]);
      const first = await engine.frame({ index: 0, row: 0, column: 0 });
      if (first.kind !== "spreadsheet") throw new Error("wrong frame");
      expect(first.cells[0]?.slice(0, 2)).toEqual(["Styled value", "42.50"]);
      expect(fromTsv(first.text)).toEqual(first.cells);
      expect(first.list.commands).toContainEqual(
        expect.objectContaining({ op: "text", text: "42.50", bold: true, color: "#0055aa" }),
      );
      expect(first.list.commands).toContainEqual(expect.objectContaining({ op: "fillRect", color: "#ffdd00" }));
      const canvas = recordingContext();
      paintDisplayList(canvas.context, first.list, 1);
      expect(canvas.fillText.mock.calls.map((call) => call[0])).toContain("42.50");
      const second = await engine.frame({ index: 1, row: 0, column: 0 });
      expect(second.text).toContain("第二张表");
      const page = await engine.frame({ index: 0, row: 25, column: 0 });
      expect(page.text).toContain("Second page");
      expect(page.text).not.toContain("Styled value");
      expect(new Uint8Array(bytes)).toEqual(original);
      expect(first.fonts.length).toBeGreaterThan(0);
      expect(first.fonts.every((font) => font.bytes.byteLength > 0)).toBe(true);
      await expect(engine.frame({ index: 0, row: -1, column: 0 })).rejects.toThrow("range");
    } finally {
      engine.dispose();
    }
  });

  it("lays out and paints real PPTX text, shapes and a document-only picture, retaining notes", async () => {
    const engine = await openOfficeEngine("presentation", presentationFixture(), await assets("pptx"), "SlideTest");
    try {
      const frame = await engine.frame({ index: 0, row: 0, column: 0 });
      if (frame.kind !== "presentation") throw new Error("wrong frame");
      expect(frame.text).toContain("Slide 1");
      expect(frame.notes).toContain("Speaker notes");
      expect(frame.list.primitives.map((item) => item.kind)).toEqual(
        expect.arrayContaining(["shape", "textBox", "image"]),
      );
      expect(frame.images).toEqual([expect.objectContaining({ id: "ppt/media/image1.png", mime: "image/png" })]);
      expect(frame.omittedImages).toBe(false);
      const canvas = recordingContext();
      const resolveImage = vi.fn(() => ({ width: 1, height: 1 }) as CanvasImageSource);
      await paintSlide(canvas.context, frame.list, 1, 1, { resolveImage });
      expect(canvas.fillText.mock.calls.map((call) => call[0]).join("")).toContain("Slide 1");
      expect(canvas.fill).toHaveBeenCalled();
      expect(resolveImage).toHaveBeenCalledWith(frame.images[0]!.id);
      expect(canvas.drawImage).toHaveBeenCalled();
      const second = await engine.frame({ index: 1, row: 0, column: 0 });
      expect(second.text).toContain("Slide 2");
      expect(second.text).not.toContain("Slide 1");
    } finally {
      engine.dispose();
    }
  });

  it("rejects cross-format packages before initializing the requested engine", async () => {
    const font = vi.fn();
    await expect(
      openOfficeEngine("presentation", workbookFixture(), { wasm: new Uint8Array(), font }, "Test"),
    ).rejects.toMatchObject({ code: "not-pptx" });
    expect(font).not.toHaveBeenCalled();
  });

  it("extracts a real embedded SVG through PPTX WASM and emits a bounded static image for browser painting", async () => {
    const bytes = presentationFixture(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#3155d9"/><text x="10" y="90">SVG_PREVIEW_SENTINEL</text></svg>',
    );
    const engine = await openOfficeEngine("presentation", bytes, await assets("pptx"), "SvgTest");
    try {
      const frame = await engine.frame({ index: 0, row: 0, column: 0 });
      if (frame.kind !== "presentation") throw new Error("wrong frame");
      expect(frame.omittedImages).toBe(false);
      expect(frame.images).toEqual([
        expect.objectContaining({
          id: "ppt/media/image1.svg",
          mime: "image/svg+xml",
          svgSize: { width: 320, height: 180 },
        }),
      ]);
      expect(new TextDecoder().decode(frame.images[0]?.bytes)).toContain("SVG_PREVIEW_SENTINEL");
    } finally {
      engine.dispose();
    }
  });
});

describe("Office bounds and bundled font selection", () => {
  it.each([
    [960, 540, 2],
    [1e12, 1, 2],
    [50000, 50000, 50],
  ])("bounds canvas backing stores for %s by %s", (width, height, density) => {
    const size = officeCanvasSize(width, height, density);
    expect(size.width).toBeLessThanOrEqual(4096);
    expect(size.height).toBeLessThanOrEqual(4096);
    expect(size.width * size.height).toBeLessThanOrEqual(8_000_000);
  });
  it("rejects non-finite geometry and preserves column labels", () => {
    expect(() => officeCanvasSize(Infinity, 1, 1)).toThrow("geometry");
    expect(officeColumnLabel(0)).toBe("A");
    expect(officeColumnLabel(26)).toBe("AA");
    expect(officeColumnLabel(16383)).toBe("XFD");
  });
  it.each(["Calibri", "Microsoft YaHei", "Yu Gothic Medium", "Missing Font"])(
    "selects a shipped non-addon face for %s",
    (family) => {
      expect(shippedOfficeFace(family, false, false).script?.startsWith("cjk-")).not.toBe(true);
    },
  );
});
