export type QuotaState = "surplus" | "normal" | "scarce" | "throttled";

export interface WindowRule {
  /** 0 = Sunday .. 6 = Saturday (UTC) */
  readonly resetWeekdayUtc: number;
  /** 0..23 (UTC) */
  readonly resetHourUtc: number;
}

export interface ProviderStatus {
  readonly state: QuotaState;
  readonly resetsAt: string | null;
}

/**
 * Compute the next UTC reset timestamp strictly after `now` matching `rule`.
 */
export function nextResetUtc(now: Date, rule: WindowRule): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  const currentWeekday = now.getUTCDay();

  let deltaDays = rule.resetWeekdayUtc - currentWeekday;
  if (deltaDays < 0) {
    deltaDays += 7;
  }
  const candidate = new Date(
    Date.UTC(year, month, day + deltaDays, rule.resetHourUtc, 0, 0, 0),
  );
  if (candidate.getTime() < now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 7);
  }
  return candidate;
}

/**
 * Return effective state at `now`.
 * A `throttled` status recovers to `normal` once `resetsAt <= now`.
 * Invalid or malformed `resetsAt` strings must not throw and should keep the stored state.
 */
export function effectiveState(status: ProviderStatus, now: Date): QuotaState {
  if (status.state !== "throttled" || !status.resetsAt) {
    return status.state;
  }
  const nowIso = now.toISOString();
  if (status.resetsAt < nowIso) {
    return "normal";
  }
  return "throttled";
}
