import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHtmlPreview, HTML_SOURCE_MAX_BYTES, readHtmlPreviewSource, releaseHtmlPreview } from "./html-preview";
import { mediaPreviewUrl } from "./preview-routes";
import { ApiError, RawFileSizeError, requestVoid } from "./transport";

afterEach(() => vi.unstubAllGlobals());

const capability = { id: "opaque-id_123", url: "/api/file/preview/opaque-id_123/%E6%8A%A5%E5%91%8A%20%231.HTML" };

describe("HTML preview API", () => {
  it("creates a validated same-origin capability through a trusted JSON POST and releases with DELETE", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(capability))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await expect(createHtmlPreview("/p/报告 #1.HTML")).resolves.toEqual(capability);
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/file/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/p/报告 #1.HTML" }),
    });
    await expect(releaseHtmlPreview(capability.id)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenNthCalledWith(2, `/api/file/preview/${capability.id}`, {
      method: "DELETE",
      keepalive: true,
    });
  });

  it.each([
    null,
    { id: "abc" },
    { id: "../status", url: "/api/file/preview/../status/report.html" },
    { id: "abc", url: "https://example.com/api/file/preview/abc/report.html" },
    { id: "abc", url: "//example.com/api/file/preview/abc/report.html" },
    { id: "abc", url: "/api/file/preview/other/report.html" },
    { id: "abc", url: "/api/file/preview/abc/../report.html" },
    { id: "abc", url: "/api/file/preview/abc/%2e%2e%2freport.html" },
    { id: "abc", url: "/api/file/preview/abc/%5Creport.html" },
    { id: "abc", url: "/api/file/preview/abc/%00report.html" },
    { id: "abc", url: "/api/file/preview/abc/%.html" },
    { id: "abc", url: "/api/file/preview/abc/report.html?path=/private" },
    { id: "abc", url: "/api/file/preview/abc/report.html#fragment" },
    { id: "abc", url: "/api/file/preview/abc/file.txt" },
  ])("rejects malformed or navigable capability responses: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(body)));
    await expect(createHtmlPreview("/p/report.html")).rejects.toMatchObject({ status: 502 });
  });

  it("rejects an empty create response and retains typed HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(Response.json({ code: "FILE_NOT_FOUND", error: "Missing report" }, { status: 404 })),
    );
    await expect(createHtmlPreview("/p/report.html")).rejects.toMatchObject({ status: 502 });
    await expect(createHtmlPreview("/p/missing.html")).rejects.toMatchObject({
      status: 404,
      details: { code: "FILE_NOT_FOUND" },
    });
  });

  it("shares slow-request admission through creation body completion while control remains available", async () => {
    let finish!: (value: unknown) => void;
    const body = new Promise((resolve) => {
      finish = resolve;
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => body })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => body })
      .mockImplementation(async (_path: string, init?: RequestInit) =>
        init?.method === "POST" ? Response.json(capability) : new Response(null, { status: 204 }),
      );
    vi.stubGlobal("fetch", fetch);
    const pending = [createHtmlPreview("/p/a.html"), createHtmlPreview("/p/b.html"), createHtmlPreview("/p/c.html")];
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await requestVoid("/api/sessions/test/abort", { method: "POST" });
    expect(fetch).toHaveBeenCalledTimes(3);
    finish(capability);
    await Promise.all(pending);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("reads complete explicit source beyond the text cap through raw bytes, with cancellation and revision", async () => {
    const source = `${"x".repeat(1024 * 1024)}<script>still source</script>\n报告`;
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValueOnce(new Response(source));
    vi.stubGlobal("fetch", fetch);
    await expect(
      readHtmlPreviewSource("/p/report.html", { revision: 7, attempt: 2, signal: controller.signal }),
    ).resolves.toBe(source);
    expect(fetch).toHaveBeenCalledWith(mediaPreviewUrl("/p/report.html", 7, 2), {
      method: "GET",
      signal: controller.signal,
    });
  });

  it("refuses declared oversized source before consuming the body", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const arrayBuffer = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "Content-Length": String(HTML_SOURCE_MAX_BYTES + 1) }),
        body: { cancel },
        arrayBuffer,
      }),
    );
    await expect(readHtmlPreviewSource("/p/big.html")).rejects.toBeInstanceOf(RawFileSizeError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("refuses an oversized actual source and propagates missing-file and abort errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(new Uint8Array(HTML_SOURCE_MAX_BYTES + 1)))
        .mockResolvedValueOnce(Response.json({ error: "Missing file" }, { status: 404 })),
    );
    await expect(readHtmlPreviewSource("/p/big.html")).rejects.toBeInstanceOf(RawFileSizeError);
    await expect(readHtmlPreviewSource("/p/gone.html")).rejects.toBeInstanceOf(ApiError);
    const controller = new AbortController();
    controller.abort();
    await expect(readHtmlPreviewSource("/p/report.html", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
