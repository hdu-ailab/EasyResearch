import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";

// A stored ZIP keeps the real DOCX decoder/render path in this smoke without another dependency.
function docxFixture(): Buffer {
  const files = {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>File split smoke document</w:t></w:r></w:p></w:body></w:document>',
  };
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, xml] of Object.entries(files)) {
    const name = Buffer.from(path);
    const data = Buffer.from(xml);
    const crc = Bun.hash.crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

// Optional origin exercises compiled assets; every API request remains intercepted.
const suppliedOrigin = process.argv[2];
const server = suppliedOrigin ? undefined : await preview({
  configFile: resolve(import.meta.dir, "../src/webui/vite.config.ts"),
  preview: { host: "127.0.0.1", port: 0, open: false, proxy: {} },
});
try {
  const address = server?.httpServer.address();
  assert(suppliedOrigin || (address && typeof address !== "string"));
  const origin = suppliedOrigin ? new URL(suppliedOrigin).origin : `http://127.0.0.1:${(address as { port: number }).port}`;
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const deadline = setTimeout(() => {
    console.error("FILE_TREE_RESIZE_SMOKE exceeded its browser deadline");
    void browser.close();
  }, 60_000);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    page.setDefaultTimeout(10_000);
    const unexpected: string[] = [];
    const errors: string[] = [];
    const session = { id: "file-split-smoke", cwd: "/p", status: "ready", isStreaming: false };
    const snapshot = {
      session, timeline: [], subagents: [], runtimeConfigurationGeneration: 0,
      compactionPolicy: { enabled: true, triggerPercent: 70 },
    };
    const docx = docxFixture();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/events")) {
        const event = url.pathname === "/api/config/events" ? undefined : { type: "snapshot", ...snapshot };
        return route.fulfill({
          contentType: "text/event-stream",
          body: `retry: 60000\n\n${event ? `data: ${JSON.stringify(event)}\n\n` : ""}`,
        });
      }
      if (url.pathname === "/api/file/raw" && url.searchParams.get("path") === "/p/draft.docx") {
        return route.fulfill({
          headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "Content-Length": String(docx.length),
          },
          body: docx,
        });
      }
      const fixtures: Record<string, unknown> = {
        "/api/status": { bootId: "file-split-smoke", agentDir: "/agent", homeDir: "/p", sessions: [], activeSessions: [] },
        "/api/update-check": { latestVersion: null },
        "/api/settings/api-usage": { showApiUsageDetails: true },
        "/api/agents": [],
        "/api/models": { models: [] },
        "/api/entries": { entries: [{ kind: "file", name: "draft.docx", path: "/p/draft.docx" }] },
        "/api/sessions/file-split-smoke/commands": { commands: [] },
        "/api/sessions/file-split-smoke/snapshot": snapshot,
        "/api/sessions/file-split-smoke/tree": { tree: [], leafId: null, treeFilterMode: "default", branchSummary: { skipPrompt: false } },
      };
      if (!(url.pathname in fixtures)) {
        unexpected.push(`${route.request().method()} ${url.pathname}`);
        return route.fulfill({ status: 500, json: { error: "Unexpected smoke request" } });
      }
      return route.fulfill({ json: fixtures[url.pathname] });
    });

    await page.goto(`${origin}/#/work/file-split-smoke?cwd=%2Fp`);
    const handle = page.getByRole("separator", { name: "Resize file tree" });
    const tree = page.locator("[data-files-tree]");
    await expect(handle).toBeVisible();
    const checkHitArea = async () => {
      const hits = await handle.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const y = rect.top + rect.height / 2;
        const hits: boolean[] = [];
        for (let x = rect.left + 0.5; x < rect.right; x++) hits.push(document.elementFromPoint(x, y) === element);
        return hits;
      });
      assert(hits.length >= 8 && hits.every(Boolean), "The complete separator hit area must be above both panes");
    };
    const width = () => tree.evaluate((element) => element.getBoundingClientRect().width);
    const boundsHold = () => handle.evaluate((element) => {
      const actual = element.previousElementSibling!.getBoundingClientRect().width;
      const max = Number(element.getAttribute("aria-valuemax"));
      const min = Number(element.getAttribute("aria-valuemin"));
      const previewWidth = element.nextElementSibling!.getBoundingClientRect().width;
      return actual >= min && actual <= max && actual === Number(element.getAttribute("aria-valuenow")) && previewWidth >= 240;
    });
    await checkHitArea();
    await tree.getByText("draft.docx", { exact: true }).click();
    const frame = page.locator('iframe[title="DOCX document"]');
    await expect(frame).toBeVisible();
    await checkHitArea();
    await handle.focus();
    await page.keyboard.press("Home");
    await expect.poll(boundsHold).toBe(true);

    await page.evaluate(() => document.body.style.setProperty("user-select", "text", "important"));
    const start = await handle.boundingBox();
    const iframe = await frame.boundingBox();
    assert(start && iframe);
    const y = iframe.y + iframe.height / 2;
    const startX = start.x + start.width / 2;
    const targetX = iframe.x + 80;
    const expectedWidth = Math.round(await width() + targetX - startX);
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(targetX, y);
    assert(await handle.evaluate((element) => element.hasPointerCapture(1)), "Crossing the DOCX iframe must not cancel the drag");
    await page.mouse.up();
    await expect.poll(width).toBe(expectedWidth);
    assert.deepEqual(await page.evaluate(() => [document.body.style.userSelect, document.body.style.getPropertyPriority("user-select")]), ["text", "important"]);
    const committed = await width();
    await page.mouse.move(start.x - 80, y);
    await expect.poll(width).toBe(committed);
    await expect.poll(boundsHold).toBe(true);

    await handle.focus();
    await page.keyboard.press("End");
    const preferred = await width();
    const next = await handle.boundingBox();
    assert(next);
    await page.mouse.move(next.x + next.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(next.x - 40, y);
    await expect.poll(width).toBeLessThan(preferred);
    await page.setViewportSize({ width: 1100, height: 900 });
    await expect.poll(boundsHold).toBe(true);
    assert(await handle.evaluate((element) => element.hasPointerCapture(1)), "Narrowing must keep the active pointer owned");
    const narrowedFrame = await frame.boundingBox();
    assert(narrowedFrame);
    await page.mouse.move(narrowedFrame.x + narrowedFrame.width / 2, y);
    assert(await handle.evaluate((element) => element.hasPointerCapture(1)), "The narrowed DOCX iframe must not cancel the drag");
    await expect.poll(boundsHold).toBe(true);
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.body.style.userSelect), "text");
    await page.mouse.up();

    const filter = page.getByRole("textbox", { name: "Filter files" });
    await filter.fill("draft");
    const toggle = page.getByRole("button", { name: "Toggle file tree" });
    await toggle.click();
    await expect(handle).toHaveCount(0);
    await toggle.click();
    await expect(filter).toHaveValue("draft");
    const beforeMobile = await handle.boundingBox();
    assert(beforeMobile);
    await page.mouse.move(beforeMobile.x + beforeMobile.width / 2, beforeMobile.y + 100);
    await page.mouse.down();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.body.style.userSelect)).toBe("text");
    await page.mouse.up();
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await expect(handle).toHaveCount(0);
    await expect(frame).toBeVisible();
    await toggle.click();
    await expect(filter).toHaveValue("draft");
    assert.equal(await tree.evaluate((element) => element.style.width), "");
    await page.setViewportSize({ width: 1440, height: 900 });
    // Work deliberately closes the desktop aside when entering its mobile layout.
    await page.getByRole("button", { name: "Files browser", exact: true }).click();
    await expect(handle).toBeVisible();
    await expect.poll(width).toBe(preferred);
    await checkHitArea();
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    console.log("FILE_TREE_RESIZE_SMOKE passed: full hit area, DOCX capture/release, live bounds, cancellation, mobile state retention");
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
} finally {
  if (server) await new Promise<void>((done, reject) => server.httpServer.close((error) => error ? reject(error) : done()));
}
