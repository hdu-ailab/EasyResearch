import { describe, expect, it, vi } from "vitest";
import { checkNpmUpdate, isNewerVersion, NPM_LATEST_URL } from "./update-check";

describe("npm update check", () => {
  it.each([
    ["0.0.62", "0.0.61"],
    ["0.1.0", "0.0.99"],
    ["1.0.0", "0.99.99"],
    ["1.0.0", "1.0.0-rc.1"],
    ["1.0.0-rc.2", "1.0.0-rc.1"],
  ])("recognizes %s as newer than %s", (candidate, current) => {
    expect(isNewerVersion(candidate, current)).toBe(true);
  });

  it.each([
    ["0.0.61", "0.0.61"],
    ["0.0.60", "0.0.61"],
    ["1.0.0-rc.1", "1.0.0"],
    ["latest", "1.0.0"],
    ["1.0.1", "dev"],
  ])("does not treat %s as newer than %s", (candidate, current) => {
    expect(isNewerVersion(candidate, current)).toBe(false);
  });

  it("returns only a newer npm latest version", async () => {
    const fetchLatest = vi.fn(async () => new Response(JSON.stringify({ version: "0.0.62" }), { status: 200 }));

    await expect(checkNpmUpdate("0.0.61", { fetch: fetchLatest })).resolves.toEqual({ latestVersion: "0.0.62" });
    expect(fetchLatest).toHaveBeenCalledWith(
      NPM_LATEST_URL,
      expect.objectContaining({ headers: { Accept: "application/json" }, signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    [new Response(JSON.stringify({ version: "0.0.61" }), { status: 200 })],
    [new Response(JSON.stringify({ version: "not-semver" }), { status: 200 })],
    [new Response(JSON.stringify({ name: "easyresearch" }), { status: 200 })],
    [new Response("unavailable", { status: 503 })],
  ])("silently returns null for no-update or unusable responses", async (response) => {
    await expect(checkNpmUpdate("0.0.61", { fetch: async () => response })).resolves.toEqual({
      latestVersion: null,
    });
  });

  it("silently returns null when the registry request fails", async () => {
    await expect(
      checkNpmUpdate("0.0.61", {
        fetch: async () => {
          throw new Error("offline");
        },
      }),
    ).resolves.toEqual({ latestVersion: null });
  });
});
