export interface RateLimiterOptions {
  readonly capacity: number;
  readonly refillPerSecond: number;
  readonly nowMs?: () => number;
}

export interface ConsumeResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly nowMs: () => number;
  private tokens: number;
  private lastRefillMs: number;

  constructor(options: RateLimiterOptions) {
    if (!Number.isFinite(options.capacity) || options.capacity <= 0) {
      throw new RangeError("capacity must be a positive finite number");
    }
    if (!Number.isFinite(options.refillPerSecond) || options.refillPerSecond <= 0) {
      throw new RangeError("refillPerSecond must be a positive finite number");
    }
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.tokens = options.capacity;
    this.lastRefillMs = this.nowMs();
  }

  private refill(): void {
    const now = this.nowMs();
    if (now <= this.lastRefillMs) return;
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSecond);
    this.lastRefillMs = now;
  }

  consume(cost = 1): ConsumeResult {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new RangeError("cost must be a positive finite number");
    }
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { allowed: true, remaining: this.tokens, retryAfterMs: 0 };
    }
    const deficit = cost - this.tokens;
    const retryAfterMs = Math.ceil((deficit / this.refillPerSecond) * 1000);
    return { allowed: false, remaining: this.tokens, retryAfterMs };
  }

  peek(): number {
    this.refill();
    return this.tokens;
  }

  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillMs = this.nowMs();
  }
}
