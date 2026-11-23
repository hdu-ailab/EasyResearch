import {
  type BundledFontFace,
  resolveBundledFamilyFace,
  resolveLastResortFace,
  resolveMetricCompatFace,
} from "@betteroffice/fonts";
import type { PresentationHandle } from "@betteroffice/pptx";
import type { OfficeFont } from "./office-protocol";

export function shippedOfficeFace(family: string, bold: boolean, italic: boolean): BundledFontFace {
  const shipped = (face: BundledFontFace | undefined) => (face && !face.script?.startsWith("cjk-") ? face : undefined);
  return (
    shipped(resolveMetricCompatFace(family, bold, italic)) ??
    shipped(resolveBundledFamilyFace(family, bold, italic)) ??
    shipped(resolveLastResortFace(family, bold, italic, "powerpoint")) ??
    resolveLastResortFace("", bold, italic, "powerpoint")
  );
}

export function createOfficeFonts(
  prefix: string,
  load: (face: BundledFontFace) => Promise<Uint8Array<ArrayBuffer>>,
  deck?: PresentationHandle,
) {
  const registered = new Map<string, string>();
  const sources = new Map<string, Uint8Array<ArrayBuffer>>();
  const pending: OfficeFont[] = [];
  let totalBytes = 0;
  const key = (family: string, bold: boolean, italic: boolean) => JSON.stringify([family, bold, italic]);
  return {
    async ensure(family: string, bold = false, italic = false) {
      const id = key(family, bold, italic);
      if (registered.has(id)) return;
      if (registered.size >= 64) return;
      const face = shippedOfficeFace(family, bold, italic);
      let bytes = sources.get(face.file);
      if (!bytes) {
        if (totalBytes + face.byteLength > 32 * 1024 * 1024) return;
        bytes = await load(face);
        if (bytes.byteLength !== face.byteLength) throw new Error("font");
        totalBytes += bytes.byteLength;
        sources.set(face.file, bytes);
      }
      const css = `${prefix}-${registered.size}`;
      deck?.registerFont({ family, bold, italic, bytes });
      registered.set(id, css);
      pending.push({ family: css, weight: bold ? "700" : "400", style: italic ? "italic" : "normal", bytes });
    },
    family(family: string, bold = false, italic = false) {
      return registered.get(key(family, bold, italic)) ?? registered.values().next().value ?? "sans-serif";
    },
    take() {
      // A withdrawn frame may never reach the painter. Every frame is self-contained.
      return pending;
    },
  };
}
