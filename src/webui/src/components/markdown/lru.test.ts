import { describe, expect, it } from "vitest";
import { LruCache } from "./lru";

describe("LruCache", () => {
  it("promotes a hit and evicts the least recently used entry", () => {
    const evicted: string[] = [];
    const cache = new LruCache<string, number>(2, (key) => evicted.push(key));
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.size).toBe(2);
    expect(evicted).toEqual(["b"]);
  });

  it("rejects invalid capacity and supports delete and clear", () => {
    expect(() => new LruCache(0)).toThrow("capacity");
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    expect(cache.delete("a")).toBe(true);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
