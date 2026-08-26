import { describe, expect, it, vi } from "vitest";
import { parseHashRoute, resolveWorkSession, routeToHash } from "./router";

describe("parseHashRoute", () => {
  it("maps every built-in page", () => {
    expect(parseHashRoute("")).toEqual({ page: "home" });
    expect(parseHashRoute("#")).toEqual({ page: "home" });
    expect(parseHashRoute("#/")).toEqual({ page: "home" });
    expect(parseHashRoute("#/settings")).toEqual({ page: "settings" });
    expect(parseHashRoute("#/config")).toEqual({ page: "config" });
  });

  it("parses a work route with an encoded cwd", () => {
    expect(parseHashRoute("#/work/s-1?cwd=%2Fhome%2Fpaper")).toEqual({
      page: "work",
      session: { id: "s-1", cwd: "/home/paper" },
    });
  });

  it("rejects malformed work routes", () => {
    expect(parseHashRoute("#/work")).toBeNull();
    expect(parseHashRoute("#/work/")).toBeNull();
    expect(parseHashRoute("#/work/s-1")).toBeNull();
    expect(parseHashRoute("#/work/s-1?cwd=")).toBeNull();
    expect(parseHashRoute("#/work/%E0%A4%A")).toBeNull();
    expect(parseHashRoute("#/other")).toBeNull();
  });

  it("accepts a hash without the leading #", () => {
    expect(parseHashRoute("/settings")).toEqual({ page: "settings" });
  });
});

describe("routeToHash", () => {
  it("serializes every page", () => {
    expect(routeToHash({ page: "home" })).toBe("#/");
    expect(routeToHash({ page: "settings" })).toBe("#/settings");
    expect(routeToHash({ page: "config" })).toBe("#/config");
    expect(routeToHash({ page: "work", session: { id: "s-1", cwd: "/a/b" } })).toBe("#/work/s-1?cwd=%2Fa%2Fb");
  });

  it("round-trips a cwd with URL-sensitive characters", () => {
    const hash = routeToHash({ page: "work", session: { id: "s 1", cwd: "/a b?c=1&d" } });
    expect(parseHashRoute(hash)).toEqual({
      page: "work",
      session: { id: "s 1", cwd: "/a b?c=1&d" },
    });
  });
});

describe("resolveWorkSession", () => {
  const deps = (overrides: Partial<{ status: unknown; open: unknown }> = {}) => {
    const listStatus = vi.fn().mockResolvedValue(overrides.status ?? { sessions: [] });
    const openSession = vi.fn().mockResolvedValue(overrides.open ?? { id: "s-1", cwd: "/p" });
    return { listStatus, openSession };
  };

  it("opens the persisted session by id from the status listing", async () => {
    const d = deps({
      status: { sessions: [{ id: "s-1", path: "/store/s-1.jsonl" }] },
      open: { id: "s-1", cwd: "/p" },
    });
    const session = await resolveWorkSession("s-1", "/fallback", d);
    expect(d.openSession).toHaveBeenCalledWith("/store/s-1.jsonl");
    expect(session).toEqual({ id: "s-1", cwd: "/p" });
  });

  it("returns the URL identity when the session is not persisted yet", async () => {
    const d = deps();
    const session = await resolveWorkSession("fresh-1", "/p", d);
    expect(d.openSession).not.toHaveBeenCalled();
    expect(session).toEqual({ id: "fresh-1", cwd: "/p" });
  });

  it("falls back to the URL identity when session listing fails", async () => {
    const failing = deps();
    failing.listStatus.mockRejectedValue(new Error("server down"));
    expect(await resolveWorkSession("s-1", "/p", failing)).toEqual({ id: "s-1", cwd: "/p" });
  });

  it("propagates a persisted-session open failure", async () => {
    const opening = deps({
      status: { sessions: [{ id: "s-1", path: "/store/s-1.jsonl" }] },
    });
    opening.openSession.mockRejectedValue(new Error("unknown"));
    await expect(resolveWorkSession("s-1", "/p", opening)).rejects.toThrow("unknown");
  });
});
