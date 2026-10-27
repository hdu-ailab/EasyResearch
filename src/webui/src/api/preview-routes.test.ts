import { describe, expect, it } from "vitest";
import { mediaPreviewUrl, previewRoutes } from "./preview-routes";
import { routes } from "./routes";

describe("preview routes", () => {
  it("keeps creation/release same-origin and encodes the release identity", () => {
    expect(previewRoutes.create()).toBe("/api/file/preview");
    expect(previewRoutes.release("a/b?#")).toBe(`${previewRoutes.create()}/a%2Fb%3F%23`);
  });

  it("keeps raw path bytes and makes watcher-after-retry sources distinct", () => {
    const path = String.raw`D:\papers\报告 #1.MP4`;
    const first = mediaPreviewUrl(path, 0);
    const retry = mediaPreviewUrl(path, 0, 1);
    const updated = mediaPreviewUrl(path, 1);
    expect(first).toBe(routes.rawFile(path, 0));
    expect(new Set([first, retry, updated]).size).toBe(3);
    for (const source of [first, retry, updated]) {
      expect(source.startsWith("/")).toBe(true);
      const url = new URL(source, "http://forwarded.local:9090");
      expect(url.pathname).toBe("/api/file/raw");
      expect(url.searchParams.get("path")).toBe(path);
      expect([...url.searchParams.keys()]).toEqual(["path", "revision"]);
    }
  });
});
