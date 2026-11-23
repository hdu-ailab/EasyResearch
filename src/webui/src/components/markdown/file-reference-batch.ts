import type { FileReferenceResolutionDto, FileReferencesResolvedDto } from "../../../../web/file-reference-contracts";
import { isNetworkFileReference } from "./file-references";

type Consumer = { resolve: (value: FileReferenceResolutionDto) => void; reject: (error: unknown) => void };
type Candidate = { path: string; consumers: Set<Consumer> };
type Request = { controller: AbortController; entries: Candidate[] };
export interface FileReferenceLease {
  promise: Promise<FileReferenceResolutionDto>;
  release(): void;
}
const aborted = () => new DOMException("File reference consumer released", "AbortError");

/** One Work-view cache. Candidate leases own queued work and shared HTTP cancellation. */
export class FileReferenceBatch {
  private cache = new Map<string, FileReferenceResolutionDto>();
  private pending = new Map<string, Candidate>();
  private active?: Request;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(private readonly read: (paths: string[], signal: AbortSignal) => Promise<FileReferencesResolvedDto>) {}

  acquire(path: string): FileReferenceLease {
    if (this.disposed) return { promise: Promise.reject(aborted()), release() {} };
    if (isNetworkFileReference(path) || path.length > 4096)
      return { promise: Promise.resolve({ reference: path, paths: [], truncated: false }), release() {} };
    const cached = this.cache.get(path);
    if (cached) return { promise: Promise.resolve(cached), release() {} };
    let entry = this.pending.get(path);
    if (!entry) {
      entry = { path, consumers: new Set() };
      this.pending.set(path, entry);
    }
    const candidate = entry;
    let consumer!: Consumer;
    const promise = new Promise<FileReferenceResolutionDto>((resolve, reject) => {
      consumer = { resolve, reject };
      candidate.consumers.add(consumer);
    });
    this.schedule();
    return {
      promise,
      release: () => {
        if (!candidate.consumers.delete(consumer)) return;
        consumer.reject(aborted());
        if (candidate.consumers.size === 0 && this.pending.get(path) === candidate) this.pending.delete(path);
        if (this.active?.entries.every((item) => item.consumers.size === 0)) {
          this.active.controller.abort();
          this.active = undefined;
        }
        if (this.pending.size === 0) {
          clearTimeout(this.timer);
          this.timer = undefined;
        } else this.schedule();
      },
    };
  }

  /** Explicit lookups hold one lease until completion; render consumers use acquire/release. */
  resolve(path: string): Promise<FileReferenceResolutionDto> {
    const lease = this.acquire(path);
    return lease.promise.finally(lease.release);
  }

  private schedule() {
    if (this.disposed || this.active || this.timer || this.pending.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed || this.active || this.pending.size === 0) return;
      const request = { controller: new AbortController(), entries: [...this.pending.values()].slice(0, 64) };
      this.active = request;
      void this.run(request);
    }, 0);
  }

  private async run(request: Request) {
    try {
      const result = await this.read(
        request.entries.map((entry) => entry.path),
        request.controller.signal,
      );
      if (request.controller.signal.aborted || this.disposed) return;
      const found = new Map(result.references.map((entry) => [entry.reference, entry]));
      for (const entry of request.entries) {
        if (this.pending.get(entry.path) !== entry || entry.consumers.size === 0) continue;
        const value = found.get(entry.path) ?? { reference: entry.path, paths: [], truncated: false };
        this.cache.set(entry.path, value);
        for (const consumer of entry.consumers) consumer.resolve(value);
        entry.consumers.clear();
        this.pending.delete(entry.path);
      }
      while (this.cache.size > 1024) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
    } catch (error) {
      for (const entry of request.entries) {
        if (this.pending.get(entry.path) !== entry) continue;
        for (const consumer of entry.consumers) consumer.reject(error);
        entry.consumers.clear();
        this.pending.delete(entry.path);
      }
    } finally {
      if (this.active === request) {
        this.active = undefined;
        this.schedule();
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.active?.controller.abort();
    this.active = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const entry of this.pending.values()) {
      for (const consumer of entry.consumers) consumer.reject(aborted());
      entry.consumers.clear();
    }
    this.pending.clear();
    this.cache.clear();
  }
}
