import type { Logger } from "../runtime/logger";
import { mapEventToLog } from "../runtime/event-log-map";

export type EventListener = (event: unknown) => void;

/**
 * Forward one Pi RPC child's event stream into the process logger (ADR-039).
 * Every mapped event gains the sessionId/cwd context; unmapped events are
 * skipped. Returns the unsubscribe function.
 */
export function attachEventLogger(
  sessionId: string,
  cwd: string,
  onEvent: (listener: EventListener) => () => void,
  logger: Logger,
): () => void {
  return onEvent((event) => {
    const mapped = mapEventToLog(event as { type: string; [key: string]: unknown });
    if (!mapped) return;
    const fields = { sessionId, cwd, ...mapped.fields };
    if (mapped.level === "debug") logger.debug(mapped.message, fields);
    else if (mapped.level === "info") logger.info(mapped.message, fields);
    else logger.warn(mapped.message, fields);
  });
}
