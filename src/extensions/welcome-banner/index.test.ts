import { describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createWelcomeBannerExtension } from "./index";

vi.mock("../../tui/welcome-banner", () => ({
  mountWelcomeBanner: vi.fn(),
}));

import { mountWelcomeBanner } from "../../tui/welcome-banner";

describe("createWelcomeBannerExtension", () => {
  it("mounts the welcome banner on the extension api", async () => {
    await (createWelcomeBannerExtension() as ExtensionFactory)({ on: vi.fn() } as never);
    expect(mountWelcomeBanner).toHaveBeenCalledTimes(1);
  });
});
