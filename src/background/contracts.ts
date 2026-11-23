/** Public, path-safe task metadata. Runtime ownership is checked by the root. */
export interface BackgroundTask {
  id: string;
  kind: "shell" | "subagent";
  sessionID: string;
  description: string;
  status: "running" | "completed" | "cancelled" | "error";
  blocking: boolean;
  agent?: string;
  shellID?: string;
  command?: string;
  pid?: number;
  outputPath?: string;
  startedAt?: number;
}

export interface BackgroundTasksChangedEvent {
  type: "background_tasks_changed";
  tasks: BackgroundTask[];
}

export interface ShellOutputDto {
  id: string;
  sessionID: string;
  command: string;
  status: "running" | "completed" | "cancelled" | "error";
  startedAt: number;
  pid?: number;
  exitCode: number | null;
  signal?: string;
  timeout?: boolean;
  output: string;
  /** Next UTF-8 byte offset, not a JavaScript character offset. */
  cursor: number;
  size: number;
  truncated: boolean;
  reset: boolean;
}

export interface BackgroundOutputChangedEvent {
  type: "background_output_changed";
  taskId: string;
}
