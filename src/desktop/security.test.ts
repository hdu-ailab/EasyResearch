import { describe, expect, it } from "vitest";
import { DESKTOP_ACCESS_HEADER } from "./contracts";
import {
  desktopPermissionAllowed,
  desktopRequestHeaders,
  navigationDecision,
} from "./security";

describe("desktop request authentication", () => {
  it("adds renderer auth only to the exact ready origin", () => {
    expect(desktopRequestHeaders(
      "http://127.0.0.1:43123/api/status",
      "http://127.0.0.1:43123",
      "renderer-secret",
      { Accept: "application/json" },
    )).toEqual({
      Accept: "application/json",
      [DESKTOP_ACCESS_HEADER]: "renderer-secret",
    });

    expect(desktopRequestHeaders(
      "http://127.0.0.1:43124/api/status",
      "http://127.0.0.1:43123",
      "renderer-secret",
      { Accept: "application/json" },
    )).toEqual({ Accept: "application/json" });
  });

  it("does not add credentials to malformed or external request URLs", () => {
    for (const url of ["not-a-url", "https://example.com/", "file:///tmp/index.html"]) {
      expect(desktopRequestHeaders(
        url,
        "http://127.0.0.1:43123",
        "renderer-secret",
        { [DESKTOP_ACCESS_HEADER]: "must-not-leak" },
      )).not.toHaveProperty(DESKTOP_ACCESS_HEADER);
    }
  });
});

describe("desktop main-document permission policy", () => {
  const readyOrigin = "http://127.0.0.1:43123";
  const ownerWebContents = {};
  const context = {
    ownerWebContents,
    requestingWebContents: ownerWebContents,
    readyOrigin,
    ownerDocumentUrl: `${readyOrigin}/#/work/session?cwd=paper`,
    details: { isMainFrame: true, requestingUrl: `${readyOrigin}/` },
  };

  it.each(["fullscreen", "clipboard-sanitized-write"])("allows %s only for the owning main app document", (permission) => {
    for (const path of ["/", "/index.html"]) {
      expect(desktopPermissionAllowed({
        ...context, permission,
        ownerDocumentUrl: `${readyOrigin}${path}#/work/current`,
        details: { isMainFrame: true, requestingUrl: `${readyOrigin}${path}#/work/previous` },
      })).toBe(true);
    }
  });

  it.each(["clipboard-read", "clipboard-write", "deprecated-sync-clipboard-read", "media", "notifications", "automatic-fullscreen", "pointerLock", "unknown"])("denies %s on the main app as well", (permission) => {
    expect(desktopPermissionAllowed({ ...context, permission })).toBe(false);
  });

  it.each(["fullscreen", "clipboard-sanitized-write"])("denies %s for every subframe, including a same-origin root document", (permission) => {
    for (const requestingUrl of [`${readyOrigin}/`, `${readyOrigin}/api/file/preview/scope/report.html`, "about:blank"]) {
      expect(desktopPermissionAllowed({ ...context, permission, details: { isMainFrame: false, requestingUrl } })).toBe(false);
    }
  });

  it.each([undefined, null, {}, { isMainFrame: true }, { requestingUrl: `${readyOrigin}/` }])("rejects incomplete frame evidence %j", (details) => {
    expect(desktopPermissionAllowed({ ...context, permission: "fullscreen", details })).toBe(false);
  });

  it.each([null, undefined, {}])("rejects absent or foreign WebContents despite matching URLs", (requestingWebContents) => {
    expect(desktopPermissionAllowed({ ...context, permission: "fullscreen", requestingWebContents })).toBe(false);
  });

  it("does not treat two absent owners as an identity match", () => {
    expect(desktopPermissionAllowed({
      ...context, permission: "fullscreen", ownerWebContents: null, requestingWebContents: null,
    })).toBe(false);
  });

  it("also validates the check handler's native requesting origin, without using it as a URL fallback", () => {
    for (const requestingOrigin of [readyOrigin, `${readyOrigin}/`]) {
      expect(desktopPermissionAllowed({ ...context, permission: "fullscreen", requestingOrigin })).toBe(true);
      expect(desktopPermissionAllowed({
        ...context, permission: "fullscreen", requestingOrigin, details: { isMainFrame: true },
      })).toBe(false);
    }
    for (const requestingOrigin of ["null", "", "http://127.0.0.1:43124", `${readyOrigin}/index.html`, `${readyOrigin}/#route`]) {
      expect(desktopPermissionAllowed({ ...context, permission: "fullscreen", requestingOrigin })).toBe(false);
    }
  });

  it.each([
    "not-a-url", "about:blank", "data:text/html,app", `blob:${readyOrigin}/id`,
    `${readyOrigin}/api/file/preview/scope/report.html`, `${readyOrigin}/api/file/raw?path=report.html`,
    `${readyOrigin}/assets/report.html`, `${readyOrigin}/index.html?document=other`,
    "http://127.0.0.1:43124/", "http://localhost:43123/", "https://127.0.0.1:43123/",
    "http://user:password@127.0.0.1:43123/",
  ])("denies a non-app or non-ready document %s in either identity slot", (url) => {
    expect(desktopPermissionAllowed({
      ...context, permission: "fullscreen", details: { isMainFrame: true, requestingUrl: url },
    })).toBe(false);
    expect(desktopPermissionAllowed({ ...context, permission: "fullscreen", ownerDocumentUrl: url })).toBe(false);
  });

  it("rejects stale document identity even when both documents are valid app entry paths", () => {
    expect(desktopPermissionAllowed({
      ...context, permission: "fullscreen", details: { isMainFrame: true, requestingUrl: `${readyOrigin}/index.html` },
    })).toBe(false);
  });
});

describe("desktop navigation policy", () => {
  it("allows navigation only within the exact sidecar origin", () => {
    expect(navigationDecision(
      "http://127.0.0.1:43123/settings",
      "http://127.0.0.1:43123",
    )).toEqual({ kind: "allow" });
  });

  it("opens credential-free external HTTP links in the system browser", () => {
    expect(navigationDecision(
      "https://github.com/hdu-ailab/EasyResearch",
      "http://127.0.0.1:43123",
    )).toEqual({
      kind: "external",
      url: "https://github.com/hdu-ailab/EasyResearch",
    });
  });

  it.each([
    "javascript:alert(1)",
    "file:///tmp/secret",
    "https://user:password@example.com/",
    "not-a-url",
  ])("denies unsafe navigation %s", (url) => {
    expect(navigationDecision(url, "http://127.0.0.1:43123")).toEqual({ kind: "deny" });
  });
});
