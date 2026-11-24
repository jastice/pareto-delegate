export interface CacheRecord<T> {
  readonly value: T;
  readonly updatedAt: number;
}

export class VersionedCache<T> {
  private readonly store = new Map<string, CacheRecord<T>>();

  get(key: string): T | undefined {
    return this.store.get(key)?.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, updatedAt: Date.now() });
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  size(): number {
    return this.store.size;
  }
}
