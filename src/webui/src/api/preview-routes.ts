import { routes } from "./routes";

const PREVIEW_ROOT = "/api/file/preview";

export const previewRoutes = {
  create: () => PREVIEW_ROOT,
  release: (id: string) => `${PREVIEW_ROOT}/${encodeURIComponent(id)}`,
};

/** Keep watcher and retry identities separate, including a retry followed by a watcher update. */
export function mediaPreviewUrl(path: string, revision: number, attempt = 0): string {
  const raw = routes.rawFile(path, revision);
  if (attempt === 0) return raw;
  const separator = raw.indexOf("?");
  const query = new URLSearchParams(raw.slice(separator + 1));
  query.set("revision", `${revision}:${attempt}`);
  return `${raw.slice(0, separator)}?${query}`;
}
