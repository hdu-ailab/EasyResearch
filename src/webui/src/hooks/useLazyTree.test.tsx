import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useLazyTree } from "./useLazyTree";

interface Entry {
  path: string;
  name: string;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const folder = (path: string): Entry => ({ path, name: path.split("/").pop() ?? path });

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useLazyTree", () => {
  it("reports loading for the root and unloaded for untouched children", async () => {
    const pending = deferred<Entry[]>();
    const { result } = renderHook(() => useLazyTree({ root: "/p", loadChildren: vi.fn(() => pending.promise) }));
    expect(result.current.status("/p")).toBe("loading");
    expect(result.current.status("/p/folder")).toBe("unloaded");
    await act(() => pending.resolve([{ path: "/p/folder", name: "folder" }]));
    expect(result.current.status("/p")).toBe("loaded");
  });

  it("surfaces an error state after rejection and recovers on retry", async () => {
    const loadChildren = vi.fn(async (path: string): Promise<Entry[]> => {
      if (path === "/p/folder") throw new Error("boom");
      return [folder("/p/folder")];
    });
    const { result } = renderHook(() => useLazyTree({ root: "/p", loadChildren }));
    await settle();
    act(() => result.current.toggle("/p/folder"));
    await settle();
    expect(result.current.status("/p/folder")).toBe("error");
    expect(result.current.error("/p/folder")).toBe("boom");
    loadChildren.mockImplementation(async (path: string): Promise<Entry[]> => {
      if (path === "/p/folder") return [folder("/p/folder/nested")];
      return [folder("/p/folder")];
    });
    act(() => result.current.retry("/p/folder"));
    await settle();
    expect(result.current.status("/p/folder")).toBe("loaded");
    expect(result.current.children("/p/folder")).toEqual([folder("/p/folder/nested")]);
  });

  it("only issues one request per expansion", async () => {
    const loadChildren = vi.fn(async (path: string): Promise<Entry[]> => {
      if (path === "/p") return [folder("/p/folder")];
      return [];
    });
    const { result } = renderHook(() => useLazyTree({ root: "/p", loadChildren }));
    await settle();
    act(() => result.current.toggle("/p/folder"));
    await settle();
    expect(loadChildren).toHaveBeenCalledTimes(2);
    act(() => result.current.toggle("/p/folder"));
    act(() => result.current.toggle("/p/folder"));
    await settle();
    expect(loadChildren).toHaveBeenCalledTimes(2);
  });

  it("issues only one request per path under rapid batched toggles", async () => {
    const pending = deferred<Entry[]>();
    const loadChildren = vi.fn(async (path: string): Promise<Entry[]> => {
      if (path === "/p") return [folder("/p/folder")];
      return pending.promise;
    });
    const { result } = renderHook(() => useLazyTree({ root: "/p", loadChildren }));
    await settle();
    act(() => {
      result.current.toggle("/p/folder");
      result.current.toggle("/p/folder");
      result.current.toggle("/p/folder");
    });
    await settle();
    expect(loadChildren).toHaveBeenCalledTimes(2);
    expect(result.current.status("/p/folder")).toBe("loading");
    await act(() => pending.resolve([folder("/p/folder/nested")]));
    expect(result.current.status("/p/folder")).toBe("loaded");
    expect(result.current.expanded.has("/p/folder")).toBe(true);
  });

  it("refresh clears expanded state for the invalidated subtree", async () => {
    const loadChildren = vi.fn(async (path: string): Promise<Entry[]> => {
      if (path === "/p") return [folder("/p/a")];
      if (path === "/p/a") return [folder("/p/a/b")];
      if (path === "/p/a/b") return [folder("/p/a/b/leaf")];
      return [];
    });
    const { result } = renderHook(() => useLazyTree({ root: "/p", loadChildren }));
    await settle();
    act(() => result.current.toggle("/p/a"));
    act(() => result.current.toggle("/p/a/b"));
    await settle();
    expect(result.current.status("/p/a/b")).toBe("loaded");
    expect(result.current.expanded.has("/p/a")).toBe(true);
    expect(result.current.expanded.has("/p/a/b")).toBe(true);
    act(() => result.current.refresh("/p/a"));
    await settle();
    expect(result.current.status("/p/a")).toBe("loaded");
    expect(result.current.status("/p/a/b")).toBe("unloaded");
    expect(result.current.expanded.has("/p/a")).toBe(false);
    expect(result.current.expanded.has("/p/a/b")).toBe(false);
  });

  it("converts a synchronous loadChildren throw into an error state", async () => {
    const loadChildren = vi.fn((path: string): Promise<Entry[]> => {
      if (path === "/p/folder") throw new Error("sync boom");
      return Promise.resolve([folder("/p/folder")]);
    });
    const { result } = renderHook(() => useLazyTree({ root: "/p", loadChildren }));
    await settle();
    act(() => result.current.toggle("/p/folder"));
    await settle();
    expect(result.current.status("/p/folder")).toBe("error");
    expect(result.current.error("/p/folder")).toBe("sync boom");
    loadChildren.mockImplementation(async (path: string): Promise<Entry[]> => {
      if (path === "/p/folder") return [folder("/p/folder/nested")];
      return [folder("/p/folder")];
    });
    act(() => result.current.retry("/p/folder"));
    await settle();
    expect(result.current.status("/p/folder")).toBe("loaded");
    expect(result.current.children("/p/folder")).toEqual([folder("/p/folder/nested")]);
  });

