import { useLayoutEffect, useRef, useState } from "react";
import { FILE_UPLOAD_LIMIT } from "../../../web/contracts";
import { uploadFile } from "../api";
import { fileOperationError } from "../components/file-operation-error";
import type { MessageKey } from "../i18n/messages";

export interface FileUploadRow {
  id: number;
  name: string;
  directory: string;
  total: number;
  loaded: number;
  state: "queued" | "uploading" | "confirming" | "cancelling" | "cancelled" | "failed" | "complete";
  error?: MessageKey;
  file?: File;
}

// Bound retained File references and DOM rows as well as concurrent transports.
export const FILE_UPLOAD_QUEUE_LIMIT = 64;

/** Mounted exact-root owner. FilesPanel keys its owner by root. */
export function useFileUploads(root: string, onUploaded: (directory: string) => void) {
  const [rows, setRows] = useState<FileUploadRow[]>([]);
  const [queueError, setQueueError] = useState<MessageKey | null>(null);
  const owner = useRef({ live: true, rows, nextId: 0, active: new Map<number, AbortController>() });
  const complete = useRef(onUploaded);
  complete.current = onUploaded;

  useLayoutEffect(() => {
    const state = owner.current;
    state.live = true;
    return () => {
      state.live = false;
      for (const controller of state.active.values()) controller.abort();
      state.rows = [];
    };
  }, []);

  const publish = () => {
    if (owner.current.live) setRows([...owner.current.rows]);
  };
  const update = (id: number, patch: Partial<FileUploadRow>) => {
    const state = owner.current;
    if (!state.live) return;
    state.rows = state.rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
    publish();
  };
  const pump = () => {
    const state = owner.current;
    if (!state.live) return;
    while (state.active.size < 2) {
      const row = state.rows.find((item) => item.state === "queued");
      if (!row?.file) break;
      const controller = new AbortController();
      state.active.set(row.id, controller);
      update(row.id, { state: "uploading" });
      void uploadFile(root, row.directory, row.file, {
        signal: controller.signal,
        onProgress: (loaded, total) => {
          if (controller.signal.aborted) return;
          update(row.id, { loaded, state: loaded === total ? "confirming" : "uploading" });
        },
      })
        .then(
          () => {
            if (!state.live) return;
            update(row.id, { state: "complete", loaded: row.total, file: undefined });
            complete.current(row.directory);
          },
          (error: unknown) => {
            update(
              row.id,
              controller.signal.aborted
                ? { state: "cancelled" }
                : { state: "failed", error: fileOperationError(error) },
            );
          },
        )
        .finally(() => {
          state.active.delete(row.id);
          pump();
        });
    }
  };

  return {
    rows,
    queueError,
    enqueue(directory: string, files: readonly File[]) {
      const state = owner.current;
      if (!state.live) return;
      const capacity = FILE_UPLOAD_QUEUE_LIMIT - state.rows.length;
      setQueueError(files.length > capacity ? "files.queueFull" : null);
      state.rows = [
        ...state.rows,
        ...files.slice(0, capacity).map(
          (file): FileUploadRow => ({
            id: ++state.nextId,
            name: file.name,
            directory,
            total: file.size,
            loaded: 0,
            file,
            state: file.size > FILE_UPLOAD_LIMIT ? "failed" : "queued",
            ...(file.size > FILE_UPLOAD_LIMIT ? { error: "files.tooLarge" as const } : {}),
          }),
        ),
      ];
      publish();
      pump();
    },
    cancel(id: number) {
      const controller = owner.current.active.get(id);
      if (controller) {
        update(id, { state: "cancelling" });
        controller.abort();
      } else update(id, { state: "cancelled" });
    },
    retry(id: number) {
      const row = owner.current.rows.find((item) => item.id === id);
      if (
        !row?.file ||
        row.total > FILE_UPLOAD_LIMIT ||
        owner.current.active.has(id) ||
        (row.state !== "failed" && row.state !== "cancelled")
      )
        return;
      update(id, { state: "queued", loaded: 0, error: undefined });
      pump();
    },
    dismiss(id: number) {
      const state = owner.current;
      if (state.active.has(id)) return;
      state.rows = state.rows.filter((row) => row.id !== id);
      setQueueError(null);
      publish();
    },
  };
}
