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
