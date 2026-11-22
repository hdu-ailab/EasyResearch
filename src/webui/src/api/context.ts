import type { ContextEditRequestDto } from "../../../web/context-contracts";
import { parseContextItemText, parseContextPreview, parseContextSnapshot } from "./context-parsers";
import { routes } from "./routes";
import { requestJson } from "./transport";

export function getSessionContext(id: string, signal?: AbortSignal) {
  return requestJson(routes.context(id), parseContextSnapshot, { signal });
}
export function getContextItemText(
  id: string,
  revision: string,
  itemId: string,
  view: "original" | "current",
  offset = 0,
  signal?: AbortSignal,
) {
  return requestJson(routes.contextItem(id, revision, itemId, view, offset), parseContextItemText, { signal });
}
function body(request: ContextEditRequestDto, signal?: AbortSignal): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal };
}
export function previewContextEdits(id: string, request: ContextEditRequestDto, signal?: AbortSignal) {
  return requestJson(routes.contextEdit(id, "preview"), parseContextPreview, body(request, signal));
}
export function applyContextEdits(id: string, request: ContextEditRequestDto, signal?: AbortSignal) {
  return requestJson(routes.contextEdit(id, "apply"), parseContextSnapshot, body(request, signal));
}
