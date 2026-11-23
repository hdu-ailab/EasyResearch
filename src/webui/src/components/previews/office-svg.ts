import { Parser } from "htmlparser2";
import { officeRasterInfo } from "./office-images";

// SVG stays an image: rebuild a bounded static SVG in the file Worker, then the
// window decodes its Blob in <img> image mode. No document markup enters app DOM.
const MAX_SVG_BYTES = 2 * 1024 * 1024;
const tags = new Set([
  "svg",
  "g",
  "defs",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textPath",
  "title",
  "desc",
  "style",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "pattern",
  "marker",
  "symbol",
  "use",
  "image",
]);
const attributes = new Set([
  "id",
  "class",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "d",
  "points",
  "transform",
  "viewBox",
  "preserveAspectRatio",
  "pathLength",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "offset",
  "fx",
  "fy",
  "fr",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "patternUnits",
  "patternContentUnits",
  "patternTransform",
  "markerWidth",
  "markerHeight",
  "markerUnits",
  "orient",
  "refX",
  "refY",
  "dx",
  "dy",
  "rotate",
  "textLength",
  "lengthAdjust",
  "startOffset",
  "method",
  "spacing",
]);
const properties = new Set([
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "opacity",
  "color",
  "stop-color",
  "stop-opacity",
  "clip-path",
  "clip-rule",
  "mask",
  "paint-order",
  "vector-effect",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "text-anchor",
  "text-decoration",
  "dominant-baseline",
  "alignment-baseline",
  "baseline-shift",
  "letter-spacing",
  "word-spacing",
  "white-space",
  "display",
  "visibility",
  "shape-rendering",
  "text-rendering",
]);
const localReference = /^#[\w.-]{1,128}$/;
const functions = new Set([
  "url",
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
  "color-mix",
  "calc",
  "min",
  "max",
  "clamp",
  "matrix",
  "translate",
  "translatex",
  "translatey",
  "scale",
  "scalex",
  "scaley",
  "rotate",
  "skewx",
  "skewy",
]);
const escapeXml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function safeValue(value: string): boolean {
  // No CSS escapes, comments, at-rules or schemes. URL-bearing paints may only
  // reference a local definition in this same image.
  if (/[\\@<>:{}]/.test(value) || value.includes("/*") || /expression\s*\(/i.test(value)) return false;
  if ([...value.matchAll(/([a-zA-Z_-][\w-]*)\s*\(/g)].some((match) => !functions.has((match[1] ?? "").toLowerCase())))
    return false;
  const stripped = value.replace(/url\(\s*(['"]?)(#[\w.-]{1,128})\1\s*\)/gi, "");
  return !/url\s*\(/i.test(stripped);
}
function declarations(css: string): string {
  return css
    .split(";")
    .flatMap((entry) => {
      const split = entry.indexOf(":");
      const property = entry.slice(0, split).trim().toLowerCase();
      const value = entry.slice(split + 1).trim();
      return split > 0 && properties.has(property) && safeValue(value) ? [`${property}:${value}`] : [];
    })
    .join(";");
}
function stylesheet(css: string): string {
  if (/[@\\]/.test(css) || css.includes("/*")) return "";
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .flatMap(([, selector = "", body = ""]) => {
      if (!/^[\w.#*,\s>+~-]+$/.test(selector)) return [];
      return [`${selector}{${declarations(body)}}`];
    })
    .join("");
}
function lengthPixels(value: string | undefined): number | undefined {
  const match = value?.trim().match(/^([+\d.eE-]+)(px|pt|pc|in|cm|mm|q)?$/i);
  if (!match) return;
  const factor: Record<string, number> = {
    px: 1,
    pt: 96 / 72,
    pc: 16,
    in: 96,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
    q: 96 / 101.6,
  };
  const number = Number(match[1]) * (factor[(match[2] ?? "px").toLowerCase()] ?? 1);
  return Number.isFinite(number) && number > 0 && number <= 1e7 ? number : undefined;
}

export interface OfficeSvgImage {
  bytes: Uint8Array<ArrayBuffer>;
  mime: "image/svg+xml";
  width: number;
  height: number;
}

/** Worker-only parsing. Unsupported active elements/styles are removed, never interpreted. */
export function sanitizeOfficeSvg(bytes: Uint8Array): OfficeSvgImage | undefined {
  if (bytes.byteLength > MAX_SVG_BYTES) return;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) return;
    const output: string[] = [];
    const stack: { name: string; allowed: boolean; css: string }[] = [];
    let root = false;
    let nodes = 0;
    let references = 0;
    let rasterPixels = 0;
    let width = 0;
    let height = 0;
    const parser = new Parser(
      {
        onopentag(qualified, attrs) {
          if (++nodes > 4096 || stack.length >= 32) throw new Error("SVG limit");
          const name = qualified.split(":").at(-1) ?? "";
          const isRoot = stack.length === 0;
          if (isRoot && (root || name !== "svg")) throw new Error("SVG root");
          const allowed = tags.has(name) && (isRoot || stack.at(-1)?.allowed === true);
          stack.push({ name, allowed, css: "" });
          if (!allowed) return;
          const accepted: Record<string, string> = {};
          for (const [key, value] of Object.entries(attrs)) {
            if (key === "style") {
              accepted.style = declarations(value);
              continue;
            }
            if (key === "href" || key === "xlink:href") {
              if (++references > 256) throw new Error("SVG references");
              if (localReference.test(value) && name !== "image") accepted.href = value;
              else if (name === "image") {
                const match = value.match(/^data:image\/(png|jpeg|gif|webp);base64,([a-zA-Z0-9+/=\s]+)$/);
                if (match?.[2]) {
                  const raster = Uint8Array.from(atob(match[2].replace(/\s/g, "")), (character) =>
                    character.charCodeAt(0),
                  );
                  const info = officeRasterInfo(raster);
                  if (info?.mime === `image/${match[1]}` && rasterPixels + info.width * info.height <= 16_000_000) {
                    rasterPixels += info.width * info.height;
                    accepted.href = value;
                  }
                }
              }
              continue;
            }
            if ((attributes.has(key) || properties.has(key)) && safeValue(value)) accepted[key] = value;
          }
          if (isRoot) {
            root = true;
            const box = attrs.viewBox
              ?.trim()
              .split(/[\s,]+/)
              .map(Number);
            const validBox =
              box?.length === 4 &&
              box.every((part) => Number.isFinite(part) && Math.abs(part) <= 1e9) &&
              (box[2] ?? 0) > 0 &&
              (box[3] ?? 0) > 0;
            const naturalWidth = lengthPixels(attrs.width) ?? (validBox ? box?.[2] : undefined) ?? 300;
            const naturalHeight = lengthPixels(attrs.height) ?? (validBox ? box?.[3] : undefined) ?? 150;
            const scale = Math.min(
              1,
              2048 / naturalWidth,
              2048 / naturalHeight,
              Math.sqrt(4_000_000 / (naturalWidth * naturalHeight)),
            );
            width = Math.max(1, Math.floor(naturalWidth * scale));
            height = Math.max(1, Math.floor(naturalHeight * scale));
            accepted.width = String(width);
            accepted.height = String(height);
            accepted.viewBox = validBox ? (box?.join(" ") ?? "") : `0 0 ${naturalWidth} ${naturalHeight}`;
            accepted.xmlns = "http://www.w3.org/2000/svg";
          }
          output.push(
            `<${name}${Object.entries(accepted)
              .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
              .join("")}>`,
          );
        },
        ontext(text) {
          const current = stack.at(-1);
          if (!current?.allowed) return;
          if (current.name === "style") current.css += text;
          else output.push(escapeXml(text));
        },
        onclosetag() {
          const current = stack.pop();
          if (!current?.allowed) return;
          if (current.name === "style") output.push(escapeXml(stylesheet(current.css)));
          output.push(`</${current.name}>`);
        },
      },
      { xmlMode: true, decodeEntities: true },
    );
    parser.end(source);
    const sanitized = new TextEncoder().encode(output.join(""));
    if (!root || !width || !height || sanitized.byteLength > MAX_SVG_BYTES) return;
    return { bytes: sanitized, mime: "image/svg+xml", width, height };
  } catch {
    return undefined;
  }
}
