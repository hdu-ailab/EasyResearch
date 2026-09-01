import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { SessionStatsNotifier } from "../../web/session-stats";

export function createSessionStatsExtension(
  notifier: Pick<SessionStatsNotifier, "notify">,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("turn_end", notifier.notify);
    pi.on("agent_settled", notifier.notify);
    pi.on("session_tree", notifier.notify);
    pi.on("session_compact", notifier.notify);
  };
}
