import { describe, expect, it } from "vitest";
import { parentPath, parseFileWatcherEvent } from "./file-watcher";

describe("file watcher event parsing", () => {
  it("accepts valid in-root events", () => {
    expect(
      parseFileWatcherEvent(
        { type: "file.watcher.updated", properties: { file: "/p/notes.md", event: "change" } },
        "/p",
      ),
    ).toEqual({
      type: "file.watcher.updated",
      properties: { file: "/p/notes.md", event: "change" },
    });
  });

  it.each([
    null,
    {},
    { type: "other", properties: { file: "/p/a", event: "add" } },
    { type: "file.watcher.updated", properties: { file: "/p/a", event: "rename" } },
    { type: "file.watcher.updated", properties: { event: "add" } },
    { type: "file.watcher.updated", properties: { file: "/outside/a", event: "add" } },
    { type: "file.watcher.updated", properties: { file: "/p/.git/index", event: "add" } },
  ])("rejects malformed or unsafe event %#", (event) => {
    expect(parseFileWatcherEvent(event, "/p")).toBeNull();
  });

  it("computes immediate Unix parents", () => {
    expect(parentPath("/p/notes.md")).toBe("/p");
    expect(parentPath("/notes.md")).toBe("/");
    expect(parentPath("/")).toBe("/");
  });
});
