import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createLogger } from "../../runtime/logger";
import { mountPiEventLogger, type PiEventBus } from "../../runtime/pi-event-logger";

/**
 * ADR-063: atomic extension mounting the Pi event logger for the Research
 * Assistant runtime.
 */
export function createEventLoggerExtension(): InlineExtension {
  return async (pi) => {
    const logger = createLogger("research-assistant");
    mountPiEventLogger(pi as unknown as PiEventBus, logger);
    logger.info("research-assistant session started", { cwd: process.cwd() });
  };
}

export default createEventLoggerExtension();
