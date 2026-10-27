import type { BrowserWindow, DownloadItem, Session, WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { basename, join } from "node:path";
import { DESKTOP_ACCESS_HEADER } from "./contracts";
import { workFilesMp4 } from "../../scripts/work-files-media-fixture";
import { verifyDesktopSmokeVideo } from "./smoke-video";

type DownloadSession = Pick<Session, "on" | "removeListener">;
type DownloadListener = (event: Electron.Event, item: DownloadItem, contents: WebContents) => void;

/** Smoke-only ownership of one native download. No application download handler is installed. */
export function verifyDesktopSmokeDownload(options: {
  session: DownloadSession;
  webContents: object;
  url: string;
  savePath: string;
  filename: string;
  expected: Uint8Array;
  cancel?: boolean;
  trigger: () => Promise<unknown>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = positiveTimeout(options.timeoutMs ?? 10_000);
  return new Promise<void>((resolve, reject) => {
    let item: DownloadItem | undefined;
    let terminal = false;
    let triggered = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      if (!error && (!terminal || !triggered)) return;
      settled = true;
      clearTimeout(timer);
      options.session.removeListener("will-download", onDownload);
      item?.removeListener("done", onDone);
      if (error && item && !terminal) {
        try { item.cancel(); } catch { /* The item may have been destroyed with its renderer. */ }
      }
      if (error) reject(error);
      else resolve();
    };
    const onDone = (_event: Electron.Event, state: string) => {
      terminal = true;
      try {
        if (state !== (options.cancel ? "cancelled" : "completed")) {
          throw new Error("Desktop Work Files download did not reach its expected terminal state.");
        }
        if (!options.cancel && (
          item!.getReceivedBytes() !== options.expected.byteLength
          || !readFileSync(options.savePath).equals(Buffer.from(options.expected))
        )) throw new Error("Desktop Work Files native download bytes did not match the uploaded file.");
        finish();
      } catch {
        finish(new Error("Desktop Work Files native download terminal state or bytes were invalid."));
      }
    };
    const onDownload: DownloadListener = (event, next, contents) => {
      if (contents !== options.webContents) return;
      try {
        // Electron 42 has exactly three will-download arguments. Match the owned
        // WebContents and exact URL; do not depend on newer initiator/frame APIs.
        if (item || next.getURL() !== options.url) {
          event.preventDefault();
          finish(new Error("Desktop Work Files received an unexpected renderer download."));
          return;
        }
        item = next;
        item.on("done", onDone);
        if (item.getFilename() !== options.filename || !/^attachment(?:;|$)/iu.test(item.getContentDisposition())) {
          throw new Error("Invalid attachment metadata");
        }
        item.setSavePath(options.savePath);
        if (options.cancel) item.cancel();
      } catch {
        if (!item) event.preventDefault();
        finish(new Error("Desktop Work Files native download metadata or save setup failed."));
      }
    };
    const timer = setTimeout(() => finish(new Error("Desktop Work Files native download deadline expired.")), timeoutMs);
    options.session.on("will-download", onDownload);
    Promise.resolve().then(options.trigger).then(() => {
      triggered = true;
      finish();
    }, () => finish(new Error("Desktop Work Files parent download trigger failed.")));
  });
}

/** Observe an actual attempted sandbox download, including a bounded quiet window after its acknowledgement. */
export function verifyDesktopSmokeBlockedDownload<T>(options: {
  session: DownloadSession;
  webContents: object;
  trigger: () => Promise<T>;
  timeoutMs?: number;
  observationMs?: number;
}): Promise<T> {
  const timeoutMs = positiveTimeout(options.timeoutMs ?? 20_000);
  const observationMs = positiveTimeout(options.observationMs ?? 400);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { value: T } | { error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(quietTimer);
      options.session.removeListener("will-download", onDownload);
      if ("error" in result) reject(result.error);
      else resolve(result.value);
    };
    const onDownload: DownloadListener = (event, _item, contents) => {
      if (contents !== options.webContents) return;
      // Prevent a native dialog on failure, but fail the smoke: this intervention
      // is not evidence that Chromium's sandbox blocked the attempted download.
      event.preventDefault();
      finish({ error: new Error("Desktop Work Files sandbox allowed an iframe download.") });
    };
    const timer = setTimeout(() => finish({ error: new Error("Desktop Work Files iframe deadline expired.") }), timeoutMs);
    options.session.on("will-download", onDownload);
    Promise.resolve().then(options.trigger).then((value) => {
      if (!settled) quietTimer = setTimeout(() => finish({ value }), observationMs);
    }, () => finish({ error: new Error("Desktop Work Files interactive iframe verification failed.") }));
  });
}

