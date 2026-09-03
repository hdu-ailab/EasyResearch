import { request as requestHttp } from "node:http";

export const LOCAL_HTTP_TIMEOUT_MS = 2_000;
const LOCAL_HTTP_RESPONSE_LIMIT = 1024 * 1024;

export type LocalHttpFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export function createDirectLocalHttpFetch(
  timeoutMs = LOCAL_HTTP_TIMEOUT_MS,
): LocalHttpFetch {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Direct local HTTP timeout must be a positive integer.");
  }
  return (input, init) => directLocalHttpRequest(input, init, timeoutMs);
}

export const directLocalHttpFetch = createDirectLocalHttpFetch();

async function directLocalHttpRequest(
  input: string | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const url = input instanceof URL ? new URL(input.href) : new URL(input);
  if (url.protocol !== "http:" || url.username || url.password) {
    throw new TypeError("Direct local HTTP accepts only uncredentialed http URLs.");
  }
  if (init?.body !== undefined && init.body !== null) {
    throw new TypeError("Direct local HTTP lifecycle requests do not accept a body.");
  }
  const signal = init?.signal;
  if (signal?.aborted) throw abortReason(signal);

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let responseBytes = 0;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const request = requestHttp(url, {
      agent: false,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer | Uint8Array | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responseBytes += bytes.byteLength;
        if (responseBytes > LOCAL_HTTP_RESPONSE_LIMIT) {
          request.destroy(new Error("Direct local HTTP response exceeded its size limit."));
          return;
        }
        chunks.push(bytes);
      });
      incoming.once("error", (error) => finish(() => reject(error)));
      incoming.once("end", () => finish(() => {
        const status = incoming.statusCode;
        if (status === undefined || status < 200 || status > 599) {
          reject(new Error("Direct local HTTP returned an invalid status."));
          return;
        }
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        }
        const body = status === 204 || status === 205 || status === 304
          ? null
          : Buffer.concat(chunks);
        resolve(new Response(body, {
          status,
          statusText: incoming.statusMessage,
          headers,
        }));
      }));
    });
    const onAbort = (): void => {
      request.destroy(abortReason(signal));
    };
    const timeout = setTimeout(() => {
      request.destroy(new Error(`Direct local HTTP request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    request.once("error", (error) => finish(() => reject(error)));
    request.end();
  });
}

function abortReason(signal: AbortSignal | null | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}
