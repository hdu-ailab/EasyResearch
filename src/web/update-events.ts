import type { UpdateAction, UpdateController, UpdateSnapshot } from "../runtime/update-contract";
import { NpmUpdateError } from "../runtime/npm-update";

export function parseUpdateAction(value: unknown): UpdateAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NpmUpdateError(400, "UPDATE_INVALID", "Invalid update action.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["action", "operationId", "force"].includes(key))
    || !["check", "download", "install", "activate", "cancel"].includes(String(input.action))
    || (input.operationId !== undefined && (typeof input.operationId !== "string" || !/^[\w-]{1,100}$/.test(input.operationId)))
    || (input.force !== undefined && (typeof input.force !== "boolean" || input.action !== "activate"))) {
    throw new NpmUpdateError(400, "UPDATE_INVALID", "Invalid update action.");
  }
  return input as unknown as UpdateAction;
}

export function updateEvents(update: UpdateController): Response {
  let unsubscribe: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (snapshot: UpdateSnapshot) => {
        const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ type: "update", snapshot })}\n\n`);
        if (bytes.byteLength > (controller.desiredSize ?? 0)) {
          unsubscribe?.(); controller.error(new Error("Update events exceeded the pending-byte budget.")); return;
        }
        controller.enqueue(bytes);
      };
      unsubscribe = update.subscribe(send);
      send(update.snapshot());
    },
    cancel() { unsubscribe?.(); },
  }, { highWaterMark: 64 * 1024, size: (value) => value?.byteLength ?? 0 });
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" } });
}