interface PreviewScope { id: string; url: string }

/** Runs only from main.ts's existing packaged-smoke branch, against the real installed WebContents. */
export async function verifyDesktopSmokeWorkFiles(options: {
  window: Pick<BrowserWindow, "on" | "removeListener" | "isFullScreen">;
  webContents: Pick<WebContents, "executeJavaScript" | "session">;
  origin: string;
  rendererToken: string;
  project: string;
  directory: string;
}): Promise<Record<string, unknown>> {
  const { webContents, origin, rendererToken } = options;
  const fixture = mkdtempSync(join(options.project, "desktop-work-files-"));
  const downloads = mkdtempSync(join(options.directory, "work-files-downloads-"));
  const marker = randomUUID();
  const bytes = [0, 255, 128, 10, 13, 42, 0, 226, 152, 131];
  const uploadedPath = join(fixture, "uploaded.bin");
  const renamedPath = join(fixture, "结果-β.bin");
  const deniedPath = join(fixture, "iframe-mutation.bin");
  const htmlPath = join(fixture, "report.html");
  const opaqueAuthenticated = new Set<string>();
  let scope: PreviewScope | undefined;
  let failure: unknown;
  try {
    writeFixture(fixture, marker, options.project, deniedPath, renamedPath);
    // onSendHeaders is observation only; onBeforeSendHeaders remains the normal
    // destination-bound host injector. Never serialize headers/tokens to the page.
    webContents.session.webRequest.onSendHeaders({ urls: [`${origin}/api/file/preview/*`] }, (details) => {
      const headers = new Headers(details.requestHeaders);
      if (headers.get("origin") === "null" && headers.get(DESKTOP_ACCESS_HEADER) === rendererToken) {
        opaqueAuthenticated.add(new URL(details.url).pathname);
      }
    });
    scope = await verifyDesktopSmokeBlockedDownload({
      session: webContents.session,
      webContents,
      trigger: () => webContents.executeJavaScript(
        `(${prepareRenderer.toString()})(${JSON.stringify({
          marker, project: options.project, directory: fixture, htmlPath,
          uploadedPath, renamedPath, bytes,
        })})`, true,
      ) as Promise<PreviewScope>,
    });
    if (!scope || typeof scope.id !== "string" || !scope.url.startsWith(`/api/file/preview/${scope.id}/`)) {
      throw new Error("Desktop Work Files renderer returned an invalid preview scope.");
    }
    for (const name of ["module.js", "import.js", "data.json"]) {
      if (!opaqueAuthenticated.has(`/api/file/preview/${scope.id}/assets/${name}`)) {
        throw new Error("Desktop Work Files did not observe authenticated opaque-origin module/fetch requests.");
      }
    }
    if (existsSync(uploadedPath) || existsSync(deniedPath) || !readFileSync(renamedPath).equals(Buffer.from(bytes))) {
      throw new Error("Desktop Work Files renderer mutations or iframe API isolation failed.");
    }
    await verifyDesktopSmokeAdmissionNegatives(origin, rendererToken, scope, htmlPath);
    const copied = await deadline(webContents.executeJavaScript(
      "navigator.clipboard.writeText('EasyResearch desktop smoke').then(() => true)", true,
    ), 3_000, "main-document Copy");
    if (copied !== true) throw new Error("Desktop Work Files main-document Copy failed.");
    await verifyDesktopSmokeVideo({
      window: options.window,
      webContents,
      url: `${origin}/api/file/raw?${new URLSearchParams({ path: join(fixture, "clip.mp4") })}`,
      id: `desktop-smoke-video-${marker}`,
    });

    const url = `${origin}/api/file/raw?${new URLSearchParams({ path: renamedPath, download: "1" })}`;
    for (const cancel of [false, true]) {
      await verifyDesktopSmokeDownload({
        session: webContents.session,
        webContents,
        url,
        filename: basename(renamedPath),
        savePath: join(downloads, cancel ? "cancelled.bin" : "completed.bin"),
        expected: Uint8Array.from(bytes),
        cancel,
        // Ordinary trusted-parent anchor, with a user gesture. No host downloadURL
        // or credential header bypasses Chromium's real request/download pipeline.
        trigger: () => webContents.executeJavaScript(`(() => {
          const link = document.createElement('a');
          link.href = ${JSON.stringify(url)};
          link.download = '';
          document.body.append(link);
          try { link.click(); } finally { link.remove(); }
        })()`, true),
      });
    }
  } catch (error) {
    failure = error;
  } finally {
    webContents.session.webRequest.onSendHeaders(null);
    if (scope) {
      try {
        await deadline(webContents.executeJavaScript(`(async () => {
          const signal = AbortSignal.timeout(3000);
          const released = await fetch(${JSON.stringify(`/api/file/preview/${scope.id}`)}, {method:'DELETE', signal});
          if (released.status !== 204) throw new Error('Preview release failed');
          const obsolete = await fetch(${JSON.stringify(scope.url)}, {signal});
          if (obsolete.ok || obsolete.headers.has('access-control-allow-origin')) throw new Error('Released preview remained accessible');
          await obsolete.arrayBuffer();
        })()`), 4_000, "preview release");
      } catch {
        failure ??= new Error("Desktop Work Files preview scope cleanup failed.");
      }
    }
    // The package harness preserves its isolated root on failure for diagnostics.
    // Successful runs remove only the two directories this helper allocated.
    if (!failure) {
      rmSync(fixture, { recursive: true });
      rmSync(downloads, { recursive: true });
    }
  }
  if (failure) throw failure;
  return {
    type: "desktop-smoke.work-files-verified",
    opaqueAuthenticatedResources: true,
    isolatedHtml: true,
    downloadBytesVerified: true,
    downloadCancelled: true,
    sandboxDownloadBlocked: true,
    videoFullscreenVerified: true,
    clipboardWriteVerified: true,
    scopeReleased: true,
  };
}

