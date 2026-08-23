import { describe, expect, it, vi } from "vitest";
import {
  checkDesktopUpdate,
  compareSemanticVersions,
  parseSemanticVersion,
} from "./update";

describe("semantic versions", () => {
  it.each([
    ["1.2.4", "1.2.3", 1],
    ["2.0.0", "10.0.0", -1],
    ["1.2.3", "1.2.3", 0],
    ["1.2.3", "1.2.3-beta.2", 1],
    ["1.2.3-beta.10", "1.2.3-beta.2", 1],
    ["1.2.3-alpha", "1.2.3-beta", -1],
  ])("compares %s against %s", (left, right, expected) => {
    expect(compareSemanticVersions(left, right)).toBe(expected);
  });

  it.each(["1.2", "01.2.3", "1.2.3-01", "v1.2.3 garbage"])(
    "rejects malformed semantic version %s",
    (version) => expect(() => parseSemanticVersion(version)).toThrow(/semantic version/i),
  );
});

describe("desktop update check", () => {
  it("returns only a strictly newer validated repository release", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("accept")).toContain("application/vnd.github+json");
      expect(new Headers(init?.headers).get("user-agent")).toContain("EasyResearch");
      return new Response(JSON.stringify({
        tag_name: "v1.3.0",
        html_url: "https://github.com/hdu-ailab/EasyResearch/releases/tag/v1.3.0",
      }), { status: 200 });
    });

    await expect(checkDesktopUpdate("1.2.3", { fetch })).resolves.toEqual({
      version: "1.3.0",
      url: "https://github.com/hdu-ailab/EasyResearch/releases/tag/v1.3.0",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/hdu-ailab/EasyResearch/releases/latest",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns null for the current or an older release", async () => {
    for (const tag_name of ["v1.2.3", "v1.2.2"]) {
      await expect(checkDesktopUpdate("1.2.3", {
        fetch: async () => new Response(JSON.stringify({
          tag_name,
          html_url: `https://github.com/hdu-ailab/EasyResearch/releases/tag/${tag_name}`,
        }), { status: 200 }),
      })).resolves.toBeNull();
    }
  });

  it("rejects a release URL outside the exact GitHub repository", async () => {
    for (const html_url of [
      "https://example.com/EasyResearch/v1.3.0",
      "https://github.com:444/hdu-ailab/EasyResearch/releases/tag/v1.3.0",
      "https://github.com/hdu-ailab/EasyResearch/releases/tag/v9.9.9",
    ]) {
      await expect(checkDesktopUpdate("1.2.3", {
        fetch: async () => new Response(JSON.stringify({
          tag_name: "v1.3.0",
          html_url,
        }), { status: 200 }),
      })).rejects.toThrow(/release URL/i);
    }
  });
});
