import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, abortSession, downloadFileUrl, rawFileUrl, renameFile, uploadFile } from "../api";

class UploadRequest {
  static instances: UploadRequest[] = [];
  upload = { onprogress: null as ((event: { loaded: number }) => void) | null, onload: null as (() => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  status = 0;
  responseText = "";
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn();
  abort = vi.fn(() => this.onabort?.());
  constructor() {
    UploadRequest.instances.push(this);
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

const file = () => new File([new Uint8Array([0, 1, 255, 0])], "报告 #1.bin");
const result = { entry: { kind: "file", name: "报告 #1.bin", path: "/p/报告 #1.bin" } };

beforeEach(() => {
  UploadRequest.instances = [];
  vi.stubGlobal("XMLHttpRequest", UploadRequest);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
});
afterEach(() => {
  for (const request of UploadRequest.instances) request.abort();
  vi.unstubAllGlobals();
});

describe("typed file operations", () => {
  it("streams the original File and reports real bytes separately from server acceptance", async () => {
    const bytes = file();
    const onProgress = vi.fn();
    const accepted = vi.fn();
    const pending = uploadFile("/p ?", "/p ?/資料", bytes, { onProgress }).then(accepted);
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(1));
    const request = UploadRequest.instances[0]!;
    const [method, target] = request.open.mock.calls[0]!;
    const url = new URL(target, "http://localhost");
    expect(method).toBe("PUT");
    expect(url.pathname).toBe("/api/file/upload");
    expect(Object.fromEntries(url.searchParams)).toEqual({ cwd: "/p ?", directory: "/p ?/資料", name: bytes.name });
    expect(request.setRequestHeader).toHaveBeenCalledExactlyOnceWith("Content-Type", "application/octet-stream");
    expect(request.send).toHaveBeenCalledExactlyOnceWith(bytes);
    request.upload.onprogress?.({ loaded: 2 });
    expect(onProgress).toHaveBeenLastCalledWith(2, bytes.size);
    request.upload.onload?.();
    expect(onProgress).toHaveBeenLastCalledWith(bytes.size, bytes.size);
    await Promise.resolve();
    expect(accepted).not.toHaveBeenCalled();
    request.respond(201, result);
    await pending;
    expect(accepted).toHaveBeenCalledWith(result);
    expect(request.onload).toBeNull();
    expect(request.upload.onprogress).toBeNull();
  });

  it("retains both slow slots after bytes are sent while Stop keeps its reserved capacity", async () => {
    const pending = Array.from({ length: 3 }, () => uploadFile("/p", "/p", file()));
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(2));
    for (const request of UploadRequest.instances) request.upload.onload?.();
    await abortSession("session");
    expect(fetch).toHaveBeenCalledWith("/api/sessions/session/abort", expect.anything());
    expect(UploadRequest.instances).toHaveLength(2);
    UploadRequest.instances[0]!.respond(201, result);
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(3));
    UploadRequest.instances[1]!.respond(201, result);
    UploadRequest.instances[2]!.respond(201, result);
    await Promise.all(pending);
  });

  it("cancels active and queued transfers, detaches listeners, and admits a retry", async () => {
    const controllers = Array.from({ length: 3 }, () => new AbortController());
    const pending = controllers.map((controller) =>
      uploadFile("/p", "/p", file(), { signal: controller.signal }).catch((error: unknown) => error),
    );
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(2));
    controllers[2]!.abort();
    controllers[0]!.abort();
    controllers[1]!.abort();
    for (const error of await Promise.all(pending)) expect(error).toMatchObject({ name: "AbortError" });
    expect(UploadRequest.instances).toHaveLength(2);
    expect(UploadRequest.instances[0]!.abort).toHaveBeenCalledOnce();
    const retry = uploadFile("/p", "/p", file());
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(3));
    UploadRequest.instances[2]!.respond(201, result);
    await expect(retry).resolves.toEqual(result);
  });

  it.each([
    { status: 409, body: { code: "FILE_EXISTS", error: "Name exists" }, expected: 409 },
    { status: 201, body: { entry: { ...result.entry, kind: "directory" } }, expected: 502 },
    { status: 201, body: { entry: { kind: "file" } }, expected: 502 },
    { status: 201, body: null, expected: 502 },
  ])(
    "preserves typed errors and rejects invalid accepted payloads: $status/$expected",
    async ({ status, body, expected }) => {
      const pending = uploadFile("/p", "/p", file());
      const rejected = expect(pending).rejects.toMatchObject({ status: expected });
      await waitFor(() => expect(UploadRequest.instances).toHaveLength(1));
      UploadRequest.instances[0]!.respond(status, body);
      await rejected;
    },
  );

  it.each(["onerror", "ontimeout"] as const)("settles and releases a failed transport on %s", async (event) => {
    const pending = uploadFile("/p", "/p", file());
    const rejected = expect(pending).rejects.toMatchObject({ status: 0 });
    await waitFor(() => expect(UploadRequest.instances).toHaveLength(1));
    UploadRequest.instances[0]![event]?.();
    await rejected;
    expect(UploadRequest.instances[0]!.onload).toBeNull();
  });

  it("preserves raw URL compatibility and adds explicit attachment/cache revision variants", () => {
    const path = String.raw`D:\papers\报告 #1.pdf`;
    expect(rawFileUrl(path)).toBe(`/api/file/raw?${new URLSearchParams({ path })}`);
    const raw = new URL(rawFileUrl(path, 7), "http://localhost");
    const download = new URL(downloadFileUrl(path), "http://localhost");
    expect(raw.searchParams.get("path")).toBe(path);
    expect(raw.searchParams.get("revision")).toBe("7");
    expect(download.searchParams.get("download")).toBe("1");
    expect(download.searchParams.get("path")).toBe(path);
  });

  it("renames through the typed JSON endpoint and rejects a missing old-path identity", async () => {
    const renamed = { oldPath: "/p/old.txt", entry: { kind: "file", path: "/p/new.md", name: "new.md" } };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(renamed)));
    await expect(renameFile("/p", renamed.oldPath, "new.md")).resolves.toEqual(renamed);
    expect(fetch).toHaveBeenCalledWith("/api/file/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/p", path: renamed.oldPath, name: "new.md" }),
    });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ entry: renamed.entry })));
    await expect(renameFile("/p", renamed.oldPath, "new.md")).rejects.toBeInstanceOf(ApiError);
  });
});
