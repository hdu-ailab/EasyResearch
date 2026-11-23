import type { SlideDisplayList } from "@betteroffice/pptx";
import type { DisplayList } from "@betteroffice/xlsx";

export type OfficeKind = "spreadsheet" | "presentation";
export const OFFICE_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const OFFICE_ROWS = 25;
export const OFFICE_COLUMNS = 10;
export const OFFICE_MAX_TEXT = 65_536;
export const OFFICE_PACKAGE_LIMITS = {
  maxEntries: 8_192,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
};

export interface OfficeFont {
  family: string;
  weight: string;
  style: string;
  bytes: Uint8Array<ArrayBuffer>;
}
export interface OfficeDocument {
  kind: OfficeKind;
  items: { index: number; name: string }[];
}
export interface OfficeView {
  index: number;
  row: number;
  column: number;
}
interface FrameBase {
  fonts: OfficeFont[];
  text: string;
  truncated: boolean;
}
export interface SheetFrame extends FrameBase {
  kind: "spreadsheet";
  list: DisplayList;
  cells: string[][];
  row: number;
  column: number;
  lastRow: number;
  lastColumn: number;
  rowCount: number;
  columnCount: number;
}
export interface SlideFrame extends FrameBase {
  kind: "presentation";
  list: SlideDisplayList;
  notes: string;
  images: OfficeImage[];
  omittedImages: boolean;
}
export interface OfficeImage {
  id: string;
  bytes: Uint8Array<ArrayBuffer>;
  mime: string;
  /** Present only for static SVG reconstructed and size-bounded inside the file Worker. */
  svgSize?: { width: number; height: number };
}
export type OfficeFrame = SheetFrame | SlideFrame;
export type OfficeRequest =
  | { id: number; type: "open"; kind: OfficeKind; bytes: ArrayBuffer; fontPrefix: string }
  | { id: number; type: "frame"; view: OfficeView };
export type OfficeReply =
  | { id: number; type: "opened"; document: OfficeDocument }
  | { id: number; type: "frame"; frame: OfficeFrame }
  | { id: number; type: "error"; code: string };

export function officeCanvasSize(width: number, height: number, density: number) {
  if (![width, height, density].every(Number.isFinite) || width <= 0 || height <= 0 || density <= 0) {
    throw new Error("geometry");
  }
  const scale = Math.min(density, 4096 / width, 4096 / height, Math.sqrt(8_000_000 / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale };
}

export function officeColumnLabel(column: number): string {
  let value = column + 1;
  let result = "";
  while (value > 0) {
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}