  it("refresh invalidates the subtree while retaining siblings", async () => {
    const loadChildren = vi.fn(async (path: string): Promise<Entry[]> => {
      if (path === "/p") return [folder("/p/a"), folder("/p/c")];
      if (path === "/p/a") return [folder("/p/a/b")];
      if (path === "/p/a/b") return [folder("/p/a/b/leaf")];
      return [];
    });
    const { result } = renderHook(() => useLazyTree({ root: "/p", loadChildren }));
    await settle();
    act(() => result.current.toggle("/p/a"));
    act(() => result.current.toggle("/p/c"));
    act(() => result.current.toggle("/p/a/b"));
    await settle();
    expect(result.current.status("/p/a/b")).toBe("loaded");
    act(() => result.current.refresh("/p/a"));
    await settle();
    expect(result.current.status("/p/a")).toBe("loaded");
    expect(result.current.status("/p/a/b")).toBe("unloaded");
    expect(result.current.status("/p/c")).toBe("loaded");
  });

  it("refresh invalidates a Windows subtree while retaining prefix siblings", async () => {
    const root = String.raw`D:\project`;
    const branch = String.raw`D:\project\a`;
    const nested = String.raw`D:\project\a\b`;
    const sibling = String.raw`D:\project\a-old`;
    const loadChildren = vi.fn(async (path: string): Promise<Entry[]> => {
      if (path === root)
        return [
          { path: branch, name: "a" },
          { path: sibling, name: "a-old" },
        ];
      if (path === branch) return [{ path: nested, name: "b" }];
      return [];
    });
    const { result } = renderHook(() => useLazyTree({ root, loadChildren }));
    await settle();
    act(() => {
      result.current.toggle(branch);
      result.current.toggle(nested);
      result.current.toggle(sibling);
    });
    await settle();

    act(() => result.current.refresh(branch));
    await settle();

    expect(result.current.status(nested)).toBe("unloaded");
    expect(result.current.status(sibling)).toBe("loaded");
  });

  it("refreshes one loaded directory without collapsing it or its siblings", async () => {
    let aChildren = [folder("/p/a/old")];
    const loadChildren = vi.fn(async (path: string): Promise<Entry[]> => {
      if (path === "/p") return [folder("/p/a"), folder("/p/c")];
      if (path === "/p/a") return aChildren;
      return [];
    });
    const { result } = renderHook(() => useLazyTree({ root: "/p", loadChildren }));
    await settle();
    act(() => {
      result.current.toggle("/p/a");
      result.current.toggle("/p/c");
    });
    await settle();
    expect(result.current.expanded.has("/p/a")).toBe(true);
    expect(result.current.expanded.has("/p/c")).toBe(true);

    aChildren = [folder("/p/a/new")];
    act(() => result.current.refreshDirectory("/p/a"));
    await settle();

    expect(result.current.children("/p/a")).toEqual([folder("/p/a/new")]);
    expect(result.current.status("/p/c")).toBe("loaded");
    expect(result.current.expanded.has("/p/a")).toBe(true);
    expect(result.current.expanded.has("/p/c")).toBe(true);
  });

  it("queues a targeted refresh requested while the directory is loading", async () => {
    const pending = deferred<Entry[]>();
    let folderChildren = [folder("/p/folder/old")];
    let folderLoads = 0;
    const loadChildren = vi.fn((path: string): Promise<Entry[]> => {
      if (path === "/p") return Promise.resolve([folder("/p/folder")]);
      folderLoads += 1;
      return folderLoads === 1 ? pending.promise : Promise.resolve(folderChildren);
    });
    const { result } = renderHook(() => useLazyTree({ root: "/p", loadChildren }));
    await settle();
    act(() => result.current.toggle("/p/folder"));
    expect(result.current.status("/p/folder")).toBe("loading");

    folderChildren = [folder("/p/folder/new")];
    act(() => result.current.refreshDirectory("/p/folder"));
    await act(async () => pending.resolve([folder("/p/folder/old")]));
    await settle();

    expect(result.current.children("/p/folder")).toEqual([folder("/p/folder/new")]);
    expect(loadChildren).toHaveBeenCalledTimes(3);
  });

  it("ignores stale resolutions after the root changes", async () => {
    const pendingOldRoot = deferred<Entry[]>();
    const loadChildren = vi.fn((path: string): Promise<Entry[]> => {
      if (path === "/old") return pendingOldRoot.promise;
      return Promise.resolve([folder("/new/child")]);
    });
    const { result, rerender } = renderHook(({ root }: { root: string }) => useLazyTree({ root, loadChildren }), {
      initialProps: { root: "/old" },
    });
    expect(result.current.status("/old")).toBe("loading");
    rerender({ root: "/new" });
    await settle();
    expect(result.current.status("/new")).toBe("loaded");
    await act(() => pendingOldRoot.resolve([folder("/old/child")]));
    expect(result.current.status("/old")).toBe("unloaded");
  });
});
