import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRawFileBytes } from "../api";
import { RawFileSizeError, requestBytes, requestVoid } from "./transport";

afterEach(() => vi.unstubAllGlobals());

function chunkedBody(chunks: Uint8Array[], cancel = vi.fn()) {
  let index = 0;
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    const chunk = chunks[index++];
    if (chunk) controller.enqueue(chunk);
    else controller.close();
  });
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  return { body, pull, cancel };
}

describe("bounded shared byte transport", () => {
  it("returns exact bytes across empty/offset chunks and buffer growth without trusting a smaller length header", async () => {
    const first = new Uint8Array(65_535).fill(7);
    const backing = new Uint8Array([111, 0, 255, 1, 222]);
    const tail = backing.subarray(1, 4);
    const expected = new Uint8Array([...first, ...tail]);
    const stream = chunkedBody([new Uint8Array(), first, new Uint8Array(), tail]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(stream.body, { headers: { "Content-Length": "1" } })),
    );

    const result = await readRawFileBytes("/p/report.docx", { maxBytes: expected.byteLength });

    expect(new Uint8Array(result)).toEqual(expected);
    expect(result.byteLength).toBe(expected.byteLength);
    expect(stream.cancel).not.toHaveBeenCalled();
    expect(stream.body.locked).toBe(false);
  });

  it.each([undefined, "1", "4"])(
    "cancels on the first over-limit chunk before EOF with Content-Length=%s",
    async (length) => {
      const stream = chunkedBody([
        new Uint8Array([1, 2]),
        new Uint8Array([3, 4]),
        new Uint8Array([5]),
        new Uint8Array([6, 7, 8]),
      ]);
      const response = new Response(stream.body, { headers: length === undefined ? {} : { "Content-Length": length } });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

      await expect(requestBytes("/api/file/raw?path=oversized", { maxBytes: 4 })).rejects.toMatchObject({
        name: "RawFileSizeError",
        maxBytes: 4,
        actualBytes: 5,
      });

      expect(stream.pull).toHaveBeenCalledTimes(3);
      expect(stream.cancel).toHaveBeenCalledExactlyOnceWith(expect.any(RawFileSizeError));
      expect(stream.body.locked).toBe(false);
    },
  );

  it.each(["declared", "streamed"])(
    "retains slow admission until %s oversize cancellation settles while Stop can run",
    async (mode) => {
      const cancellation = Promise.withResolvers<void>();
      const cancel = vi.fn(() => cancellation.promise);
      const oversized = chunkedBody([new Uint8Array([1, 2, 3])], cancel);
      let finishOther!: ReadableStreamDefaultController<Uint8Array>;
      const other = new ReadableStream<Uint8Array>({
        start(controller) {
          finishOther = controller;
        },
      });
      const response = new Response(oversized.body, { headers: mode === "declared" ? { "Content-Length": "3" } : {} });
      const fetch = vi.fn(async (path: string) => {
        if (path.endsWith("first")) return response;
        if (path.endsWith("second")) return new Response(other);
        if (path.endsWith("abort")) return new Response(null, { status: 204 });
        return new Response(new Uint8Array([9]));
      });
      vi.stubGlobal("fetch", fetch);
      const failed = requestBytes("/api/file/raw?path=first", { maxBytes: 2 }).catch((error: unknown) => error);
      const second = requestBytes("/api/file/raw?path=second", { maxBytes: 2 });
      const third = requestBytes("/api/file/raw?path=third", { maxBytes: 2 });
      try {
        await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
        await requestVoid("/api/sessions/test/abort", { method: "POST" });
        expect(fetch.mock.calls.map(([path]) => path)).toEqual([
          "/api/file/raw?path=first",
          "/api/file/raw?path=second",
          "/api/sessions/test/abort",
        ]);
        cancellation.resolve();
        expect(await failed).toBeInstanceOf(RawFileSizeError);
        await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/file/raw?path=third", expect.anything()));
        expect(new Uint8Array(await third)).toEqual(new Uint8Array([9]));
      } finally {
        cancellation.resolve();
        finishOther.close();
        await Promise.allSettled([failed, second, third]);
      }
      expect((await second).byteLength).toBe(0);
      expect(oversized.body.locked).toBe(false);
    },
  );

  it("cancels a pending read on AbortSignal, waits for cleanup and preserves the abort reason if cleanup fails", async () => {
    const cancellation = Promise.withResolvers<void>();
    const cancel = vi.fn(() => cancellation.promise);
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    const controller = new AbortController();
    const reason = new DOMException("Source view closed", "AbortError");
    const settled = vi.fn();
    const pending = requestBytes("/api/file/raw?path=report.html", { maxBytes: 4, signal: controller.signal }).then(
      (value) => {
        settled();
        return value;
      },
      (error: unknown) => {
        settled();
        return error;
      },
    );
    try {
      await waitFor(() => expect(pull).toHaveBeenCalledOnce());
      controller.abort(reason);
      await waitFor(() => expect(cancel).toHaveBeenCalledExactlyOnceWith(reason));
      expect(settled).not.toHaveBeenCalled();
      cancellation.reject(new Error("Stream already disconnected"));
      expect(await pending).toBe(reason);
      expect(body.locked).toBe(false);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      controller.abort(reason);
      cancellation.resolve();
      await pending;
    }
  });

  it("rejects late headers after cancellation without pulling source bytes", async () => {
    const headers = Promise.withResolvers<Response>();
    const stream = chunkedBody([new Uint8Array([1, 2])]);
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(headers.promise));
    const controller = new AbortController();
    const pending = requestBytes("/api/file/raw?path=late", { maxBytes: 4, signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    headers.resolve(new Response(stream.body));
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(stream.pull).not.toHaveBeenCalled();
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(stream.body.locked).toBe(false);
  });

  it("propagates mid-body failure rather than accepting partial bytes and releases the reader", async () => {
    const failure = new Error("Connection interrupted");
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (++pulls === 1) controller.enqueue(new Uint8Array([1, 2]));
          else controller.error(failure);
        },
      },
      { highWaterMark: 0 },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    await expect(requestBytes("/api/file/raw?path=interrupted", { maxBytes: 4 })).rejects.toBe(failure);
    expect(body.locked).toBe(false);
  });

  it.each([null, new Uint8Array()])("accepts an empty body with a zero byte budget", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    expect((await requestBytes("/api/file/raw?path=empty", { maxBytes: 0 })).byteLength).toBe(0);
  });
});
