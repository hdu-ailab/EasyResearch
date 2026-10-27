import { mediaPreviewUrl, previewRoutes } from "./preview-routes";
import { ApiError, requestBytes, requestJson, requestVoid } from "./transport";

export interface HtmlPreviewCapability {
  id: string;
  url: string;
}

export const HTML_SOURCE_MAX_BYTES = 32 * 1024 * 1024;

function parseCapability(value: unknown): HtmlPreviewCapability {
  if (!value || typeof value !== "object") throw new Error("Invalid preview capability");
  const { id, url } = value as Record<string, unknown>;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(id) || typeof url !== "string") {
    throw new Error("Invalid preview capability");
  }
  const prefix = `${previewRoutes.release(id)}/`;
  if (!url.startsWith(prefix)) throw new Error("Invalid preview URL");
  const entry = url.slice(prefix.length);
  // The entry is one encoded basename, not another route, query, fragment or navigation target.
  if (!entry || /[/?#\\\s]/u.test(entry)) throw new Error("Invalid preview entry");
  const decoded = decodeURIComponent(entry);
  if (!/\.html?$/i.test(decoded) || /[\p{Cc}/\\]/u.test(decoded)) {
    throw new Error("Invalid preview entry");
  }
  return { id, url };
}

/**
 * Creation deliberately drains its response even after the view is cancelled.
 * Aborting an admitted POST could lose the allocated id before it can be released.
 * The view owns this promise and releases any late/superseded capability.
 */
export async function createHtmlPreview(path: string): Promise<HtmlPreviewCapability> {
  const capability = await requestJson(previewRoutes.create(), parseCapability, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!capability) throw new ApiError(502, { error: "Invalid API response" });
  return capability;
}

export function releaseHtmlPreview(id: string): Promise<void> {
  return requestVoid(previewRoutes.release(id), { method: "DELETE", keepalive: true });
}

/** Explicit Source only. Executable HTML always streams from its scoped document URL. */
export async function readHtmlPreviewSource(
  path: string,
  options: { signal?: AbortSignal; revision?: number; attempt?: number } = {},
): Promise<string> {
  const bytes = await requestBytes(mediaPreviewUrl(path, options.revision ?? 0, options.attempt), {
    maxBytes: HTML_SOURCE_MAX_BYTES,
    signal: options.signal,
  });
  return new TextDecoder().decode(bytes);
}
