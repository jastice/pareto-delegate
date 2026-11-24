export class AbortError extends Error {
  constructor(message = "Aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export interface InFlightEntry<T> {
  readonly promise: Promise<T>;
  readonly controller: AbortController;
}

export class InFlightRegistry<T> {
  private readonly entries = new Map<string, InFlightEntry<T>>();

  get(key: string): InFlightEntry<T> | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: InFlightEntry<T>): void {
    this.entries.set(key, entry);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  size(): number {
    return this.entries.size;
  }
}
