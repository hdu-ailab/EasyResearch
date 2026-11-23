import { stableNpmVersion } from "./npm-update-provenance";

const URL = "https://registry.npmjs.org/easyresearch/latest";
const MAX_BODY = 256 * 1024;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function fetchNpmUpdateVersion(signal: AbortSignal, options: { fetch?: Fetch; timeoutMs?: number } = {}): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 15_000);
  const combined = AbortSignal.any([signal, abort.signal]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let rejectAbort!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => { void reader?.cancel().catch(() => {}); rejectAbort(new Error("Update metadata request cancelled or timed out.")); };
  combined.addEventListener("abort", onAbort, { once: true });
  try {
    combined.throwIfAborted();
    const response = await Promise.race([(options.fetch ?? globalThis.fetch)(URL, { signal: combined, redirect: "error", headers: { Accept: "application/json" } }), cancelled]);
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_BODY) {
      void response.body?.cancel(); throw new Error("Official npm metadata is unavailable.");
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let total = 0;
    while (true) {
      const chunk = await Promise.race([reader.read(), cancelled]);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_BODY) throw new Error("Official npm metadata exceeds the response limit.");
      chunks.push(chunk.value);
    }
    combined.throwIfAborted();
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { name?: unknown; version?: unknown };
    if (value.name !== "easyresearch" || !stableNpmVersion(value.version)) throw new Error("Official npm metadata has no valid stable version.");
    return value.version;
  } finally {
    clearTimeout(timer); combined.removeEventListener("abort", onAbort);
    await reader?.cancel().catch(() => {}); reader?.releaseLock();
  }
}
