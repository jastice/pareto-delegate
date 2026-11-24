/**
 * Pure scoring model shared by sync (precompute) and route (runtime).
 *
 * Quality: every AA metric is quantile-mapped onto the intelligence-index scale, so a role's
 * composite (weighted mean of whatever metrics exist) is in familiar "index points" no matter
 * whether the data came from the mirror (index only), the free API (+coding/agentic indices)
 * or the Pro API (+per-eval scores).
 *
 * Cost of one attempt:
 *   E = quota_mult * cost_multiplier * $tokens + value_per_minute * minutes + (1 - P(pass)) * failure_cost
 * with P(pass) logistic in (quality - floor), pinned so P = p_pass_at_floor exactly at the floor.
 */
import {
  BASE_METRIC,
  FLOOR_ORDER,
  type AAModelRecord,
  type BlastRadius,
  type EntryOverride,
  type Floor,
  type FloorConstraint,
  type FrontierEntry,
  type FrontierFile,
  type OverridesFile,
  type RoleSpec,
  type RolesFile,
  type TaskCategory,
  type Verifiability,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Metric normalization (sync time)
// ---------------------------------------------------------------------------

export function metricValue(record: AAModelRecord, metric: string): number | undefined {
  if (metric === BASE_METRIC) return record.index;
  const v = record.evals?.[metric];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function interpolate(sorted: readonly number[], pos: number): number {
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? sorted[0] ?? 0;
  const b = sorted[hi] ?? sorted[sorted.length - 1] ?? a;
  return a + (b - a) * (pos - lo);
}

/**
 * Build a mapper metric-value -> intelligence-index-equivalent using models that report both.
 * Equal-percentile mapping: a model at the 80th percentile on terminalbench_hard maps to the
 * index value at the 80th percentile. Robust to scale (0–1 vs 0–100) and AA re-normalizations.
 */
export function buildQuantileMapper(
  records: readonly AAModelRecord[],
  metric: string,
): { readonly map: (x: number) => number; readonly n: number } | null {
  if (metric === BASE_METRIC) {
    return { map: (x) => x, n: records.length };
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of records) {
    const x = metricValue(r, metric);
    if (x === undefined) continue;
    xs.push(x);
    ys.push(r.index);
  }
  const n = xs.length;
  if (n < 2) return null;
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const map = (x: number): number => {
    let lt = 0;
    let eq = 0;
    for (const v of xs) {
      if (v < x) lt += 1;
      else if (v === x) eq += 1;
    }
    const rank = Math.min(Math.max(lt + Math.max(eq - 1, 0) / 2, 0), n - 1);
    return interpolate(ys, rank);
  };
  return { map, n };
}

export function collectMetricNames(records: readonly AAModelRecord[]): readonly string[] {
  const names = new Set<string>([BASE_METRIC]);
  for (const r of records) {
    for (const k of Object.keys(r.evals ?? {})) names.add(k);
  }
  return [...names].sort();
}

/** AA-suite output tokens: measured when the Pro tier provides counts, else cost / output price. */
export function aaOutputTokens(record: AAModelRecord): { tokens: number; measured: boolean } {
  const t = record.tokens;
  const measured =
    t?.output_tokens ??
    (t?.reasoning_tokens !== undefined || t?.answer_tokens !== undefined
      ? (t?.reasoning_tokens ?? 0) + (t?.answer_tokens ?? 0)
      : undefined);
  if (measured !== undefined && measured > 0) return { tokens: measured, measured: true };
  const est = record.output > 0 ? (record.task / record.output) * 1e6 : 0;
  return { tokens: est, measured: false };
}

export function median(values: readonly number[]): number {
  const s = [...values].filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (s.length === 0) return 1;
  const mid = (s.length - 1) / 2;
  return interpolate(s, mid);
}

// ---------------------------------------------------------------------------
// Overrides (route time)
// ---------------------------------------------------------------------------

export interface ResolvedOverride {
  readonly exclude: boolean;
  readonly max_floor: Floor | undefined;
  readonly allowed_roles: readonly string[] | undefined;
  readonly floor_constraints: Readonly<Partial<Record<Floor, FloorConstraint>>>;
  readonly quality_bias: (role: string) => number;
  readonly cost_multiplier: number;
  readonly notes: readonly string[];
}

function overrideLayers(entry: FrontierEntry, file: OverridesFile): readonly EntryOverride[] {
  const keys = [
    `${entry.provider}:*`,
    `${entry.provider}:${entry.model}`,
    entry.id,
  ];
  const layers: EntryOverride[] = [];
  for (const key of keys) {
    for (const map of [file.model_overrides, file.entry_overrides, file.overrides]) {
      const o = map?.[key];
      if (o) layers.push(o);
    }
  }
  return layers;
}

export function resolveOverride(entry: FrontierEntry, file: OverridesFile): ResolvedOverride {
  let exclude = false;
  let maxFloor: Floor | undefined;
  let allowedRoles: readonly string[] | undefined;
  const constraints: Partial<Record<Floor, FloorConstraint>> = {};
  const biases: Array<EntryOverride["quality_bias"]> = [];
  let costMult = 1;
  const notes: string[] = [];

  for (const o of overrideLayers(entry, file)) {
    if (o.exclude !== undefined) exclude = o.exclude;
    const mf = o.max_floor ?? o.max_rung;
    if (mf !== undefined) maxFloor = mf;
    if (o.allowed_roles !== undefined) allowedRoles = o.allowed_roles;
    Object.assign(constraints, o.rung_constraints ?? {}, o.floor_constraints ?? {});
    if (o.quality_bias !== undefined) biases.push(o.quality_bias);
    if (o.cost_multiplier !== undefined) costMult *= o.cost_multiplier;
    if (o.notes) notes.push(o.notes);
  }

  return {
    exclude,
    max_floor: maxFloor,
    allowed_roles: allowedRoles,
    floor_constraints: constraints,
    quality_bias: (role) =>
      biases.reduce<number>(
        (sum, b) => sum + (typeof b === "number" ? b : (b?.[role] ?? 0)),
        0,
      ),
    cost_multiplier: costMult,
    notes,
  };
}

const VERIFIABILITY_RANK: Readonly<Record<Verifiability, number>> = {
  subjective: 0,
  moderate: 1,
  strict: 2,
};
const BLAST_RANK: Readonly<Record<BlastRadius, number>> = {
  single_file: 0,
  isolated_module: 1,
  multi_module: 2,
};

export function satisfiesConstraint(
  c: FloorConstraint | undefined,
  task: { category: TaskCategory; verifiability: Verifiability; blast_radius: BlastRadius },
): boolean {
  if (!c) return true;
  if (c.min_verifiability && VERIFIABILITY_RANK[task.verifiability] < VERIFIABILITY_RANK[c.min_verifiability]) {
    return false;
  }
  if (c.allowed_categories && !c.allowed_categories.includes(task.category)) return false;
  if (c.max_blast_radius && BLAST_RANK[task.blast_radius] > BLAST_RANK[c.max_blast_radius]) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Role quality, cost, latency, pass probability
// ---------------------------------------------------------------------------

export function roleQuality(
  entry: FrontierEntry,
  role: RoleSpec,
): { readonly quality: number; readonly used: Readonly<Record<string, number>>; readonly coverage: number } {
  let sum = 0;
  let wsum = 0;
  let wtotal = 0;
  const used: Record<string, number> = {};
  for (const [metric, w] of Object.entries(role.metrics)) {
    if (w <= 0) continue;
    wtotal += w;
    const v = entry.metrics[metric];
    if (v === undefined) continue;
    sum += w * v;
    wsum += w;
    used[metric] = v;
  }
  if (wsum === 0) {
    // No configured metric available at all: fall back to the base index.
    return { quality: entry.aa.index, used: { [BASE_METRIC]: entry.aa.index }, coverage: 0 };
  }
  return { quality: sum / wsum, used, coverage: wtotal > 0 ? wsum / wtotal : 0 };
}

export function floorValue(roles: RolesFile, role: RoleSpec, floor: Floor): number {
  return role.floors?.[floor] ?? roles.defaults.floors[floor];
}

export function maxTtft(roles: RolesFile, role: RoleSpec, floor: Floor): number {
  return role.max_ttft_s?.[floor] ?? roles.defaults.max_ttft_s[floor];
}

export function passProbability(
  quality: number,
  floorQuality: number,
  pAtFloor: number,
  scale: number,
): number {
  const p0 = Math.min(Math.max(pAtFloor, 0.01), 0.99);
  const logit0 = Math.log(p0 / (1 - p0));
  const z = (quality - floorQuality) / Math.max(scale, 1e-6) + logit0;
  return 1 / (1 + Math.exp(-z));
}

export interface AttemptEstimate {
  readonly verbosity: number;
  readonly token_cost_usd: number;
  readonly time_s: number;
}

export function estimateAttempt(
  entry: FrontierEntry,
  role: RoleSpec,
  roles: RolesFile,
  frontier: Pick<FrontierFile, "verbosity_reference_tokens">,
): AttemptEstimate {
  const exp = role.verbosity_exponent ?? roles.defaults.verbosity_exponent;
  const ref = frontier.verbosity_reference_tokens > 0 ? frontier.verbosity_reference_tokens : 1;
  const verbosity = Math.pow(Math.max(entry.aa.output_tokens, 1) / ref, exp);
  const t = role.tokens;
  const cachePrice = entry.aa.cache_hit ?? entry.aa.input * roles.defaults.cache_hit_price_ratio;
  const share = Math.min(Math.max(t.cache_hit_share, 0), 1);
  const outTokens = t.output * verbosity;
  const tokenCost =
    (t.input * (1 - share) * entry.aa.input + t.input * share * cachePrice + outTokens * entry.aa.output) /
    1e6;
  const tps = entry.aa.tps > 0 ? entry.aa.tps : 50;
  const time = t.turns * entry.aa.ttft * roles.defaults.turn_latency_factor + outTokens / tps;
  return { verbosity, token_cost_usd: tokenCost, time_s: time };
}

export function adjustFloor(
  floor: Floor,
  verifiability: Verifiability,
  blast: BlastRadius,
  roles: RolesFile,
): Floor {
  let idx = FLOOR_ORDER[floor];
  if (verifiability === "strict" && blast === "single_file") {
    idx += roles.defaults.floor_adjustments.strict_single_file;
  }
  if (verifiability === "subjective") {
    idx += roles.defaults.floor_adjustments.subjective;
  }
  idx = Math.min(Math.max(idx, 0), 3);
  const floors: readonly Floor[] = ["R0", "R1", "R2", "R3"];
  return floors[idx] ?? floor;
}
