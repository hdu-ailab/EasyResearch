import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

export interface WebListenerAuthority {
  host: string;
  port: number;
  localInterfaceAddresses?: readonly string[];
}

interface ParsedHttpAuthority {
  hostname: string;
  port: number;
  origin: string;
}

export function rejectDisallowedWebRequest(
  request: Request,
  listener: WebListenerAuthority,
): Response | undefined {
  const authority = parseHttpAuthority(request.headers.get("host") ?? new URL(request.url).host);
  if (!authority || authority.port !== listener.port) return forbiddenResponse();
  const normalizedBindHost = normalizeConfiguredHostname(listener.host);
  if (!normalizedBindHost) return forbiddenResponse();
  const loopback = normalizedBindHost === "localhost"
    || normalizedBindHost === "::1"
    || (isIP(normalizedBindHost) === 4 && normalizedBindHost.startsWith("127."));
  const wildcard = normalizedBindHost === "0.0.0.0" || normalizedBindHost === "::";
  const acceptedHosts = wildcard
    ? (listener.localInterfaceAddresses ?? localInterfaceIpAddresses())
      .map(normalizeConfiguredHostname)
      .filter((host): host is string => host !== undefined && isIP(host) !== 0)
      .filter((host) => host !== "0.0.0.0" && host !== "::")
    : loopback
      ? [normalizedBindHost, "localhost", "127.0.0.1", "::1"]
      : [normalizedBindHost];
  const accepted = acceptedHosts.includes(authority.hostname);
  if (!accepted) return forbiddenResponse();

  const origin = request.headers.get("origin");
  if (origin === null) return undefined;
  try {
    const parsedOrigin = new URL(origin);
    if (
      parsedOrigin.protocol === "http:"
      && !parsedOrigin.username
      && !parsedOrigin.password
      && parsedOrigin.pathname === "/"
      && !parsedOrigin.search
      && !parsedOrigin.hash
      && parsedOrigin.origin === authority.origin
    ) return undefined;
  } catch {
    // Invalid and opaque origins are not admitted.
  }
  return forbiddenResponse();
}

export function localInterfaceIpAddresses(): string[] {
  const addresses = new Set(["127.0.0.1", "::1"]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (isIP(entry.address) !== 0) addresses.add(entry.address);
    }
  }
  return [...addresses];
}

function parseHttpAuthority(value: string): ParsedHttpAuthority | undefined {
  try {
    const rawHostname = authorityHostname(value);
    if (!rawHostname) return undefined;
    const url = new URL(`http://${value}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const addressFamily = isIP(hostname);
    if (addressFamily === 4 && (isIP(rawHostname) !== 4 || rawHostname !== hostname)) return undefined;
    if (addressFamily === 6 && isIP(rawHostname) !== 6) return undefined;
    return {
      hostname,
      port: url.port === "" ? 80 : Number(url.port),
      origin: url.origin,
    };
  } catch {
    return undefined;
  }
}

function authorityHostname(value: string): string | undefined {
  if (value.startsWith("[")) {
    const closingBracket = value.indexOf("]");
    if (closingBracket < 0) return undefined;
    const suffix = value.slice(closingBracket + 1);
    if (suffix !== "" && !/^:\d+$/.test(suffix)) return undefined;
    return value.slice(1, closingBracket).toLowerCase();
  }
  if (value.includes("[") || value.includes("]")) return undefined;
  const colon = value.lastIndexOf(":");
  if (colon < 0) return value.toLowerCase();
  if (value.indexOf(":") !== colon || !/^\d+$/.test(value.slice(colon + 1))) return undefined;
  return value.slice(0, colon).toLowerCase();
}

function normalizeConfiguredHostname(value: string): string | undefined {
  const unbracketed = value.replace(/^\[|\]$/g, "");
  const authority = isIP(unbracketed) === 6 ? `[${unbracketed}]` : unbracketed;
  try {
    return new URL(`http://${authority}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function forbiddenResponse(): Response {
  return new Response("Forbidden", {
    status: 403,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
