export interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

export interface StatusResponse {
  agentDir: string | null;
  model: string | null;
  sessions: SessionSummary[];
}

export async function fetchStatus(): Promise<StatusResponse> {
  const res = await fetch("/api/status");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as StatusResponse;
}
