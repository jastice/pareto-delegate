import { VersionedCache } from "./cache.ts";
import { AbortError, InFlightRegistry } from "./queue.ts";

export type Loader<T> = (key: string, signal: AbortSignal) => Promise<T>;

/**
 * Deduplicating async cache coordinator.
 *
 * Requirements:
 * 1. Concurrent `load(key)` calls share a single in-flight upstream `loader(key, signal)` invocation.
 * 2. If one waiter's `signal` aborts, ONLY that waiter rejects with `AbortError`;
 *    other waiters on the same key must continue and resolve normally.
 *    The upstream `loader` signal should abort ONLY when ALL active waiters have aborted.
 * 3. If `invalidate(key)` or `set(key, value)` happens while a fetch is in flight,
 *    the stale in-flight fetch must NOT overwrite the cache with outdated data,
 *    and subsequent `load(key)` calls after invalidation must start a fresh fetch.
 */
export class AsyncCoordinator<T> {
  private readonly cache = new VersionedCache<T>();
  private readonly inflight = new InFlightRegistry<T>();
  private readonly loader: Loader<T>;

  constructor(loader: Loader<T>) {
    this.loader = loader;
  }

  set(key: string, value: T): void {
    this.cache.set(key, value);
  }

  invalidate(key: string): void {
    this.cache.invalidate(key);
  }

  inFlightCount(): number {
    return this.inflight.size();
  }

  async load(key: string, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      throw new AbortError();
    }
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    let entry = this.inflight.get(key);
    if (!entry) {
      const controller = new AbortController();
      const promise = this.loader(key, controller.signal)
        .then((val) => {
          this.cache.set(key, val);
          return val;
        })
        .finally(() => {
          this.inflight.delete(key);
        });
      entry = { promise, controller };
      this.inflight.set(key, entry);
    }

    if (signal) {
      signal.addEventListener("abort", () => {
        entry.controller.abort();
      });
    }

    return entry.promise;
  }
}
