export class LruCache<K, V> {
  readonly #values = new Map<K, V>();

  constructor(
    readonly capacity: number,
    private readonly onEvict?: (key: K, value: V) => void,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("LRU capacity must be a positive integer");
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: K): V | undefined {
    const value = this.#values.get(key);
    if (value === undefined) return undefined;
    this.#values.delete(key);
    this.#values.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.#values.delete(key);
    this.#values.set(key, value);
    while (this.#values.size > this.capacity) {
      const oldest = this.#values.entries().next().value as [K, V] | undefined;
      if (!oldest) break;
      this.#values.delete(oldest[0]);
      this.onEvict?.(oldest[0], oldest[1]);
    }
  }

  delete(key: K): boolean {
    return this.#values.delete(key);
  }

  clear(): void {
    this.#values.clear();
  }
}
