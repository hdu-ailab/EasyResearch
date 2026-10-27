import type { AuthFlowEventDto } from "../../../web/contracts";
import { parseAuthFlowEvent } from "./parsers";
import { requestBudget } from "./request-budget";
import { routes } from "./routes";
import { subscribeSharedEvents } from "./shared-events";

export interface AuthFlowHandlers {
  onEvent: (event: AuthFlowEventDto) => void;
  onError: () => void;
}

export type Decoder<T> = (value: unknown) => T;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly details: unknown,
  ) {
    super(messageFor(details));
  }
}

export class RawFileSizeError extends Error {
  override readonly name = "RawFileSizeError";

  constructor(
    public readonly maxBytes: number,
    public readonly actualBytes: number,
  ) {
    super(`Raw file exceeds the ${maxBytes}-byte preview limit`);
  }
}

function messageFor(details: unknown): string {
  if (details && typeof details === "object") {
    const error = (details as { error?: unknown }).error;
    if (typeof error === "string") return error;
  }
  return "Request failed";
}

async function responseDetails(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function requestJson<T>(path: string, decode: Decoder<T>, init?: RequestInit): Promise<T> {
  return requestBudget.run(path, init?.signal, () => readJson(path, decode, init));
}

async function readJson<T>(path: string, decode: Decoder<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init ?? { method: "GET" });
  if (!response.ok) throw new ApiError(response.status, await responseDetails(response));
  if (response.status === 204) return undefined as T;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(502, { error: "Invalid API response" });
  }

  try {
    return decode(body);
  } catch {
    throw new ApiError(502, { error: "Invalid API response" });
  }
}

export async function requestVoid(path: string, init: RequestInit): Promise<void> {
  return requestBudget.run(path, init.signal, async () => {
    const response = await fetch(path, init);
    if (!response.ok) throw new ApiError(response.status, await responseDetails(response));
    if (response.status !== 204) await response.text();
  });
}

export interface UploadOptions {
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
}

/** Send the File itself; XHR reports bytes without buffering them in JavaScript. */
export function requestUpload<T>(
  path: string,
  file: File,
  decode: Decoder<T>,
  options: UploadOptions = {},
): Promise<T> {
  return requestBudget.run(
    path,
    options.signal,
    () =>
      new Promise<T>((resolve, reject) => {
        const { signal, onProgress } = options;
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          return;
        }
        const xhr = new XMLHttpRequest();
        let settled = false;
        const finish = (result: { value: T } | { error: unknown }) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          xhr.onload = xhr.onerror = xhr.onabort = xhr.ontimeout = null;
          xhr.upload.onprogress = xhr.upload.onload = null;
          if ("error" in result) reject(result.error);
          else resolve(result.value);
        };
        const abort = () => {
          xhr.abort();
          finish({ error: signal?.reason ?? new DOMException("Aborted", "AbortError") });
        };
        xhr.upload.onprogress = (event) => {
          if (!settled) onProgress?.(Math.min(file.size, event.loaded), file.size);
        };
        // Upload completion is not HTTP completion. Keep the budget slot until onload.
        xhr.upload.onload = () => {
          if (!settled) onProgress?.(file.size, file.size);
        };
        xhr.onload = () => {
          let body: unknown;
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            body = null;
          }
          if (xhr.status < 200 || xhr.status >= 300) {
            finish({ error: new ApiError(xhr.status, body) });
            return;
          }
          try {
            finish({ value: decode(body) });
          } catch {
            finish({ error: new ApiError(502, { error: "Invalid API response" }) });
          }
        };
        xhr.onerror = () => finish({ error: new ApiError(0, { error: "Upload connection failed" }) });
        xhr.ontimeout = () => finish({ error: new ApiError(0, { error: "Upload timed out" }) });
        xhr.onabort = () => finish({ error: signal?.reason ?? new DOMException("Aborted", "AbortError") });
        try {
          xhr.open("PUT", path);
          xhr.setRequestHeader("Content-Type", "application/octet-stream");
          signal?.addEventListener("abort", abort, { once: true });
          xhr.send(file);
        } catch (error) {
          finish({ error });
        }
      }),
  );
}

