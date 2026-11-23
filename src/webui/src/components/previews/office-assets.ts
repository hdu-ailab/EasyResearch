import presentationWasm from "../../../../../node_modules/@betteroffice/pptx/dist/generated/pptx_wasm_bg.wasm?url";
import spreadsheetWasm from "../../../../../node_modules/@betteroffice/xlsx/dist/generated/xlsx_wasm_bg.wasm?url";

// Explicit Vite asset imports keep packaged workers independent of node_modules
// and the font package's optional CDN/CJK loaders at runtime.
const fonts = import.meta.glob<string>("../../../../../node_modules/@betteroffice/fonts/assets/*.{ttf,otf}", {
  eager: true,
  query: "?url",
  import: "default",
});
const fontUrls = new Map(Object.entries(fonts).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1), url]));

export function officeAssetUrl(kind: "spreadsheet" | "presentation"): string {
  return kind === "spreadsheet" ? spreadsheetWasm : presentationWasm;
}

export function officeFontUrl(file: string): string | undefined {
  return fontUrls.get(file);
}
