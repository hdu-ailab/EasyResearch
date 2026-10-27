import { DESKTOP_ACCESS_HEADER } from "./contracts";

export type NavigationDecision =
  | { kind: "allow" }
  | { kind: "external"; url: string }
  | { kind: "deny" };

export function desktopRequestHeaders(
  requestUrl: string,
  readyOrigin: string,
  rendererToken: string,
  currentHeaders: Readonly<Record<string, string>>,
): Record<string, string> {
  const headers = Object.fromEntries(
    Object.entries(currentHeaders).filter(([name]) =>
      name.toLowerCase() !== DESKTOP_ACCESS_HEADER),
  );
  try {
    if (new URL(requestUrl).origin === readyOrigin) {
      headers[DESKTOP_ACCESS_HEADER] = rendererToken;
    }
  } catch {
    // Malformed targets never receive the credential.
  }
  return headers;
}

/** Both Electron permission paths use frame identity and document identity, never an origin-only grant. */
export function desktopPermissionAllowed(options: {
  permission: string;
  requestingWebContents: object | null | undefined;
  ownerWebContents: object | null | undefined;
  ownerDocumentUrl: string;
  readyOrigin: string;
  requestingOrigin?: string;
  details?: { isMainFrame?: boolean; requestingUrl?: string } | null;
}): boolean {
  if (
    (options.permission !== "fullscreen" && options.permission !== "clipboard-sanitized-write")
    || !options.ownerWebContents
    || options.requestingWebContents !== options.ownerWebContents
    || options.details?.isMainFrame !== true
  ) return false;
  if (options.requestingOrigin !== undefined) {
    try {
      if (new URL(options.requestingOrigin).href !== `${options.readyOrigin}/`) return false;
    } catch {
      return false;
    }
  }
  const requestingDocument = mainAppDocument(options.details.requestingUrl, options.readyOrigin);
  return requestingDocument !== undefined
    && requestingDocument === mainAppDocument(options.ownerDocumentUrl, options.readyOrigin);
}

function mainAppDocument(value: string | undefined, readyOrigin: string): string | undefined {
  if (!value) return undefined;
  try {
    const document = new URL(value);
    if (
      document.origin !== readyOrigin
      || document.username !== ""
      || document.password !== ""
      || document.search !== ""
      || (document.pathname !== "/" && document.pathname !== "/index.html")
    ) return undefined;
    // Hash routing does not change the loaded app document. Different documents
    // (including root versus index.html) must still match the current owner URL.
    document.hash = "";
    return document.href;
  } catch {
    return undefined;
  }
}

export function navigationDecision(target: string, readyOrigin: string): NavigationDecision {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { kind: "deny" };
  }
  if (url.origin === readyOrigin) return { kind: "allow" };
  if (
    (url.protocol === "http:" || url.protocol === "https:")
    && !url.username
    && !url.password
    && !isLoopbackHostname(url.hostname)
  ) {
    return { kind: "external", url: url.href };
  }
  return { kind: "deny" };
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}
