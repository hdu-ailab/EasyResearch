import type {
  BackgroundOutputChangedEvent,
  BackgroundTask,
  BackgroundTasksChangedEvent,
  ShellOutputDto,
} from "../../../background/contracts";
import { routes } from "./routes";
import { requestJson } from "./transport";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid background task response");
  return value as Record<string, unknown>;
}

export function parseBackgroundTasks(value: unknown): BackgroundTask[] {
  if (!Array.isArray(value)) throw new Error("Invalid background task list");
  const ids = new Set<string>();
  return value.map((raw) => {
    const item = record(raw);
    if (
      typeof item.id !== "string" ||
      !item.id.trim() ||
      ids.has(item.id) ||
      typeof item.sessionID !== "string" ||
      !item.sessionID.trim() ||
      typeof item.description !== "string" ||
      typeof item.blocking !== "boolean" ||
      (item.kind !== "shell" && item.kind !== "subagent") ||
      (item.status !== "running" &&
        item.status !== "completed" &&
        item.status !== "cancelled" &&
        item.status !== "error")
    )
      throw new Error("Invalid background task");
    ids.add(item.id);
    const task: BackgroundTask = {
      id: item.id,
      sessionID: item.sessionID,
      description: item.description,
      kind: item.kind,
      status: item.status,
      blocking: item.blocking,
    };
    for (const key of ["agent", "shellID", "command", "outputPath"] as const) {
      if (item[key] === undefined) continue;
      if (typeof item[key] !== "string") throw new Error("Invalid background task metadata");
      task[key] = item[key];
    }
    if (item.pid !== undefined) {
      if (typeof item.pid !== "number" || !Number.isSafeInteger(item.pid) || item.pid <= 0) {
        throw new Error("Invalid background task process");
      }
      task.pid = item.pid;
    }
    if (item.startedAt !== undefined) task.startedAt = nonnegativeInteger(item.startedAt);
    return task;
  });
}

export function parseBackgroundTasksChanged(value: unknown): BackgroundTasksChangedEvent {
  const source = record(value);
  if (source.type !== "background_tasks_changed") throw new Error("Invalid background task event");
  return { type: "background_tasks_changed", tasks: parseBackgroundTasks(source.tasks) };
}

function accepted(value: unknown): { ok: true } {
  if (record(value).ok !== true) throw new Error("Background task request was not accepted");
  return { ok: true };
}

export function getBackgroundTasks(id: string, signal?: AbortSignal) {
  return requestJson(routes.background(id), (value) => ({ tasks: parseBackgroundTasks(record(value).tasks) }), {
    signal,
  });
}

const mutation = (): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

export function promoteBackgroundTasks(id: string) {
  return requestJson(routes.background(id), accepted, mutation());
}

export function cancelBackgroundTask(id: string, taskId: string) {
  return requestJson(routes.cancelBackgroundTask(id, taskId), accepted, mutation());
}

function nonnegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid output cursor or timestamp");
  return value;
}

export function parseBackgroundOutputChanged(value: unknown): BackgroundOutputChangedEvent {
  const source = record(value);
  if (source.type !== "background_output_changed" || typeof source.taskId !== "string" || !source.taskId.trim())
    throw new Error("Invalid shell output event");
  return { type: "background_output_changed", taskId: source.taskId };
}

export function parseShellOutput(value: unknown): ShellOutputDto {
  const item = record(value);
  if (
    typeof item.id !== "string" ||
    !item.id.trim() ||
    typeof item.sessionID !== "string" ||
    !item.sessionID.trim() ||
    typeof item.command !== "string" ||
    typeof item.output !== "string" ||
    typeof item.truncated !== "boolean" ||
    typeof item.reset !== "boolean" ||
    !["running", "completed", "cancelled", "error"].includes(String(item.status)) ||
    (item.exitCode !== null && (typeof item.exitCode !== "number" || !Number.isSafeInteger(item.exitCode)))
  )
    throw new Error("Invalid shell output");
  const cursor = nonnegativeInteger(item.cursor),
    size = nonnegativeInteger(item.size);
  if (cursor > size || new TextEncoder().encode(item.output).byteLength > 65536)
    throw new Error("Invalid shell output bounds");
  const result: ShellOutputDto = {
    id: item.id,
    sessionID: item.sessionID,
    command: item.command,
    status: item.status as ShellOutputDto["status"],
    startedAt: nonnegativeInteger(item.startedAt),
    exitCode: item.exitCode as number | null,
    output: item.output,
    cursor,
    size,
    truncated: item.truncated,
    reset: item.reset,
  };
  if (item.pid !== undefined) result.pid = nonnegativeInteger(item.pid);
  if (item.timeout !== undefined) {
    if (typeof item.timeout !== "boolean") throw new Error("Invalid shell timeout");
    result.timeout = item.timeout;
  }
  if (item.signal !== undefined) {
    if (typeof item.signal !== "string") throw new Error("Invalid shell signal");
    result.signal = item.signal;
  }
  return result;
}

export function getShellOutput(rootId: string, taskId: string, cursor?: number, signal?: AbortSignal) {
  return requestJson(routes.backgroundOutput(rootId, taskId, cursor), parseShellOutput, { signal });
}

export function replaceBackgroundOutputWatches(rootId: string, leaseId: string, revision: number, taskIds: string[]) {
  return requestJson(
    routes.backgroundOutputWatches(rootId, leaseId),
    (value) => {
      const result = record(value);
      if (typeof result.applied !== "boolean") throw new Error("Invalid shell output watch acknowledgement");
      return { applied: result.applied, revision: nonnegativeInteger(result.revision) };
    },
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision, taskIds }) },
  );
}
