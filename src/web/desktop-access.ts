export { DESKTOP_ACCESS_HEADER } from "../desktop/contracts";
import { DESKTOP_ACCESS_HEADER } from "../desktop/contracts";

export interface DesktopAccessControl {
  token: string;
}

export function rejectUnauthorizedDesktopRequest(
  request: Request,
  access: DesktopAccessControl | undefined,
): Response | undefined {
  if (!access || request.headers.get(DESKTOP_ACCESS_HEADER) === access.token) return undefined;
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
