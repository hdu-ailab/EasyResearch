import { describe, expect, it, vi } from "vitest";
import {
  isSettingsHostRoute,
  parseHashRoute,
  resolveWorkSession,
  routeToHash,
  sameHostRoute,
  withoutSettings,
  withSettings,
} from "./router";

describe("parseHashRoute", () => {
  it("maps every built-in base page", () => {
    expect(parseHashRoute("")).toEqual({ page: "home" });
    expect(parseHashRoute("#")).toEqual({ page: "home" });
    expect(parseHashRoute("#/")).toEqual({ page: "home" });
    expect(parseHashRoute("#/config")).toEqual({ page: "config", returnTo: null });
  });

  it("parses canonical and legacy Settings routes over Home", () => {
    expect(parseHashRoute("#/?settings=1")).toEqual({ page: "home", settingsOpen: true });
    expect(parseHashRoute("#/settings")).toEqual({ page: "home", settingsOpen: true });
    expect(routeToHash({ page: "home", settingsOpen: true })).toBe("#/?settings=1");
  });

  it("parses a work route with an encoded cwd", () => {
    expect(parseHashRoute("#/work/s-1?cwd=%2Fhome%2Fpaper")).toEqual({
      page: "work",
      session: { id: "s-1", cwd: "/home/paper" },
    });
  });

  it("round-trips Settings over Work without changing cwd", () => {
    const route = {
      page: "work",
      session: { id: "s 1", cwd: "/a b?c=1&d" },
      settingsOpen: true,
    } as const;
    const hash = routeToHash(route);
    expect(hash).toBe("#/work/s%201?cwd=%2Fa%20b%3Fc%3D1%26d&settings=1");
    expect(parseHashRoute(hash)).toEqual(route);
  });

  it("rejects malformed work routes", () => {
    expect(parseHashRoute("#/work")).toBeNull();
    expect(parseHashRoute("#/work/")).toBeNull();
    expect(parseHashRoute("#/work/s-1")).toBeNull();
    expect(parseHashRoute("#/work/s-1?cwd=")).toBeNull();
    expect(parseHashRoute("#/work/%E0%A4%A")).toBeNull();
    expect(parseHashRoute("#/other")).toBeNull();
  });

  it.each([
    "#/?settings=0",
    "#/?settings=1&settings=1",
    "#/?extra=1",
    "#/work/s-1?cwd=%2Fpaper&cwd=%2Fother",
    "#/work/s-1?cwd=%2Fpaper&settings=0",
    "#/work/s-1?cwd=%2Fpaper&settings=1&settings=1",
    "#/work/s-1?cwd=%2Fpaper&extra=1",
  ])("rejects a non-canonical Home or Work query %s", (hash) => {
    expect(parseHashRoute(hash)).toBeNull();
  });

  it("accepts a hash without the leading #", () => {
    expect(parseHashRoute("/settings")).toEqual({ page: "home", settingsOpen: true });
  });

  it("round-trips one strict Config returnTo target", () => {
    const returnTo = { page: "home", settingsOpen: true } as const;
    const hash = routeToHash({ page: "config", returnTo });
    expect(hash).toBe("#/config?returnTo=%23%2F%3Fsettings%3D1");
    expect(parseHashRoute(hash)).toEqual({ page: "config", returnTo });
  });

  it.each([
    "#/config?returnTo=%23%2Fsettings",
    "#/config?returnTo=%23%2Fconfig",
    "#/config?returnTo=%23%2F%3Fsettings%3D%2531",
    "#/config?returnTo=%23%2F%3Fsettings%3D1&returnTo=%23%2F%3Fsettings%3D1",
    "#/config?returnTo=%23%2F%3Fsettings%3D1&extra=1",
  ])("keeps Config mounted but rejects invalid return target %s", (hash) => {
    expect(parseHashRoute(hash)).toEqual({ page: "config", returnTo: null });
  });
});

describe("routeToHash", () => {
  it("serializes every page", () => {
    expect(routeToHash({ page: "home" })).toBe("#/");
    expect(routeToHash({ page: "config", returnTo: null })).toBe("#/config");
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

describe("Settings host route helpers", () => {
  const work = { page: "work", session: { id: "s-1", cwd: "/paper" } } as const;

  it("adds and removes Settings without changing the host", () => {
    expect(withSettings({ page: "home" })).toEqual({ page: "home", settingsOpen: true });
    expect(withSettings(work)).toEqual({ ...work, settingsOpen: true });
    expect(withoutSettings({ page: "home", settingsOpen: true })).toEqual({ page: "home" });
    expect(withoutSettings({ ...work, settingsOpen: true })).toEqual(work);
  });

  it("recognizes only Home and Work routes with Settings open", () => {
    expect(isSettingsHostRoute({ page: "home", settingsOpen: true })).toBe(true);
    expect(isSettingsHostRoute({ ...work, settingsOpen: true })).toBe(true);
    expect(isSettingsHostRoute({ page: "home" })).toBe(false);
    expect(isSettingsHostRoute(work)).toBe(false);
    expect(isSettingsHostRoute({ page: "config", returnTo: null })).toBe(false);
  });

  it("compares host identity while ignoring Settings state", () => {
    expect(sameHostRoute({ page: "home" }, { page: "home", settingsOpen: true })).toBe(true);
    expect(sameHostRoute(work, { ...work, settingsOpen: true })).toBe(true);
    expect(sameHostRoute(work, { page: "work", session: { id: "s-2", cwd: "/paper" } })).toBe(false);
    expect(sameHostRoute(work, { page: "work", session: { id: "s-1", cwd: "/other" } })).toBe(false);
    expect(sameHostRoute({ page: "home" }, work)).toBe(false);
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

  it("falls back to the URL identity when listing or opening fails", async () => {
    const failing = deps();
    failing.listStatus.mockRejectedValue(new Error("server down"));
    expect(await resolveWorkSession("s-1", "/p", failing)).toEqual({ id: "s-1", cwd: "/p" });

    const opening = deps({
      status: { sessions: [{ id: "s-1", path: "/store/s-1.jsonl" }] },
    });
    opening.openSession.mockRejectedValue(new Error("unknown"));
    expect(await resolveWorkSession("s-1", "/p", opening)).toEqual({ id: "s-1", cwd: "/p" });
  });
});
