import type { Logger } from "./logger";
import { mapEventToLog } from "./event-log-map";

export type PiEventBus = {
  on(event: string, handler: (event: { type: string; [key: string]: unknown }) => void): unknown;
};

const LOGGED_EVENT_NAMES = [
  "session_start", "agent_start", "agent_end", "agent_settled",
  "turn_start", "turn_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end", "tool_result",
  "message_update", "model_select",
  "auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end",
  "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished",
];

export function mountPiEventLogger(pi: PiEventBus, logger: Logger): void {
  for (const name of LOGGED_EVENT_NAMES) {
    pi.on(name, (event) => {
      const mapped = mapEventToLog(event);
      if (!mapped) return;
      if (mapped.level === "debug") logger.debug(mapped.message, mapped.fields);
      else if (mapped.level === "info") logger.info(mapped.message, mapped.fields);
      else logger.warn(mapped.message, mapped.fields);
    });
  }
}
