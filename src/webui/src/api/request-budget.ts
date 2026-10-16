interface Waiting {
  control: boolean;
  slow: boolean;
  start(): void;
  cancel(): void;
}

/** Own a request slot through body consumption, with room reserved for Stop/control. */
export class RequestBudget {
  private active = 0;
  private ordinary = 0;
  private slow = 0;
  private readonly waiting: Waiting[] = [];

  run<T>(path: string, signal: AbortSignal | null | undefined, operation: () => Promise<T>): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (this.waiting.length >= 128) return Promise.reject(new Error("Too many pending requests. Retry shortly."));
    const pathname = path.split("?")[0] ?? path;
    const control = /\/(?:abort|stop|messages|respond|cancel)$/.test(pathname) || pathname === "/api/runtime/restart";
    const slow = /^\/api\/(?:entries|file|directories)(?:\/|$)/.test(pathname);
    return new Promise<T>((resolve, reject) => {
      const entry: Waiting = {
        control,
        slow,
        cancel: () => {
          const index = this.waiting.indexOf(entry);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          signal?.removeEventListener("abort", entry.cancel);
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        },
        start: () => {
          signal?.removeEventListener("abort", entry.cancel);
          this.active += 1;
          if (!control) this.ordinary += 1;
          if (slow) this.slow += 1;
          void Promise.resolve()
            .then(operation)
            .then(resolve, reject)
            .finally(() => {
              this.active -= 1;
              if (!control) this.ordinary -= 1;
              if (slow) this.slow -= 1;
              this.drain();
            });
        },
      };
      this.waiting.push(entry);
      signal?.addEventListener("abort", entry.cancel, { once: true });
      this.drain();
    });
  }
  private drain() {
    while (this.active < 4) {
      const eligible = (item: Waiting) => (item.control || this.ordinary < 3) && (!item.slow || this.slow < 2);
      const control = this.waiting.findIndex((item) => item.control && eligible(item));
      const index = control >= 0 ? control : this.waiting.findIndex(eligible);
      if (index < 0) return;
      this.waiting.splice(index, 1)[0]?.start();
    }
  }
}

export const requestBudget = new RequestBudget();
