import { readExecutionClaim } from "./execution-claims";

const OWNER_TYPE = "easyresearch:background-owner";
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

interface OwnerJournal {
  getSessionId(): string;
  getEntries(): readonly unknown[];
  appendCustomEntry(type: string, data: unknown): string;
}

export function hasBackgroundOwner(entries: readonly unknown[], sessionId: string): boolean {
  let active = false;
  for (const entry of entries) {
    if (!object(entry) || entry.type !== "custom" || entry.customType !== OWNER_TYPE || !object(entry.data)) continue;
    if (entry.data.version === 1 && entry.data.sessionId === sessionId && typeof entry.data.active === "boolean") active = entry.data.active;
  }
  return active;
}

/** Recovery inventory hint; actual jobs remain authoritative for reconstruction. */
export class BackgroundOwnerJournal {
  constructor(private readonly journal: OwnerJournal) {}

  update(active: boolean): void {
    const sessionId = this.journal.getSessionId();
    if (hasBackgroundOwner(this.journal.getEntries(), sessionId) === active) return;
    this.journal.appendCustomEntry(OWNER_TYPE, { version: 1, sessionId, active });
  }
}

interface HistoryIdentity {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getCwd(): string;
  getSessionName(): string | undefined;
  getEntries(): readonly unknown[];
}

/** Called only after the daemon's exclusive server lease has been acquired. */
export async function recoverBackgroundRoots(options: {
  listAll(): Promise<Array<{ id: string; cwd: string; path: string }>>;
  inspect(path: string): HistoryIdentity;
  open(target: { sessionId: string; cwd: string; sessionPath: string }): Promise<unknown>;
}): Promise<{ recovered: string[]; failed: string[] }> {
  const recovered: string[] = [];
  const failed: string[] = [];
  for (const target of await options.listAll()) {
    try {
      const session = options.inspect(target.path);
      if (session.getSessionId() !== target.id || session.getSessionFile() !== target.path || session.getCwd() !== target.cwd) {
        throw new Error("Recovery session identity changed.");
      }
      if (session.getSessionName()?.startsWith("easyresearch:")) continue;
      const entries = session.getEntries();
      if (!readExecutionClaim(entries, target.id)?.pending && !hasBackgroundOwner(entries, target.id)) continue;
      await options.open({ sessionId: target.id, cwd: target.cwd, sessionPath: target.path });
      recovered.push(target.id);
    } catch {
      failed.push(target.id);
    }
  }
  return { recovered, failed };
}
