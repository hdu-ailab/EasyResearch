import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../runtime/logger";
import { mountPiEventLogger, type PiEventBus } from "../../runtime/pi-event-logger";

/**
 * ADR-063: atomic extension mounting the Pi event logger for the Paper
 * Assistant runtime. RPC children never run their own logger (Constraint 4),
 * so mounting is skipped when `EASYRESEARCH_RPC_CHILD` is set — mirroring the
 * pre-split behavior.
 */
export function createEventLoggerExtension(): InlineExtension {
  return async (pi) => {
    if (process.env.EASYRESEARCH_RPC_CHILD === "1") return;
    const logger = createLogger("paper-assistant");
    mountPiEventLogger(pi as unknown as PiEventBus, logger);
    logger.info("paper-assistant session started", { cwd: process.cwd() });
  };
}

export default createEventLoggerExtension();
