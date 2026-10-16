#!/usr/bin/env bun
/** Regenerate checked-in packaging artwork from the shared dolphin favicon.
 * Development only: COMPARE_CHROMIUM_PATH=/path/to/chrome bun scripts/generate-desktop-icons.ts
 * Release builds consume the generated resources and do not need a browser.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "src", "desktop", "assets");
const svg = readFileSync(join(root, "src", "webui", "public", "favicon.svg"), "utf8");
const browser = await chromium.launch({
  ...(process.env.COMPARE_CHROMIUM_PATH
    ? { executablePath: process.env.COMPARE_CHROMIUM_PATH }
    : { channel: "chrome" }),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`,
  );
  const images = new Map<number, Buffer>();
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    await page.setViewportSize({ width: size, height: size });
    images.set(size, await page.screenshot({ omitBackground: true }));
  }
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "icon.png"), images.get(1024)!);
  writeFileSync(join(output, "tray.png"), images.get(16)!);
  writeFileSync(join(output, "tray@2x.png"), images.get(32)!);

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const image = images.get(size)!;
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  writeFileSync(join(output, "icon.ico"), Buffer.concat([header, ...sizes.map((size) => images.get(size)!)]));

  const chunks = (
    [
      [16, "icp4"],
      [32, "icp5"],
      [64, "icp6"],
      [128, "ic07"],
      [256, "ic08"],
      [512, "ic09"],
      [1024, "ic10"],
    ] as const
  ).map(([size, type]) => {
    const image = images.get(size)!;
    const header = Buffer.alloc(8);
    header.write(type);
    header.writeUInt32BE(image.length + 8, 4);
    return Buffer.concat([header, image]);
  });
  const icns = Buffer.alloc(8);
  icns.write("icns");
  icns.writeUInt32BE(8 + chunks.reduce((size, chunk) => size + chunk.length, 0), 4);
  writeFileSync(join(output, "icon.icns"), Buffer.concat([icns, ...chunks]));
  console.log(`Desktop dolphin artwork generated in ${output}`);
} finally {
  await browser.close();
}
