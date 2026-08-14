import type { AuthFlowEventDto } from "../../../web/contracts";
import { parseAuthFlowEvent } from "./parsers";
import { routes } from "./routes";

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
  const response = await fetch(path, init);
  if (!response.ok) throw new ApiError(response.status, await responseDetails(response));
  if (response.status !== 204) await response.text();
}

export interface SessionEventHandlers {
  onEvent: (event: unknown) => void;
  onError: () => void;
}

export function connectEventStream(path: string, handlers: SessionEventHandlers): () => void {
  const source = new EventSource(path);
  source.onmessage = (event) => {
    try {
      handlers.onEvent(JSON.parse(event.data));
    } catch {
      handlers.onError();
    }
  };
  source.onerror = () => handlers.onError();
  return () => source.close();
}

/**
 * Open a per-flow SSE connection to `/api/auth/flows/:flowId/events`. The
 * browser-side generation token (return value of the caller) is managed by
 * the `useProviderAuthFlow` hook, not here; this function only owns the
 * underlying `EventSource` lifecycle.
 */
export function connectAuthFlow(flowId: string, handlers: AuthFlowHandlers): () => void {
  const path = routes.authFlowEvents(flowId);
  const source = new EventSource(path);
  source.onmessage = (event) => {
    try {
      handlers.onEvent(parseAuthFlowEvent(JSON.parse(event.data)));
    } catch {
      handlers.onError();
    }
  };
  source.onerror = () => handlers.onError();
  return () => source.close();
}
