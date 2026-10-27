import { ApiError } from "../api";
import type { MessageKey } from "../i18n/messages";

export function fileOperationError(error: unknown): MessageKey {
  if (!(error instanceof ApiError)) return "files.operationError";
  const code = error.details && typeof error.details === "object" ? (error.details as { code?: unknown }).code : null;
  if (code === "WORKSPACE_BUSY" || code === "FILE_OPERATION_CONFLICT") return "files.workspaceBusy";
  if (code === "FILE_EXISTS") return "files.conflict";
  if (code === "FILE_OPERATION_UNSUPPORTED") return "files.unsupportedOperation";
  if (code === "FILE_NOT_REGULAR") return "files.regularFileOnly";
  if (code === "FILE_CLEANUP_FAILED") return "files.cleanupError";
  if (code === "FILE_CHANGED") return "files.changedError";
  if (code === "FILE_NAME_INVALID") return "files.invalidName";
  if (code === "FILE_PATH_INVALID") return "files.locationError";
  if (error.status === 413) return "files.tooLarge";
  if (error.status === 403) return "files.permissionError";
  if (error.status === 404) return "files.missingError";
  if (error.status === 0) return "files.connectionError";
  return "files.operationError";
}