/** Smoke-only HTTP probe, also exercised against the real server by the wire regression test. */
export async function verifyDesktopSmokeAdmissionNegatives(origin: string, token: string, scope: PreviewScope, htmlPath: string): Promise<void> {
  const authenticated = { [DESKTOP_ACCESS_HEADER]: token, Origin: "null" };
  const negatives = [
    // Outer admission denies unauthenticated opaque Origins before route auth;
    // omitting Origin separately reaches the renderer-credential rejection.
    { path: scope.url, headers: { Origin: "null" }, status: 403 },
    { path: scope.url, headers: {}, status: 401 },
    { path: scope.url, headers: { ...authenticated, Host: `wrong.invalid:${new URL(origin).port}` }, status: 403 },
    { path: "/api/status", headers: authenticated, status: 403 },
    { path: "/api/file/preview", method: "POST", headers: { ...authenticated, "Content-Type": "application/json" }, body: JSON.stringify({ path: htmlPath }), status: 403 },
    { path: `/api/file/preview/${scope.id}`, method: "DELETE", headers: authenticated, status: 403 },
    { path: scope.url, headers: { ...authenticated, Origin: "https://wrong.invalid" }, status: 403 },
  ];
  for (const negative of negatives) {
    await new Promise<void>((resolve, reject) => {
      // Node HTTP, not Electron's authenticated Session; Host is sent literally.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      const req = httpRequest(`${origin}${negative.path}`, {
        method: negative.method ?? "GET", headers: negative.headers, signal: controller.signal,
      }, (response) => {
        const valid = response.statusCode === negative.status
          && response.headers["access-control-allow-origin"] === undefined;
        response.resume();
        response.on("end", () => {
          clearTimeout(timer);
          if (valid) resolve();
          else reject(new Error("Desktop Work Files negative auth/Host/Origin admission failed."));
        });
        response.on("error", failed);
      });
      function failed() {
        clearTimeout(timer);
        reject(new Error("Desktop Work Files negative admission request failed or timed out."));
      }
      req.on("error", failed);
      req.end(negative.body);
    });
  }
}

