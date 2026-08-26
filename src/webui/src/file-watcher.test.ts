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

  it("accepts Windows drive events without crossing a sibling prefix", () => {
    expect(
      parseFileWatcherEvent(
        { type: "file.watcher.updated", properties: { file: String.raw`D:\papers\notes.md`, event: "change" } },
        String.raw`D:\papers`,
      ),
    ).toEqual({
      type: "file.watcher.updated",
      properties: { file: String.raw`D:\papers\notes.md`, event: "change" },
    });
    expect(
      parseFileWatcherEvent(
        { type: "file.watcher.updated", properties: { file: String.raw`D:\papers-old\notes.md`, event: "change" } },
        String.raw`D:\papers`,
      ),
    ).toBeNull();
  });

  it("accepts UNC share events and rejects their .git directory", () => {
    const root = String.raw`\\server\share\paper`;
    expect(
      parseFileWatcherEvent(
        { type: "file.watcher.updated", properties: { file: String.raw`\\server\share\paper\draft.md`, event: "add" } },
        root,
      ),
    ).toEqual({
      type: "file.watcher.updated",
      properties: { file: String.raw`\\server\share\paper\draft.md`, event: "add" },
    });
    expect(
      parseFileWatcherEvent(
        {
          type: "file.watcher.updated",
          properties: { file: String.raw`\\server\share\paper\.git\index`, event: "change" },
        },
        root,
      ),
    ).toBeNull();
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

  it("computes drive and UNC parents without leaving their roots", () => {
    expect(parentPath(String.raw`D:\papers\draft.md`)).toBe(String.raw`D:\papers`);
    expect(parentPath(String.raw`D:\papers`)).toBe("D:\\");
    expect(parentPath("D:\\")).toBe("D:\\");
    expect(parentPath(String.raw`\\server\share\paper`)).toBe("\\\\server\\share\\");
    expect(parentPath("\\\\server\\share\\")).toBe("\\\\server\\share\\");
  });
});
