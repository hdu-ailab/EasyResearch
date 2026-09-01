export class SessionStatsNotifier {
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify = (): void => {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Stats are observational and never control Pi lifecycle progress.
      }
    }
  };
}
