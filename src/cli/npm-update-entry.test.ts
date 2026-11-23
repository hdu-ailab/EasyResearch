import { describe, expect, it } from "vitest";
import { parseNpmUpdateServeRequest, prepareNpmUpdateBoot } from "./npm-update-entry";

describe("new-version first-run admission", () => {
  it("rejects an arbitrary entry shape or non-exact version", () => {
    expect(() => parseNpmUpdateServeRequest(["--update-serve", "localhost", "3000", "latest", "a".repeat(64)])).toThrow();
    expect(() => parseNpmUpdateServeRequest(["--update-serve", "localhost", "3000", "2.0.0", "a".repeat(64), "extra"])).toThrow();
  });
  it("verifies the exact artifact and runs first-use setup before runtime assets or Pi startup", async () => {
    const steps: string[] = [];
    const request = parseNpmUpdateServeRequest(["--update-serve", "127.0.0.1", "3000", "2.0.0", "a".repeat(64)]);
    await prepareNpmUpdateBoot(request, "/isolated/agent", {
      version: "2.0.0", embedded: true, executable: "/owned/candidate",
      verify: async () => { steps.push("verify"); },
      setup: (_root, options) => { expect(options.skipSetup).toBe(false); steps.push("setup"); },
      copyAssets: () => { steps.push("assets"); },
    });
    expect(steps).toEqual(["verify", "setup", "assets"]);
    await expect(prepareNpmUpdateBoot(request, "/isolated/agent", { version: "1.0.0", embedded: true, executable: "/owned/old", verify: async () => {}, setup: () => { throw new Error("must not run"); }, copyAssets: () => {} })).rejects.toThrow(/version/i);
  });
});
