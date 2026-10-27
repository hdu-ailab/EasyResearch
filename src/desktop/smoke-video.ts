import type { BrowserWindow, WebContents } from "electron";

type FullscreenWindow = Pick<BrowserWindow, "on" | "removeListener" | "isFullScreen">;

/** Register before the renderer request: macOS's native transition finishes asynchronously. */
export function waitForDesktopSmokeFullscreen(options: {
  window: FullscreenWindow;
  fullscreen: boolean;
  requireNativeEvent: boolean;
  trigger: () => Promise<unknown>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Desktop video fullscreen timeout must be a positive integer.");
  }
  return new Promise<void>((resolve, reject) => {
    let nativeEvent = false;
    let rendererDone = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      if (!error) {
        if (!rendererDone || (options.requireNativeEvent && !nativeEvent)) return;
        try { if (options.window.isFullScreen() !== options.fullscreen) return; }
        catch { error = new Error("Desktop video fullscreen window became unavailable."); }
      }
      settled = true;
      clearTimeout(timer);
      if (options.fullscreen) options.window.removeListener("enter-full-screen", onTransition);
      else options.window.removeListener("leave-full-screen", onTransition);
      if (error) reject(error);
      else resolve();
    };
    const onTransition = () => { nativeEvent = true; finish(); };
    const timer = setTimeout(() => finish(new Error("Desktop video fullscreen transition deadline expired.")), timeoutMs);
    if (options.fullscreen) options.window.on("enter-full-screen", onTransition);
    else options.window.on("leave-full-screen", onTransition);
    Promise.resolve().then(options.trigger).then((verified) => {
      if (verified !== true) {
        finish(new Error("Desktop video renderer did not verify fullscreen state."));
        return;
      }
      rendererDone = true;
      finish();
    }, () => finish(new Error("Desktop video renderer fullscreen operation failed.")));
  });
}

/** Smoke-only DOM/native proof, using the existing main app document and host permission policy. */
export async function verifyDesktopSmokeVideo(options: {
  window: FullscreenWindow;
  webContents: Pick<WebContents, "executeJavaScript">;
  url: string;
  id: string;
  platform?: NodeJS.Platform;
}): Promise<void> {
  if (options.window.isFullScreen()) throw new Error("Desktop video smoke requires its initial windowed state.");
  let entered = false;
  let failure: unknown;
  const id = JSON.stringify(options.id);
  const mac = (options.platform ?? process.platform) === "darwin";
  try {
    await bounded(options.webContents.executeJavaScript(
      `(${prepareVideo.toString()})(${JSON.stringify({ id: options.id, url: options.url })})`,
    ), 12_000);
    await waitForDesktopSmokeFullscreen({
      window: options.window,
      fullscreen: true,
      requireNativeEvent: mac,
      trigger: () => options.webContents.executeJavaScript(`(() => {
        const video = document.getElementById(${id});
        if (!(video instanceof HTMLVideoElement)) throw new Error('Missing smoke video');
        return video.requestFullscreen().then(() => {
          if (document.fullscreenElement !== video) throw new Error('Video did not enter fullscreen');
          return true;
        });
      })()`, true),
    });
    entered = true;
  } catch (error) {
    failure = error;
  } finally {
    try {
      await waitForDesktopSmokeFullscreen({
        window: options.window,
        fullscreen: false,
        requireNativeEvent: mac && entered,
        trigger: () => options.webContents.executeJavaScript(`(async () => {
          const video = document.getElementById(${id});
          let timer;
          try {
            if (document.fullscreenElement) await Promise.race([
              document.exitFullscreen(), new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Fullscreen exit timed out')), 8000);
              })
            ]);
            if (document.fullscreenElement !== null) throw new Error('Video did not leave fullscreen');
            if (video && (video.__smokeRoot !== document.getElementById('root')
              || video.__smokeDocument !== location.href)) throw new Error('Main app document was replaced');
            return true;
          } finally {
            clearTimeout(timer);
            if (video instanceof HTMLVideoElement) {
              video.pause(); video.removeAttribute('src'); video.load(); video.remove();
            }
          }
        })()`),
      });
    } catch {
      failure ??= new Error("Desktop video fullscreen exit or media cleanup failed.");
    }
  }
  if (failure) throw failure;
}

/** Serialized after bundling. It has no host closure, credential, or preload dependency. */
async function prepareVideo(input: { id: string; url: string }): Promise<void> {
  const video = document.createElement("video") as HTMLVideoElement & {
    __smokeRoot?: HTMLElement | null;
    __smokeDocument?: string;
  };
  video.id = input.id;
  video.__smokeRoot = document.getElementById("root");
  video.__smokeDocument = location.href;
  video.controls = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.style.cssText = "position:fixed;top:20px;left:20px;width:256px;height:192px;z-index:99999";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const wait = (event: string, ready: () => boolean, start?: () => void) => new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener(event, check);
      video.removeEventListener("error", failed);
      controller.signal.removeEventListener("abort", failed);
    };
    const failed = () => { cleanup(); reject(new Error("Desktop video could not load, play or seek.")); };
    const check = () => {
      if (controller.signal.aborted || video.error) failed();
      else if (ready()) { cleanup(); resolve(); }
    };
    video.addEventListener(event, check);
    video.addEventListener("error", failed);
    controller.signal.addEventListener("abort", failed, { once: true });
    try { start?.(); check(); } catch { failed(); }
  });
  let prepared = false;
  try {
    if (!video.__smokeRoot) throw new Error("Desktop video requires the mounted main app.");
    document.body.append(video);
    await wait("loadeddata", () => video.readyState >= 2, () => { video.src = input.url; video.load(); });
    if (video.videoWidth !== 64 || video.videoHeight !== 48 || !Number.isFinite(video.duration) || video.duration < 1) {
      throw new Error("Desktop video fixture was not decoded.");
    }
    await Promise.all([video.play(), wait("timeupdate", () => video.currentTime > 0.05)]);
    video.pause();
    const position = video.duration / 2;
    await wait("seeked", () => !video.seeking && Math.abs(video.currentTime - position) < 0.1,
      () => { video.currentTime = position; });
    prepared = true;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (!prepared) {
      video.pause(); video.removeAttribute("src"); video.load(); video.remove();
    }
  }
}

async function bounded(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Desktop video preparation deadline expired.")), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
