import type { BundledFontFace } from "@betteroffice/fonts";
import type { SlidePrimitive } from "@betteroffice/pptx";
import { inspectOfficePackage } from "./docx-package";
import { createOfficeFonts } from "./office-fonts";
import { officeMediaPart, officeRasterInfo } from "./office-images";
import {
  OFFICE_COLUMNS,
  OFFICE_MAX_FILE_BYTES,
  OFFICE_MAX_TEXT,
  OFFICE_PACKAGE_LIMITS,
  OFFICE_ROWS,
  type OfficeDocument,
  type OfficeFrame,
  type OfficeImage,
  type OfficeKind,
  type OfficeView,
  officeCanvasSize,
} from "./office-protocol";
import { sanitizeOfficeSvg } from "./office-svg";

export interface OfficeEngineAssets {
  wasm: string | Uint8Array<ArrayBuffer>;
  font(face: BundledFontFace): Promise<Uint8Array<ArrayBuffer>>;
}
export interface OfficeEngine {
  document: OfficeDocument;
  frame(view: OfficeView): Promise<OfficeFrame>;
  dispose(): void;
}

function checkFrame(value: unknown): void {
  if (JSON.stringify(value).length > 8 * 1024 * 1024) throw new Error("limit");
}
function indexIn(index: number, count: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error("range");
}
function visitSlides(primitives: SlidePrimitive[], visit: (primitive: SlidePrimitive) => void): void {
  let count = 0;
  const walk = (items: SlidePrimitive[], depth: number) => {
    if (depth > 32) throw new Error("limit");
    for (const item of items) {
      if (++count > 20_000) throw new Error("limit");
      visit(item);
      if (item.kind === "table" || item.kind === "chart") walk(item.primitives, depth + 1);
    }
  };
  walk(primitives, 0);
}

