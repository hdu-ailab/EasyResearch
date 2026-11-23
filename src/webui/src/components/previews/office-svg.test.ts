import { describe, expect, it } from "vitest";
import { sanitizeOfficeSvg } from "./office-svg";

const encode = (value: string) => new TextEncoder().encode(value);
const safe = (body: string, attrs = 'width="320" height="180"') =>
  sanitizeOfficeSvg(encode(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`));
const content = (value: ReturnType<typeof safe>) => new TextDecoder().decode(value?.bytes);

describe("Worker-side Office SVG preparation", () => {
  it("preserves static shapes, text, local gradients and ordinary class styles", () => {
    const result = safe(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#3155d9"/></linearGradient><style>.title{fill:white;font-size:20px}</style></defs><rect width="320" height="180" fill="url(#g)"/><text class="title" x="20" y="80">SVG_PREVIEW_SENTINEL</text>',
    );
    expect(result).toMatchObject({ mime: "image/svg+xml", width: 320, height: 180 });
    const parsed = new DOMParser().parseFromString(content(result), "image/svg+xml");
    expect(parsed.querySelector("parsererror")).toBeNull();
    expect(parsed.querySelector("rect")?.getAttribute("fill")).toBe("url(#g)");
    expect(parsed.querySelector("style")?.textContent).toContain(".title{fill:white;font-size:20px}");
    expect(parsed.querySelector("text")?.textContent).toBe("SVG_PREVIEW_SENTINEL");
  });
  it("removes active markup and every external-resource input while retaining harmless drawing", () => {
    const result = safe(
      '<script>globalThis.pwned=1</script><foreignObject><iframe src="https://leak.invalid/frame"/></foreignObject><image href="https://leak.invalid/image"/><use href="//leak.invalid/use#x"/><rect onload="pwned=1" fill="url(https://leak.invalid/paint)" style="stroke:red;fill:url(&quot;https://leak.invalid/style&quot;);behavior:url(x)"/><style>@import "https://leak.invalid/css";.a{fill:red}</style><animate attributeName="href" to="https://leak.invalid/animate"/>',
    );
    const parsed = new DOMParser().parseFromString(content(result), "image/svg+xml");
    expect(parsed.querySelector("parsererror")).toBeNull();
    expect(parsed.querySelector("script, foreignObject, iframe, animate")).toBeNull();
    expect(content(result)).not.toMatch(/leak\.invalid|pwned|onload|behavior|@import/);
    expect(parsed.querySelector("rect")?.getAttribute("style")).toBe("stroke:red");
  });
  it("rejects entity/DTD inputs and removes escaped CSS URLs and processing instructions", () => {
    expect(
      sanitizeOfficeSvg(encode('<!DOCTYPE svg [<!ENTITY ext SYSTEM "https://leak.invalid/">]><svg/>')),
    ).toBeUndefined();
    const result = sanitizeOfficeSvg(
      encode(
        '<?xml-stylesheet href="https://leak.invalid/css"?><svg width="1" height="1"><rect style="fill:u\\72l(https://leak.invalid/a)" fill="uRL(\'//leak.invalid/b\')"/></svg>',
      ),
    );
    expect(content(result)).not.toContain("leak.invalid");
    expect(content(safe("<rect style=\"mask:image-set('relative-secret.png' 1x)\"/>"))).not.toContain(
      "relative-secret",
    );
  });
  it("bounds raster dimensions while preserving the original vector coordinate system", () => {
    const result = safe('<rect width="12000" height="9000"/>', 'width="12000" height="9000" viewBox="0 0 12000 9000"');
    expect(result).toBeDefined();
    expect((result?.width ?? 0) * (result?.height ?? 0)).toBeLessThanOrEqual(4_000_000);
    expect(content(result)).toContain('viewBox="0 0 12000 9000"');
    expect(result?.width).toBeLessThanOrEqual(2048);
    const sizedByBox = safe('<path d="M0 0L10 10"/>', 'viewBox="0 0 640 480"');
    expect(sizedByBox).toMatchObject({ width: 640, height: 480 });
  });
  it("bounds SVG input, depth and node count", () => {
    expect(sanitizeOfficeSvg(new Uint8Array(2 * 1024 * 1024 + 1))).toBeUndefined();
    expect(safe(`${"<g>".repeat(40)}<rect/>${"</g>".repeat(40)}`)).toBeUndefined();
    expect(safe("<rect/>".repeat(4097))).toBeUndefined();
  });
  it("permits only bounded raster data images, never nested SVG or markup data", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1EAAAAASUVORK5CYII=";
    const result = safe(
      `<image href="data:image/png;base64,${png}"/><image href="data:image/svg+xml;base64,PHN2Zy8+"/><image href="data:text/html;base64,PHNjcmlwdC8+"/>`,
    );
    const parsed = new DOMParser().parseFromString(content(result), "image/svg+xml");
    const images = parsed.querySelectorAll("image");
    expect(images[0]?.getAttribute("href")).toBe(`data:image/png;base64,${png}`);
    expect(images[1]?.hasAttribute("href")).toBe(false);
    expect(images[2]?.hasAttribute("href")).toBe(false);
  });
});
