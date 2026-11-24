import {
  RUNGS,
  RUNG_ORDER,
  type FrontierEntry,
  type FrontierFile,
  type ProviderFamily,
  type QuotaEntry,
  type QuotaFile,
  type QuotaState,
  type Rung,
  type RungConstraint,
  type TaskCategory,
  type Verifiability,
} from "./types.ts";

export type BlastRadius = "single_file" | "isolated_module" | "multi_module";

export interface RouteRequest {
  readonly required_rung: Rung;
  readonly category: TaskCategory;
  readonly verifiability: Verifiability;
  readonly blast_radius: BlastRadius;
  readonly author_family?: ProviderFamily;
  readonly live_models?: Readonly<Record<string, readonly string[]>>;
  readonly session_throttled_providers?: readonly string[];
  readonly now?: Date;
}

export interface RouteDecision {
  readonly entry: FrontierEntry;
  readonly effective_rung: Rung;
  readonly quota_state: QuotaState;
  readonly reason: string;
}

const VERIFIABILITY_RANK: Readonly<Record<Verifiability, number>> = {
  strict: 2,
  moderate: 1,
  subjective: 0,
};

const BLAST_RADIUS_RANK: Readonly<Record<BlastRadius, number>> = {
  single_file: 0,
  isolated_module: 1,
  multi_module: 2,
};

export function resolveQuotaState(
  entry: FrontierEntry,
  quota: QuotaFile,
  now: Date,
  sessionThrottled?: readonly string[],
): { readonly state: QuotaState; readonly reserveForMinRung: Rung } {
  if (sessionThrottled?.includes(entry.provider)) {
    return { state: "throttled", reserveForMinRung: "R2" };
  }
  const providerQuota = quota.providers[entry.provider];
  if (!providerQuota) {
    return { state: "normal", reserveForMinRung: "R2" };
  }
  const override: QuotaEntry | undefined =
    providerQuota.model_overrides?.[entry.model];
  const effective: QuotaEntry = override ?? providerQuota;

  let state: QuotaState = effective.state;
  if (state === "throttled" && effective.resets_at) {
    const resetDate = new Date(effective.resets_at);
    if (!Number.isNaN(resetDate.getTime()) && resetDate.getTime() <= now.getTime()) {
      state = "normal";
    }
  }

  return {
    state,
    reserveForMinRung: effective.reserve_for_min_rung ?? "R2",
  };
}

function satisfiesConstraint(
  constraint: RungConstraint | undefined,
  req: RouteRequest,
): boolean {
  if (!constraint) return true;
  if (
    constraint.min_verifiability &&
    VERIFIABILITY_RANK[req.verifiability] <
      VERIFIABILITY_RANK[constraint.min_verifiability]
  ) {
    return false;
  }
  if (
    constraint.allowed_categories &&
    !constraint.allowed_categories.includes(req.category)
  ) {
    return false;
  }
  if (
    constraint.max_blast_radius &&
    BLAST_RADIUS_RANK[req.blast_radius] >
      BLAST_RADIUS_RANK[constraint.max_blast_radius]
  ) {
    return false;
  }
  return true;
}

function isLive(
  entry: FrontierEntry,
  liveModels: Readonly<Record<string, readonly string[]>> | undefined,
): boolean {
  if (!liveModels) return true;
  const models = liveModels[entry.provider];
  if (!models) return false;
  return models.includes(entry.model);
}

export function selectRoute(
  frontier: FrontierFile,
  quota: QuotaFile,
  req: RouteRequest,
): RouteDecision | null {
  const now = req.now ?? new Date();
  const startIdx = RUNG_ORDER[req.required_rung];

  for (let idx = startIdx; idx < RUNGS.length; idx += 1) {
    const rung = RUNGS[idx];
    if (!rung) continue;

    // Step 1: Hard quality floor gate
    const eligible: Array<{
      readonly entry: FrontierEntry;
      readonly state: QuotaState;
      readonly reserveForMinRung: Rung;
    }> = [];

    for (const entry of frontier.entries) {
      if (!isLive(entry, req.live_models)) continue;
      if (!entry.rungs.includes(rung)) continue;
      if (RUNG_ORDER[rung] > RUNG_ORDER[entry.max_rung]) continue;
      if (!satisfiesConstraint(entry.rung_constraints?.[rung], req)) continue;

      const q = resolveQuotaState(
        entry,
        quota,
        now,
        req.session_throttled_providers,
      );
      if (q.state === "throttled") continue;
      eligible.push({
        entry,
        state: q.state,
        reserveForMinRung: q.reserveForMinRung,
      });
    }

    if (eligible.length === 0) continue;

    // Cross-provider separation for primary_review
    let pool = eligible;
    if (req.category === "primary_review" && req.author_family) {
      const crossFamily = eligible.filter(
        (c) => c.entry.family !== req.author_family,
      );
      if (crossFamily.length > 0) {
        pool = crossFamily;
      }
    }

    // Step 2: Quota pressure buckets
    const surplus = pool.filter((c) => c.state === "surplus");
    const normal = pool.filter((c) => c.state === "normal");
    const scarceEligible = pool.filter(
      (c) =>
        c.state === "scarce" &&
        RUNG_ORDER[rung] >= RUNG_ORDER[c.reserveForMinRung],
    );
    const scarceFallback = pool.filter((c) => c.state === "scarce");

    const chosenBucket =
      surplus.length > 0
        ? surplus
        : normal.length > 0
          ? normal
          : scarceEligible.length > 0
            ? scarceEligible
            : scarceFallback;

    if (chosenBucket.length === 0) continue;

    // Step 3: Pareto tie-break by rung_ranks[rung]
    const sorted = [...chosenBucket].sort((a, b) => {
      const aRank = a.entry.rung_ranks[rung] ?? 99;
      const bRank = b.entry.rung_ranks[rung] ?? 99;
      if (aRank !== bRank) return aRank - bRank;
      return a.entry.benchmarks.task_cost_usd - b.entry.benchmarks.task_cost_usd;
    });

    const winner = sorted[0];
    if (!winner) continue;

    const bumped =
      rung !== req.required_rung
        ? ` (bumped from ${req.required_rung} because no candidate cleared floor)`
        : "";
    return {
      entry: winner.entry,
      effective_rung: rung,
      quota_state: winner.state,
      reason: `Matched ${rung}${bumped} in '${winner.state}' bucket (rank #${winner.entry.rung_ranks[rung] ?? "?"})`,
    };
  }

  return null;
}

export function nextEscalationRung(current: Rung): Rung | null {
  const nextIdx = RUNG_ORDER[current] + 1;
  return RUNGS[nextIdx] ?? null;
}
