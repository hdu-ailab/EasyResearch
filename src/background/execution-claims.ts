import { randomUUID } from "node:crypto";
import fs, { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export const EXECUTION_CLAIM_TYPE = "easyresearch:execution";
export const RESTART_NOTICE_TYPE = "easyresearch:restart";
export const RESTART_NOTICE = "The server restarted while you were working. Continue from where you left off without repeating completed work.";

export interface ClaimJournal {
  getSessionId(): string;
  getEntries(): readonly unknown[];
  appendCustomEntry(type: string, data: unknown): string;
  /** Omitted only by deliberate in-memory DI journals. Native managers expose it. */
  getSessionFile?(): string | undefined;
}
type ReadableClaimJournal = Omit<ClaimJournal, "appendCustomEntry">;

export interface ExecutionClaim {
  version: 1;
  sessionId: string;
  periodId: string;
  attempts: number;
  pending: boolean;
  outcome?: "settled" | "cancelled" | "exhausted";
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nativeConversationMessage = (entry: unknown): boolean => object(entry) && entry.type === "message" && object(entry.message)
  && (entry.message.role === "user" || entry.message.role === "assistant");

function acceptedCustomInput(entry: unknown): boolean {
  if (!object(entry) || entry.type !== "custom_message") return false;
  if (typeof entry.content === "string") return entry.content.trim().length > 0;
  return Array.isArray(entry.content) && entry.content.some((block) => object(block)
    && ((block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0)
      || (block.type === "image" && typeof block.data === "string" && block.data.length > 0)));
}

type NativeCustomInputJournal = Pick<SessionManager, "getSessionId" | "getSessionFile" | "getCwd" | "isPersisted"
  | "getHeader" | "getEntries" | "getBranch" | "getLeafId" | "setSessionFile" | "branch">;

/**
 * Pi deliberately buffers custom-first runs. Publish only their already accepted
 * native entries, then let the public setter establish native append ownership.
 * Existing files and metadata-only/deleted ordinary conversations are never recreated.
 */
export function materializeNativeCustomInput(journal: NativeCustomInputJournal, sessionFile: string): boolean {
  if (!journal.isPersisted() || !isAbsolute(sessionFile) || journal.getSessionFile() !== sessionFile) {
    throw new Error("Custom input materialization requires the exact persistent native session file.");
  }
  try {
    fs.lstatSync(sessionFile);
    // An existing header is not proof that this buffered custom input belongs to
    // that file. Verify it before trusting custom-only native state, without rebinding.
    const custom = journal.getBranch().findLast(acceptedCustomInput);
    if (custom && !journal.getEntries().some(nativeConversationMessage)) {
      assertNativeJournalEntryDurable(journal, custom, sessionFile);
    }
    return false;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

  const entries = journal.getEntries();
  if (entries.some(nativeConversationMessage) || !journal.getBranch().some(acceptedCustomInput)) return false;
  const header = journal.getHeader();
  const sessionId = journal.getSessionId();
  const leaf = journal.getLeafId();
  if (!header || header.type !== "session" || header.id !== sessionId || header.cwd !== journal.getCwd()
    || !leaf || !entries.some((entry) => entry.id === leaf)) {
    throw new Error("Custom input materialization found inconsistent native session identity.");
  }
  const bytes = [header, ...entries].map((entry) => `${JSON.stringify(entry)}\n`).join("");
  const staging = join(dirname(sessionFile), `.${basename(sessionFile)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let owned: ReturnType<typeof fs.fstatSync> | undefined;
  try {
    fd = fs.openSync(staging, "wx", 0o600);
    owned = fs.fstatSync(fd);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    // link is atomic and exclusive: a concurrent owner wins without losing bytes.
    fs.linkSync(staging, sessionFile);
    const published = fs.lstatSync(sessionFile);
    if (!published.isFile() || published.dev !== owned.dev || published.ino !== owned.ino
      || fs.readFileSync(sessionFile, "utf8") !== bytes) throw new Error("Custom input publication lost its native file identity.");
    if (process.platform !== "win32") {
      const directory = fs.openSync(dirname(sessionFile), "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
    journal.setSessionFile(sessionFile);
    if (journal.getSessionFile() !== sessionFile || journal.getSessionId() !== sessionId
      || [journal.getHeader(), ...journal.getEntries()].map((entry) => `${JSON.stringify(entry)}\n`).join("") !== bytes) {
      throw new Error("Public native session rebinding changed accepted custom input.");
    }
    if (journal.getLeafId() !== leaf) journal.branch(leaf);
    if (journal.getLeafId() !== leaf) throw new Error("Public native session rebinding did not preserve its active leaf.");
    return true;
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); }
    finally {
      if (owned) {
        let current: ReturnType<typeof fs.lstatSync> | undefined;
        try { current = fs.lstatSync(staging); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (current?.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(staging);
      }
    }
  }
}

function openMaterializedJournal(journal: ReadableClaimJournal, expectedFile?: string): number | undefined {
  if (!journal.getSessionFile && expectedFile === undefined) return undefined;
  const nativeFile = journal.getSessionFile?.();
  const file = expectedFile ?? nativeFile;
  if (!file || (nativeFile !== undefined && expectedFile !== undefined && nativeFile !== expectedFile)) {
    throw new Error("Native execution journal is not materialized at its exact session file.");
  }
  let fd: number;
  try { fd = openSync(file, "r"); }
  catch (cause) { throw new Error("Native execution journal is not materialized or readable.", { cause }); }
  try {
    const head = Buffer.alloc(Math.min(65_536, fstatSync(fd).size));
    const count = readSync(fd, head, 0, head.length, 0);
    const newline = head.subarray(0, count).indexOf(10);
    if (newline < 0) throw new Error("Native execution journal has no complete session header.");
    const header: unknown = JSON.parse(head.subarray(0, newline).toString("utf8"));
    if (!object(header) || header.type !== "session" || header.id !== journal.getSessionId()) throw new Error("Native execution journal identity does not match its owner.");
    if (!journal.getEntries().some((entry) => nativeConversationMessage(entry) || acceptedCustomInput(entry))) {
      throw new Error("Native execution journal has no materialized conversation.");
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

/** Native appendCustomEntry may buffer. Physical native conversation admission is required. */
export function assertNativeJournalMaterialized(journal: ReadableClaimJournal, expectedFile?: string): void {
  const fd = openMaterializedJournal(journal, expectedFile);
  if (fd !== undefined) closeSync(fd);
}

/** Verify the exact native entry, not merely a successful in-memory append or file stat. */
export function assertNativeJournalEntryDurable(journal: ReadableClaimJournal, entry: unknown, expectedFile?: string): void {
  const fd = openMaterializedJournal(journal, expectedFile);
  if (fd === undefined) return;
  try {
    if (!object(entry) || typeof entry.id !== "string") throw new Error("Native execution journal entry is unavailable.");
    const expected = Buffer.from(`${JSON.stringify(entry)}\n`);
    const size = fstatSync(fd).size;
    // Every newly appended entry is at the tail. Recovery may need an older entry;
    // scan with bounded memory rather than retaining the conversation's contents.
    const tail = Buffer.alloc(Math.min(size, expected.length));
    readSync(fd, tail, 0, tail.length, size - tail.length);
    if (tail.equals(expected)) return;
    const chunk = Buffer.alloc(65_536);
    let overlap = Buffer.alloc(0);
    let position = 0;
    while (position < size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
      if (!count) break;
      const data = Buffer.concat([overlap, chunk.subarray(0, count)]);
      if (data.indexOf(expected) !== -1) return;
      position += count;
      overlap = data.subarray(Math.max(0, data.length - expected.length + 1));
    }
    throw new Error("Native execution journal entry is not durably materialized.");
  } finally { closeSync(fd); }
}

/** Read native custom entries only. Fork-inherited identities never own this run. */
export function readExecutionClaim(entries: readonly unknown[], sessionId: string): ExecutionClaim | undefined {
  let latest: ExecutionClaim | undefined;
  for (const entry of entries) {
    if (!object(entry) || entry.type !== "custom" || entry.customType !== EXECUTION_CLAIM_TYPE || !object(entry.data)) continue;
    const data = entry.data;
    if (data.version !== 1 || data.sessionId !== sessionId || typeof data.periodId !== "string" || !data.periodId
      || !Number.isSafeInteger(data.attempts) || (data.attempts as number) < 0 || typeof data.pending !== "boolean"
      || (data.outcome !== undefined && !["settled", "cancelled", "exhausted"].includes(String(data.outcome)))) continue;
    latest = { ...data } as unknown as ExecutionClaim;
  }
  return latest;
}

/** A write-ahead execution intent in the existing Pi history, not a second store. */
export class ExecutionClaims {
  private suspended = false;
  private failed?: Error;
  private expectedFile?: string;

  constructor(private readonly journal: ClaimJournal) {}

  current(): ExecutionClaim | undefined {
    const entries = this.journal.getEntries();
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      const claim = readExecutionClaim([entry], this.journal.getSessionId());
      if (!claim) continue;
      assertNativeJournalEntryDurable(this.journal, entry, this.expectedFile);
      return claim;
    }
    return undefined;
  }

  failure(): Error | undefined { return this.failed; }
  assertHealthy(): void { if (this.failed) throw this.failed; }
  assertDurable(sessionFile: string): void {
    this.assertHealthy();
    this.bindFile(sessionFile);
    assertNativeJournalMaterialized(this.journal, sessionFile);
    if (!this.current()?.pending) throw new Error("No durable execution claim owns this provider request.");
  }

  start(sessionFile?: string): void {
    this.assertHealthy();
    if (sessionFile !== undefined) this.bindFile(sessionFile);
    if (this.suspended) throw new Error("Session execution is suspended for restart.");
    if (this.current()?.pending) return;
    this.append({ version: 1, sessionId: this.journal.getSessionId(), periodId: randomUUID(), attempts: 0, pending: true });
  }

  settle(): void {
    if (!this.suspended) this.release("settled");
  }

  cancel(): void { this.release("cancelled"); }

  suspend(): void { this.suspended = true; }

  prepareResume(): boolean {
    this.assertHealthy();
    const current = this.current();
    if (!current?.pending) return false;
    if (current.attempts >= 10) {
      this.release("exhausted");
      return false;
    }
    this.append({ ...current, attempts: current.attempts + 1 });
    return true;
  }

  private release(outcome: NonNullable<ExecutionClaim["outcome"]>): void {
    this.assertHealthy();
    const current = this.current();
    if (current?.pending) this.append({ ...current, pending: false, outcome });
  }

  private append(claim: ExecutionClaim): void {
    assertNativeJournalMaterialized(this.journal, this.expectedFile);
    try {
      const id = this.journal.appendCustomEntry(EXECUTION_CLAIM_TYPE, claim);
      const entry = this.journal.getEntries().find((entry) => object(entry) && entry.id === id);
      if (this.journal.getSessionFile || this.expectedFile) {
        const written = readExecutionClaim([entry], this.journal.getSessionId());
        if (!written || written.periodId !== claim.periodId || written.pending !== claim.pending
          || written.attempts !== claim.attempts || written.outcome !== claim.outcome) {
          throw new Error("Native execution journal did not append the requested claim.");
        }
      }
      assertNativeJournalEntryDurable(this.journal, entry, this.expectedFile);
    } catch (error) {
      this.failed = error instanceof Error ? error : new Error(String(error));
      throw this.failed;
    }
  }

  private bindFile(file: string): void {
    if (this.expectedFile !== undefined && this.expectedFile !== file) throw new Error("Native execution journal path changed while its boundary was attached.");
    this.expectedFile = file;
  }
}
