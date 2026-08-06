import type {
  ActiveSessionDto,
  AgentDto,
  ConfigEntryDto,
  ConfigScope,
  DirectoryEntryDto,
  FileContentDto,
  FileEntryDto,
  SessionSnapshotDto,
  SessionSummaryDto,
  StatusDto,
} from "../../web/contracts";
import type { ConfigFileDto } from "./types";

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init ?? { method: "GET" });
  if (!res.ok) {
    let details: unknown = null;
    try {
      details = await res.json();
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, details);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export function listStatus(): Promise<StatusDto> {
  return request("/api/status");
}

export function listAgents(): Promise<AgentDto[]> {
  return request("/api/agents");
}

export function listDirectories(path: string): Promise<DirectoryEntryDto[]> {
  return request(`/api/directories?path=${encodeURIComponent(path)}`).then(
    (listing) => (listing as { entries: DirectoryEntryDto[] }).entries,
  );
}

export function listEntries(path: string): Promise<FileEntryDto[]> {
  return request(`/api/entries?path=${encodeURIComponent(path)}`).then(
    (listing) => (listing as { entries: FileEntryDto[] }).entries,
  );
}

export function readFileContent(path: string): Promise<FileContentDto> {
  return request(`/api/file?path=${encodeURIComponent(path)}`);
}

/**
 * URL for the MIME-correct, Range-capable raw bytes endpoint. Used for PDF
 * loading and Markdown-local image/link resources.
 */
export function rawFileUrl(path: string): string {
  return `/api/file/raw?path=${encodeURIComponent(path)}`;
}

export function createSession(cwd: string): Promise<ActiveSessionDto> {
  return request("/api/sessions", json({ cwd }));
}

export function openSession(path: string): Promise<ActiveSessionDto> {
  return request("/api/sessions/open", json({ path }));
}

export function getSnapshot(id: string): Promise<SessionSnapshotDto> {
  return request(`/api/sessions/${encodeURIComponent(id)}/snapshot`);
}

export function sendPrompt(id: string, message: string): Promise<void> {
  return request(`/api/sessions/${encodeURIComponent(id)}/messages`, json({ message }));
}

export function abortSession(id: string): Promise<void> {
  return request(`/api/sessions/${encodeURIComponent(id)}/abort`, { method: "POST" });
}

export function stopSession(id: string): Promise<void> {
  return request(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: "POST" });
}

export function restartSession(id: string): Promise<ActiveSessionDto> {
  return request(`/api/sessions/${encodeURIComponent(id)}/restart`, { method: "POST" });
}

export function listConfig(scope: ConfigScope, cwd?: string, path?: string): Promise<ConfigEntryDto[]> {
  const params = new URLSearchParams({ scope });
  if (cwd) params.set("cwd", cwd);
  if (path) params.set("path", path);
  return request(`/api/config?${params.toString()}`);
}

export function readConfigFile(scope: ConfigScope, cwd?: string, path?: string): Promise<ConfigFileDto> {
  const params = new URLSearchParams({ scope });
  if (cwd) params.set("cwd", cwd);
  if (path) params.set("path", path);
  return request(`/api/config/file?${params.toString()}`);
}

export function writeConfigFile(scope: ConfigScope, cwd: string | undefined, path: string, content: string): Promise<void> {
  return request("/api/config/file", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope, cwd, path, content }),
  });
}

export function createConfigDirectory(scope: ConfigScope, cwd: string | undefined, path: string): Promise<void> {
  return request("/api/config/directory", json({ scope, cwd, path }));
}

export interface SessionEventHandlers {
  onEvent: (event: unknown) => void;
  onError: () => void;
}

/**
 * Stream session events over SSE. Parses each `data:` payload and forwards it;
 * calls `onError` for malformed payloads or network failures. Returns an
 * unsubscribe function that closes the connection without touching the child.
 */
export function connectSessionEvents(id: string, handlers: SessionEventHandlers): () => void {
  const source = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events`);
  source.onmessage = (e) => {
    try {
      handlers.onEvent(JSON.parse(e.data));
    } catch {
      handlers.onError();
    }
  };
  source.onerror = () => handlers.onError();
  return () => source.close();
}
