import { describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createProjectTrustExtension } from "./index";

describe("createProjectTrustExtension", () => {
  it("answers project_trust with yes (ADR-018)", async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const api = {
      on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
    };
    await (createProjectTrustExtension() as ExtensionFactory)(api as never);

    expect(handlers.get("project_trust")?.()).toEqual({ trusted: "yes" });
  });
});
