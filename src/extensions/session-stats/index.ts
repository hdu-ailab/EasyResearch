import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { SessionStatsNotifier } from "../../web/session-stats";

export function createSessionStatsExtension(
  notifier: Pick<SessionStatsNotifier, "notify">,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("context", (_event, ctx) => {
      try {
        // Pi removes retriable responses after session_compact, before this boundary.
        if (ctx.getContextUsage()?.tokens === null) notifier.notify();
      } catch {
        // Capacity is observational and must never block a provider request.
      }
    });
    pi.on("turn_end", notifier.notify);
    pi.on("agent_settled", notifier.notify);
    pi.on("session_tree", notifier.notify);
    pi.on("session_compact", notifier.notify);
  };
}