export async function requestBytes(
  path: string,
  options: { maxBytes: number; signal?: AbortSignal },
): Promise<ArrayBuffer> {
  return requestBudget.run(path, options.signal, () => readBytes(path, options));
}

async function readBytes(path: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<ArrayBuffer> {
  const response = await fetch(path, { method: "GET", signal: options.signal });
  if (!response.ok) throw new ApiError(response.status, await responseDetails(response));

  const declaredHeader = response.headers.get("Content-Length");
  if (declaredHeader && /^\d+$/.test(declaredHeader)) {
    const declared = BigInt(declaredHeader);
    if (declared > BigInt(options.maxBytes)) {
      const actual = declared <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(declared) : Number.POSITIVE_INFINITY;
      try {
        await response.body?.cancel();
      } catch {
        // Preserve the size error when the transport has already closed the stream.
      }
      throw new RawFileSizeError(options.maxBytes, actual);
    }
  }

  const { signal, maxBytes } = options;
  const abortReason = () => signal?.reason ?? new DOMException("Aborted", "AbortError");
  const reader = response.body?.getReader();
  if (!reader) {
    if (signal?.aborted) throw abortReason();
    return new ArrayBuffer(0);
  }
  let cancellation: Promise<void> | undefined;
  const cancel = (reason: unknown) =>
    (cancellation ??= Promise.resolve()
      .then(() => reader.cancel(reason))
      .catch(() => {
        // Preserve the original size/read/abort error if the stream has already failed.
      }));
  const abort = () => {
    void cancel(abortReason());
  };
  signal?.addEventListener("abort", abort, { once: true });
  let bytes = new Uint8Array(0);
  let length = 0;
  try {
    if (signal?.aborted) throw abortReason();
    while (true) {
      const chunk = await reader.read();
      if (signal?.aborted) throw abortReason();
      if (chunk.done) return length === bytes.byteLength ? bytes.buffer : bytes.slice(0, length).buffer;
      const nextLength = length + chunk.value.byteLength;
      // Headers are only an early rejection hint. Reject before retaining/copying
      // an over-limit chunk, including when Content-Length is absent or dishonest.
      if (nextLength > maxBytes) throw new RawFileSizeError(maxBytes, nextLength);
      if (nextLength > bytes.byteLength) {
        // A bounded growing buffer avoids an unbounded list of tiny chunks.
        const next = new Uint8Array(Math.min(maxBytes, Math.max(64 * 1024, bytes.byteLength * 2, nextLength)));
        next.set(bytes.subarray(0, length));
        bytes = next;
      }
      bytes.set(chunk.value, length);
      length = nextLength;
    }
  } catch (error) {
    // Keep the slow slot until cancellation has settled, even if it is asynchronous.
    await cancel(error);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export interface SessionEventHandlers {
  onEvent: (event: unknown) => void;
  onError: () => void;
}

export function connectEventStream(path: string, handlers: SessionEventHandlers): () => void {
  return subscribeSharedEvents(path, handlers);
}

/**
 * Open a logical subscription to `/api/auth/flows/:flowId/events`. The
 * browser-side generation token (return value of the caller) is managed by
 * the `useProviderAuthFlow` hook, not here; this function only owns the
 * shared transport retains physical connection ownership.
 */
export function connectAuthFlow(flowId: string, handlers: AuthFlowHandlers): () => void {
  const path = routes.authFlowEvents(flowId);
  return subscribeSharedEvents(path, {
    onEvent: (event) => {
      try {
        handlers.onEvent(parseAuthFlowEvent(event));
      } catch {
        handlers.onError();
      }
    },
    onError: handlers.onError,
  });
}
