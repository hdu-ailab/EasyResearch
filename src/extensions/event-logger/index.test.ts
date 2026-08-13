import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createEventLoggerExtension } from "./index";

vi.mock("../../runtime/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../runtime/pi-event-logger", () => ({
  mountPiEventLogger: vi.fn(),
}));

import { mountPiEventLogger } from "../../runtime/pi-event-logger";

afterEach(() => {
  delete process.env.EASYRESEARCH_RPC_CHILD;
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createEventLoggerExtension", () => {
  it("mounts the pi event logger for non-RPC runtimes", async () => {
    delete process.env.EASYRESEARCH_RPC_CHILD;
    await (createEventLoggerExtension() as ExtensionFactory)({ on: vi.fn() } as never);
    expect(mountPiEventLogger).toHaveBeenCalledTimes(1);
  });

  it("skips mounting inside RPC children", async () => {
    process.env.EASYRESEARCH_RPC_CHILD = "1";
    await (createEventLoggerExtension() as ExtensionFactory)({ on: vi.fn() } as never);
    expect(mountPiEventLogger).not.toHaveBeenCalled();
  });
});
