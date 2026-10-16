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

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > options.maxBytes) {
    throw new RawFileSizeError(options.maxBytes, bytes.byteLength);
  }
  return bytes;
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
