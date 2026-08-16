import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createEventLoggerExtension } from "./index";

vi.mock("../../runtime/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../runtime/pi-event-logger", () => ({
  mountPiEventLogger: vi.fn(),
}));

import { mountPiEventLogger } from "../../runtime/pi-event-logger";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createEventLoggerExtension", () => {
  it("mounts the pi event logger", async () => {
    await (createEventLoggerExtension() as ExtensionFactory)({ on: vi.fn() } as never);
    expect(mountPiEventLogger).toHaveBeenCalledTimes(1);
  });
});