function writeFixture(directory: string, marker: string, cwd: string, deniedPath: string, sourcePath: string): void {
  writeFileSync(join(directory, "clip.mp4"), workFilesMp4());
  mkdirSync(join(directory, "assets"));
  writeFileSync(join(directory, "assets", "style.css"), '@import "./import.css"; #plot { background-image: url("./image.svg"); }');
  writeFileSync(join(directory, "assets", "import.css"), "#plot { color: rgb(17, 34, 51); }");
  writeFileSync(join(directory, "assets", "image.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="7"><rect width="12" height="7" fill="blue"/></svg>');
  writeFileSync(join(directory, "assets", "data.json"), JSON.stringify({ marker }));
  writeFileSync(join(directory, "assets", "classic.js"), "globalThis.smokeClassic = true;");
  writeFileSync(join(directory, "assets", "import.js"), `export const marker = ${JSON.stringify(marker)};`);
  writeFileSync(join(directory, "assets", "module.js"), 'import {marker} from "./import.js"; globalThis.smokeModule = marker;');
  const upload = `/api/file/upload?${new URLSearchParams({ cwd, directory, name: basename(deniedPath) })}`;
  writeFileSync(join(directory, "report.html"), `<!doctype html><html><head>
    <link rel="stylesheet" href="./assets/style.css">
    <script src="./assets/classic.js"></script><script type="module" src="./assets/module.js"></script>
    </head><body><button id="plot">0</button><img id="image" src="./assets/image.svg">
    <script>
    const marker = ${JSON.stringify(marker)};
    let clicks = 0;
    const plot = document.getElementById('plot');
    plot.addEventListener('click', () => { plot.textContent = String(++clicks); });
    const blocked = (read) => { try { read(); return false; } catch { return true; } };
    window.addEventListener('load', async () => {
      try {
        const response = await fetch('./assets/data.json');
        const data = await response.json();
        let apiBlocked = false;
        try { await fetch(${JSON.stringify(upload)}, {method:'PUT', headers:{'Content-Type':'application/octet-stream'}, body:'forbidden'}); }
        catch { apiBlocked = true; }
        let renameBlocked = false;
        try { await fetch('/api/file/rename', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(${JSON.stringify({ cwd, path: sourcePath, name: basename(deniedPath) })})}); }
        catch { renameBlocked = true; }
        plot.click();
        parent.postMessage({marker, kind:'ready', checks: {
          inline: clicks === 1 && plot.textContent === '1', classic: globalThis.smokeClassic === true,
          module: globalThis.smokeModule === marker, localFetch: response.ok && data.marker === marker,
          css: getComputedStyle(plot).color === 'rgb(17, 34, 51)', image: document.getElementById('image').naturalWidth === 12,
          parentDom: blocked(() => parent.document.body), parentStorage: blocked(() => parent.localStorage.length),
          storage: blocked(() => localStorage.length), preload: typeof window.easyresearchDesktop === 'undefined',
          node: typeof require === 'undefined' && typeof process === 'undefined', apiBlocked, renameBlocked
        }}, '*');
      } catch { parent.postMessage({marker, kind:'error'}, '*'); }
    });
    window.addEventListener('message', (event) => {
      if (event.source !== parent || event.data?.marker !== marker) return;
      if (event.data.kind === 'fullscreen') {
        (async () => {
          let rejected = false;
          try { await plot.requestFullscreen(); } catch { rejected = true; }
          parent.postMessage({marker, kind:'fullscreen-result',
            denied: rejected && document.fullscreenEnabled === false && document.fullscreenElement === null}, '*');
        })();
      }
      if (event.data.kind === 'download') {
        const url = URL.createObjectURL(new Blob(['sandbox download must be blocked']));
        const link = document.createElement('a'); link.href = url; link.download = 'blocked.bin';
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        parent.postMessage({marker, kind:'download-attempted'}, '*');
      }
      if (event.data.kind === 'navigate') location.href = '/api/status';
    });
    </script></body></html>`);
}

/** Self-contained browser code: serialized after bundling; no host closure or token is available here. */
async function prepareRenderer(input: {
  marker: string; project: string; directory: string; htmlPath: string;
  uploadedPath: string; renamedPath: string; bytes: number[];
}): Promise<PreviewScope> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let scope: PreviewScope | undefined;
  let success = false;
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.style.cssText = "position:fixed;inset:20px;width:480px;height:240px;z-index:99999;background:white";
  const request = async (path: string, init: RequestInit = {}) => {
    return fetch(path, { ...init, signal: controller.signal });
  };
  const fromFrame = (kind: string): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("message", receive);
      controller.signal.removeEventListener("abort", abort);
    };
    const abort = () => { cleanup(); reject(new Error("Iframe response deadline expired")); };
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.marker !== input.marker) return;
      if (event.data.kind !== kind && event.data.kind !== "error") return;
      cleanup();
      if (event.origin !== "null" || event.data.kind === "error") reject(new Error("Invalid opaque iframe response"));
      else resolve(event.data as Record<string, unknown>);
    };
    window.addEventListener("message", receive);
    controller.signal.addEventListener("abort", abort, { once: true });
    if (controller.signal.aborted) abort();
  });
  try {
    const uploadUrl = `/api/file/upload?${new URLSearchParams({ cwd: input.project, directory: input.directory, name: "uploaded.bin" })}`;
    const upload = await request(uploadUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: Uint8Array.from(input.bytes) });
    const uploaded = await upload.json();
    if (upload.status !== 201 || uploaded.entry?.path !== input.uploadedPath) throw new Error("Renderer upload failed");
    const duplicate = await request(uploadUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: "conflict" });
    await duplicate.arrayBuffer();
    if (duplicate.status !== 409) throw new Error("Renderer upload clobbered an existing file");
    const rename = await request("/api/file/rename", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: input.project, path: input.uploadedPath, name: "结果-β.bin" }),
    });
    const renamed = await rename.json();
    if (rename.status !== 200 || renamed.oldPath !== input.uploadedPath || renamed.entry?.path !== input.renamedPath) throw new Error("Renderer rename failed");
    const created = await request("/api/file/preview", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: input.htmlPath }),
    });
    const value = await created.json();
    if (!created.ok || typeof value.id !== "string" || typeof value.url !== "string" || !value.url.startsWith(`/api/file/preview/${value.id}/`)) throw new Error("Renderer preview creation failed");
    scope = value;
    const head = await request(value.url, { method: "HEAD" });
    if (!head.ok || head.headers.get("access-control-allow-origin") !== "*" || head.headers.has("access-control-allow-credentials")) throw new Error("Scoped read CORS failed");

    const ready = fromFrame("ready");
    frame.src = value.url;
    document.body.append(frame);
    const result = await ready;
    const checks = result.checks as Record<string, unknown> | undefined;
    for (const key of ["inline", "classic", "module", "localFetch", "css", "image", "parentDom", "parentStorage", "storage", "preload", "node", "apiBlocked", "renameBlocked"]) {
      if (checks?.[key] !== true) throw new Error(`HTML fixture failed: ${key}`);
    }
    if (frame.contentDocument !== null) throw new Error("Preview acquired application origin");
    const fullscreen = fromFrame("fullscreen-result");
    frame.contentWindow!.postMessage({ marker: input.marker, kind: "fullscreen" }, "*");
    if ((await fullscreen).denied !== true || document.fullscreenElement !== null) {
      throw new Error("Preview acquired fullscreen delegation");
    }
    const downloadAttempted = fromFrame("download-attempted");
    frame.contentWindow!.postMessage({ marker: input.marker, kind: "download" }, "*");
    await downloadAttempted;
    // Keep the real report alive after its blob-anchor click; the host additionally
    // observes a quiet window after this renderer scenario completes.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        document.removeEventListener("securitypolicyviolation", violation);
        controller.signal.removeEventListener("abort", abort);
      };
      const abort = () => { cleanup(); reject(new Error("Parent frame policy was not enforced")); };
      const violation = (event: SecurityPolicyViolationEvent) => {
        if (event.effectiveDirective !== "frame-src" || !event.blockedURI.startsWith(location.origin)) return;
        cleanup(); resolve();
      };
      document.addEventListener("securitypolicyviolation", violation);
      controller.signal.addEventListener("abort", abort, { once: true });
      frame.contentWindow!.postMessage({ marker: input.marker, kind: "navigate" }, "*");
      if (controller.signal.aborted) abort();
    });
    success = true;
    return scope!;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    frame.remove();
    if (scope && !success) {
      const response = await fetch(`/api/file/preview/${scope.id}`, { method: "DELETE", signal: AbortSignal.timeout(3000) });
      if (response.status !== 204) throw new Error("Failed preview cleanup");
    }
  }
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Desktop Work Files timeout must be a positive integer.");
  return value;
}

async function deadline<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Desktop Work Files ${label} deadline expired.`)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
