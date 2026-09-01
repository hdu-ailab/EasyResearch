import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

export function createSessionTimelineExtension(
  publishEntry: (entry: unknown) => void,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("session_compact", (event) => {
      publishEntry(event.compactionEntry);
    });
    pi.on("session_tree", (event) => {
      if (event.summaryEntry) publishEntry(event.summaryEntry);
    });
  };
}
