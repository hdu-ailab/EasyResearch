import { watch as nativeWatch } from "node:fs";
import { basename } from "node:path";
import type { BackgroundOutputChangedEvent, ShellOutputDto } from "../background/contracts";
import { isShellTaskId, ShellOutputError, ShellOutputReader } from "../background/shell/output";
import type { WatchImplementation } from "./file-watcher";
export { ShellOutputError as BackgroundOutputError } from "../background/shell/output";
export interface BackgroundOutputOptions {
  agentDir: string;
  isKnownRoot(root: string): Promise<boolean>;
  publish(root: string, event: BackgroundOutputChangedEvent): void;
  watch?: WatchImplementation;
}
interface OutputLease { root: string; revision: number; taskIds: Set<string> }
interface OutputWatch {
  directory: string;
  identity: string;
  handle: ReturnType<WatchImplementation>;
  pending: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}
export class BackgroundOutputService {
  private readonly reader: ShellOutputReader;
  private readonly leases = new Map<string, OutputLease>();
  private readonly watches = new Map<string, OutputWatch>();
  private closed = false;
  constructor(private readonly options: BackgroundOutputOptions) { this.reader = new ShellOutputReader(options.agentDir); }
  private async authorize(root: string) {
    if (this.closed) throw new ShellOutputError();
    if (!await this.options.isKnownRoot(root) || this.closed) throw new ShellOutputError();
  }
  async read(root: string, id: string, options: { cursor?: number; limit?: number } = {}): Promise<ShellOutputDto> {
    await this.authorize(root);
    const result = this.reader.read(root, id, options);
    if (this.selected(root).size) {
      const owned = this.reader.record(root, id);
      this.ensureWatch(root, owned.directory, owned.directoryIdentity);
    }
    return result;
  }
  acquireLease(root: string, id: string): void {
    if (this.closed || this.leases.has(id)) throw new ShellOutputError();
    this.leases.set(id, { root, revision: -1, taskIds: new Set() });
  }
  async replaceLease(root: string, id: string, revision: number, taskIds: readonly string[]): Promise<{ applied: boolean; revision: number }> {
    if (!Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(taskIds) || taskIds.length > 16 || !taskIds.every(isShellTaskId)) throw new ShellOutputError(400, "SHELL_OUTPUT_INVALID");
    const lease = this.leases.get(id);
    if (lease?.root !== root) throw new ShellOutputError();
    await this.authorize(root);
    if (this.leases.get(id) !== lease) throw new ShellOutputError();
    if (revision <= lease.revision) return { applied: false, revision: lease.revision };
    // All validation precedes publication, retaining the previous valid watch on failure.
    const selected = new Set(taskIds);
    let directory: { directory: string; directoryIdentity: string } | undefined;
    for (const taskId of selected) directory = this.reader.record(root, taskId);
    if (directory) this.ensureWatch(root, directory.directory, directory.directoryIdentity);
    lease.taskIds = selected;
    lease.revision = revision;
    if (!this.selected(root).size) this.closeWatch(root);
    return { applied: true, revision };
  }
  releaseLease(root: string, id: string): void {
    if (this.leases.get(id)?.root !== root) return;
    this.leases.delete(id);
    if (!this.selected(root).size) this.closeWatch(root);
  }
  private selected(root: string): Set<string> {
    const ids = new Set<string>();
    for (const lease of this.leases.values()) if (lease.root === root) for (const id of lease.taskIds) ids.add(id);
    return ids;
  }
  private publish(root: string, id: string): void {
    try { this.options.publish(root, { type: "background_output_changed", taskId: id }); } catch { /* View observers never own execution. */ }
  }
  private ensureWatch(root: string, directory: string, identity: string): void {
    if (this.watches.get(root)?.identity === identity) return;
    const watch = this.options.watch ?? nativeWatch as unknown as WatchImplementation;
    let entry: OutputWatch;
    try {
      const handle = watch(directory, { recursive: false }, (_event, filename) => {
        if (this.watches.get(root) !== entry || this.closed) return;
        const selected = this.selected(root);
        const name = filename?.toString();
        const match = name?.match(/^(shell_[a-f0-9-]+)\.(?:out|json)$/);
        const ids = match ? selected.has(match[1]!) ? [match[1]!] : []
          : !name || name === basename(directory) ? [...selected] : [];
        for (const id of ids) entry.pending.add(id);
        if (!entry.pending.size || entry.timer) return;
        entry.timer = setTimeout(() => {
          entry.timer = undefined;
          const pending = [...entry.pending];
          entry.pending.clear();
          const current = this.selected(root);
          for (const id of pending) if (current.has(id)) this.publish(root, id);
        }, 25);
      });
      entry = { directory, identity, handle, pending: new Set() };
      handle.on("error", () => {
        if (this.watches.get(root) !== entry) return;
        this.closeWatch(root);
        for (const id of this.selected(root)) this.publish(root, id);
      });
    } catch { throw new ShellOutputError(503); }
    this.closeWatch(root);
    this.watches.set(root, entry);
  }
  private closeWatch(root: string): void {
    const watch = this.watches.get(root);
    if (!watch) return;
    this.watches.delete(root);
    if (watch.timer) clearTimeout(watch.timer);
    watch.pending.clear();
    try { watch.handle.close(); } catch { /* A failed observer cannot affect Agent execution. */ }
  }
  close(): void {
    this.closed = true;
    this.leases.clear();
    for (const root of this.watches.keys()) this.closeWatch(root);
  }
}