/** Runs only in the owned file Worker (also callable with explicit WASM bytes in engine tests). */
export async function openOfficeEngine(
  kind: OfficeKind,
  bytes: ArrayBuffer,
  assets: OfficeEngineAssets,
  fontPrefix: string,
): Promise<OfficeEngine> {
  if (bytes.byteLength > OFFICE_MAX_FILE_BYTES) throw new Error("limit");
  inspectOfficePackage(bytes, kind === "spreadsheet" ? "xlsx" : "pptx", OFFICE_PACKAGE_LIMITS);
  if (kind === "spreadsheet") {
    const api = await import("@betteroffice/xlsx");
    await api.initWasm(assets.wasm);
    const workbook = api.openWorkbook(new Uint8Array(bytes));
    try {
      const info = workbook.sheetInfo();
      if (info.sheetNames.length > 2048) throw new Error("limit");
      const fonts = createOfficeFonts(fontPrefix, assets.font);
      return {
        document: { kind, items: info.sheetNames.map((name, index) => ({ name: name.slice(0, 512), index })) },
        async frame(view) {
          indexIn(view.index, info.sheetNames.length);
          indexIn(view.row, 1_048_576);
          indexIn(view.column, 16_384);
          const sheetId = info.sheetIds[view.index];
          if (!sheetId) throw new Error("range");
          workbook.setActiveSheet(view.index);
          const exported = workbook.exportStructured({
            scope: [{ sheet: view.index, range: "A1:XFD1048576" }],
            maxCells: 1,
            includeDefinedNames: false,
          });
          const used = exported.ok ? exported.content.sheets[0]?.usedRange : undefined;
          const match = used?.match(/([A-Z]+)(\d+)$/);
          const rowCount = Math.min(1_048_576, Math.max(1, Number(match?.[2] ?? 1)));
          const columnCount = Math.min(
            16_384,
            Math.max(
              1,
              [...(match?.[1] ?? "A")].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0),
            ),
          );
          const endRow = Math.min(1_048_575, view.row + OFFICE_ROWS - 1);
          const endColumn = Math.min(16_383, view.column + OFFICE_COLUMNS - 1);
          const position = workbook.cellPosition(view.index, view.row, view.column);
          const end = workbook.cellPosition(
            view.index,
            Math.min(endRow + 1, 1_048_575),
            Math.min(endColumn + 1, 16_383),
          );
          const list = workbook.displayList({
            ...position,
            width: Math.max(320, Math.min(1536, end.x - position.x)),
            height: Math.max(200, Math.min(1024, end.y - position.y)),
          });
          checkFrame(list);
          officeCanvasSize(list.width, list.height, 1);
          if (list.commands.length > 100_000) throw new Error("limit");
          for (const command of list.commands) {
            if (command.op !== "text") continue;
            const family = command.fontFamily ?? "Calibri";
            await fonts.ensure(family, command.bold, command.italic);
            command.fontFamily = fonts.family(family, command.bold, command.italic);
          }
          const result = workbook.readCells({
            ranges: [
              {
                sheetId,
                range: {
                  kind: "rowCol",
                  start: { row: view.row, col: view.column },
                  end: { row: endRow, col: endColumn },
                },
              },
            ],
          });
          if (!result.ok) throw new Error("parse");
          let remaining = OFFICE_MAX_TEXT;
          let truncated = false;
          const cells = (result.ranges[0]?.cells ?? []).map((row) =>
            row.map((cell) => {
              const text = cell.displayText.slice(0, Math.max(0, remaining));
              remaining -= text.length;
              truncated ||= text.length !== cell.displayText.length;
              return text;
            }),
          );
          return {
            kind,
            list,
            fonts: fonts.take(),
            cells,
            text: api.toTsv(
              cells.map((row, rowIndex) =>
                row.map((input, columnIndex) => ({
                  input,
                  // Copy displayed numeric values literally; text stays literal even when it looks like a formula.
                  isFormula: result.ranges[0]?.cells[rowIndex]?.[columnIndex]?.value.kind === "number",
                })),
              ),
            ),
            truncated,
            row: view.row,
            column: view.column,
            lastRow: endRow,
            lastColumn: endColumn,
            rowCount,
            columnCount,
          };
        },
        dispose: () => workbook.dispose(),
      };
    } catch (error) {
      workbook.dispose();
      throw error;
    }
  }
  const api = await import("@betteroffice/pptx");
  await api.initWasm(assets.wasm);
  const deck = api.openPresentation(new Uint8Array(bytes));
  try {
    const snapshot = deck.snapshot();
    if (snapshot.slides.length > 4096) throw new Error("limit");
    const fonts = createOfficeFonts(fontPrefix, assets.font, deck);
    await fonts.ensure("Calibri");
    return {
      document: { kind, items: snapshot.slides.map((_, index) => ({ index, name: String(index + 1) })) },
      async frame(view) {
        indexIn(view.index, snapshot.slides.length);
        let list = deck.layoutSlide(view.index);
        checkFrame(list);
        const wanted: { family: string; bold: boolean; italic: boolean }[] = [];
        visitSlides(list.primitives, (item) => {
          if (item.kind === "textBox")
            for (const line of item.lines)
              for (const run of line.runs) {
                wanted.push({ family: run.fontFamily, bold: run.bold, italic: run.italic });
              }
        });
        for (const want of wanted) await fonts.ensure(want.family, want.bold, want.italic);
        list = deck.layoutSlide(view.index);
        checkFrame(list);
        officeCanvasSize(list.width, list.height, 1);
        const parts = new Set<string>();
        let text = "";
        let truncated = false;
        const append = (value: string) => {
          const added = `${value}\n`;
          const remaining = OFFICE_MAX_TEXT - text.length;
          text += added.slice(0, Math.max(0, remaining));
          truncated ||= added.length > remaining;
        };
        visitSlides(list.primitives, (item) => {
          if (item.kind === "image" && item.assetId) parts.add(item.assetId);
          if (item.kind === "table" || item.kind === "chart") append(item.label);
          if (item.kind === "textBox") {
            for (const paragraph of item.paragraphs) append(paragraph.runs.map((run) => run.text).join(""));
            for (const line of item.lines)
              for (const run of line.runs) {
                run.fontFamily = fonts.family(run.fontFamily, run.bold, run.italic);
              }
          }
        });
        const images: OfficeImage[] = [];
        let imageBytes = 0;
        let omittedImages = false;
        for (const id of parts) {
          try {
            if (!officeMediaPart(id) || images.length >= 64) throw new Error("image");
            const original = new Uint8Array(deck.mediaBytes(id));
            const raster = officeRasterInfo(original);
            const svg = raster ? undefined : sanitizeOfficeSvg(original);
            let image = svg?.bytes ?? original;
            let mime = raster?.mime ?? svg?.mime;
            if (raster && (raster.mime === "image/tiff" || raster.mime === "image/bmp")) {
              const converted = api.presentationImageBlob(original);
              if (converted.size > 32 * 1024 * 1024) throw new Error("image");
              image = new Uint8Array(await converted.arrayBuffer());
              const output = officeRasterInfo(image);
              if (
                !output ||
                output.width !== raster.width ||
                output.height !== raster.height ||
                output.mime !== (raster.mime === "image/tiff" ? "image/png" : "image/bmp")
              )
                throw new Error("image");
              mime = output.mime;
            }
            if (!mime || imageBytes + image.byteLength > 64 * 1024 * 1024) throw new Error("image");
            imageBytes += image.byteLength;
            images.push({
              id,
              bytes: image,
              mime,
              ...(svg ? { svgSize: { width: svg.width, height: svg.height } } : {}),
            });
          } catch {
            omittedImages = true;
          }
        }
        const notes = snapshot.slides[view.index]?.notes ?? "";
        truncated ||= notes.length > OFFICE_MAX_TEXT;
        return {
          kind,
          list,
          text,
          notes: notes.slice(0, OFFICE_MAX_TEXT),
          images,
          omittedImages,
          fonts: fonts.take(),
          truncated,
        };
      },
      dispose: () => deck.dispose(),
    };
  } catch (error) {
    deck.dispose();
    throw error;
  }
}
