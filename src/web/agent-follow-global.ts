import { importPi } from "../runtime/pi-import";
import type { EntryRow } from "./agent-models";

/** Session entry flagging "follow global settings" for the Paper Assistant:
 * its model/thinking resolve from the current global defaults (display and
 * runtime) instead of the session-pinned values. */
export const FOLLOW_GLOBAL_ENTRY = "easyresearch:follow_global_settings";

export function readFollowGlobalFlag(rows: readonly EntryRow[]): boolean {
  let found: boolean | undefined;
  for (const row of rows) {
    if (row.type !== "custom" || row.customType !== FOLLOW_GLOBAL_ENTRY) continue;
    const d = row.data as { follow?: unknown } | undefined;
    found = typeof d?.follow === "boolean" ? d.follow : true;
  }
  return found === true;
}

async function writeFollowGlobalFlag(sessionPath: string | undefined, follow: boolean): Promise<void> {
  if (!sessionPath) {
    throw new Error("Active session has no session file to persist the follow-global flag");
  }
  const { SessionManager } = await importPi();
  const session = await SessionManager.open(sessionPath);
  await session.appendCustomEntry(FOLLOW_GLOBAL_ENTRY, { follow });
}

export function setFollowGlobalFlag(sessionPath: string | undefined): Promise<void> {
  return writeFollowGlobalFlag(sessionPath, true);
}

export function clearFollowGlobalFlag(sessionPath: string | undefined): Promise<void> {
  return writeFollowGlobalFlag(sessionPath, false);
}
