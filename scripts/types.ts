// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

/** Capability floors. R0 = scout-grade, R3 = apex. Floors are minimum role quality, not bands. */
export const FLOORS = ["R0", "R1", "R2", "R3"] as const;
export type Floor = (typeof FLOORS)[number];
/** Back-compat alias: older docs/overrides call floors "rungs". */
export type Rung = Floor;
export const RUNGS = FLOORS;

export const FLOOR_ORDER: Readonly<Record<Floor, number>> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
};
export const RUNG_ORDER = FLOOR_ORDER;

export const QUOTA_STATES = ["surplus", "normal", "scarce", "throttled"] as const;
export type QuotaState = (typeof QUOTA_STATES)[number];

export const VERIFIABILITY_LEVELS = ["strict", "moderate", "subjective"] as const;
export type Verifiability = (typeof VERIFIABILITY_LEVELS)[number];

export const BLAST_RADII = ["single_file", "isolated_module", "multi_module"] as const;
export type BlastRadius = (typeof BLAST_RADII)[number];

export const TASK_CATEGORIES = [
  "research",
  "log_triage",
  "doc_summary",
  "test_gen",
  "mechanical_refactor",
  "bugfix",
  "feature_slice",
  "architecture",
  "debugging",
  "primary_review",
  "second_opinion_review",
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export type ProviderFamily = "claude" | "gemini" | "grok" | "openai" | "other";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export type ProviderOptionValue = string | boolean | number;
export type ProviderOptions = Readonly<Record<string, ProviderOptionValue>>;

/** The AA intelligence index; every other metric is quantile-mapped onto its scale. */
export const BASE_METRIC = "artificial_analysis_intelligence_index";

// ---------------------------------------------------------------------------
// Benchmarks (benchmarks.json)
// ---------------------------------------------------------------------------

export interface AATokenCounts {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly reasoning_tokens?: number;
  readonly answer_tokens?: number;
}

export interface AAModelRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly creator: string;
  /** AA Intelligence Index. */
  readonly index: number;
  /** USD per 1M tokens. */
  readonly input: number;
  readonly output: number;
  readonly cache_hit?: number;
  readonly blended?: number;
  /** Cost (USD) per task when running the AA Intelligence Index suite. */
  readonly task: number;
  readonly tps: number;
  /** Seconds to first answer token (includes thinking for reasoning models). */
  readonly ttft: number;
  /** Raw AA evaluation scores keyed by AA field name (indices 0–100, per-eval scores usually 0–1). */
  readonly evals?: Readonly<Record<string, number>>;
  /** Tokens used to run the Intelligence Index, when a source reports them. */
  readonly tokens?: AATokenCounts;
  readonly url?: string;
}

export type BenchmarkSource = "artificial_analysis_mirror" | "artificial_analysis_api";

export interface CachedBenchmarksFile {
  readonly fetched_at: string;
  readonly source: BenchmarkSource;
  readonly source_url: string;
  readonly api_tier?: "free" | "pro";
  readonly intelligence_index_version: number;
  readonly attribution: string;
  readonly models: readonly AAModelRecord[];
}

// ---------------------------------------------------------------------------
// Frontier (frontier.json): pure AA-derived data, no overrides applied.
// ---------------------------------------------------------------------------

export interface CatalogModelSpec {
  readonly provider: string;
  readonly model: string;
  readonly family: ProviderFamily;
  readonly option_key: string;
  readonly allowed_efforts: readonly EffortLevel[];
}

export interface FrontierEntry {
  /** `${provider}:${model}:${effort}` */
  readonly id: string;
  readonly provider: string;
  readonly family: ProviderFamily;
  readonly model: string;
  readonly effort: EffortLevel;
  readonly options: ProviderOptions;
  readonly aa: {
    readonly slug: string;
    readonly name: string;
    readonly index: number;
    readonly input: number;
    readonly output: number;
    readonly cache_hit: number | null;
    readonly task: number;
    readonly tps: number;
    readonly ttft: number;
    /** Output tokens used on the AA suite (measured when reported, else estimated from cost). */
    readonly output_tokens: number;
    readonly output_tokens_measured: boolean;
  };
  /** Every available AA metric, quantile-mapped onto the intelligence-index scale. */
  readonly metrics: Readonly<Record<string, number>>;
}

export interface FrontierFile {
  readonly schema_version: 2;
  readonly generated_at: string;
  readonly benchmark_fetched_at: string;
  readonly source: BenchmarkSource;
  readonly source_url: string;
  readonly api_tier?: "free" | "pro";
  readonly intelligence_index_version: number;
  readonly attribution: string;
  /** Median AA-suite output tokens across the snapshot; verbosity = output_tokens / this. */
  readonly verbosity_reference_tokens: number;
  /** Number of snapshot models with both the metric and the base index (mapping support). */
  readonly metric_coverage: Readonly<Record<string, number>>;
  readonly catalog: readonly CatalogModelSpec[];
  readonly entries: readonly FrontierEntry[];
  readonly tracked_models: readonly string[];
  readonly unmatched_models: readonly string[];
}

// ---------------------------------------------------------------------------
// Tunables (roles.json + roles.local.json)
// ---------------------------------------------------------------------------

export interface TokenProfile {
  /** Total input tokens per delegated attempt (summed over agent turns). */
  readonly input: number;
  /** Share of input billed at the cache-hit price. */
  readonly cache_hit_share: number;
  /** Output tokens per attempt for a model of reference verbosity. */
  readonly output: number;
  /** Agent turns per attempt (each pays a share of TTFT). */
  readonly turns: number;
}

export interface RoleSpec {
  readonly description?: string;
  /** AA metric name -> weight. Missing metrics are skipped; weights renormalize. */
  readonly metrics: Readonly<Record<string, number>>;
  /** Minimum role quality (intelligence-index points) per floor. */
  readonly floors?: Readonly<Partial<Record<Floor, number>>>;
  readonly tokens: TokenProfile;
  /** $ equivalent of one minute of wall-clock waiting. */
  readonly value_per_minute_usd: number;
  /** $ equivalent of a failed first attempt (rework, escalation, your attention), per floor. */
  readonly failure_cost_usd: Readonly<Record<Floor, number>>;
  readonly max_ttft_s?: Readonly<Partial<Record<Floor, number>>>;
  readonly verbosity_exponent?: number;
  readonly p_pass_at_floor?: number;
  readonly logistic_scale?: number;
  /** Require a different model family than the author when one is eligible. */
  readonly cross_family?: boolean;
}

export type RoleName = string;

export interface RolesFile {
  readonly schema_version: 1;
  readonly defaults: {
    readonly floors: Readonly<Record<Floor, number>>;
    readonly max_ttft_s: Readonly<Record<Floor, number>>;
    /** P(pass first try) for a model exactly at the floor. */
    readonly p_pass_at_floor: number;
    /** Logistic slope in quality points; smaller = sharper pass/fail transition. */
    readonly logistic_scale: number;
    readonly verbosity_exponent: number;
    /** Fraction of AA TTFT paid per agent turn. */
    readonly turn_latency_factor: number;
    /** Cache-hit price as a fraction of input price when AA has no cache price. */
    readonly cache_hit_price_ratio: number;
    /** Minimum snapshot models carrying a metric before it is used. */
    readonly min_metric_coverage: number;
    /** Latency value multiplier for --background tasks (nobody waits on them). */
    readonly background_latency_factor: number;
    /** A strict gate catches failures cheaply; subjective failures surface late. */
    readonly failure_cost_by_verifiability: Readonly<Record<Verifiability, number>>;
    readonly floor_adjustments: {
      readonly strict_single_file: number;
      readonly subjective: number;
    };
  };
  readonly quota_cost_multipliers: Readonly<Record<Exclude<QuotaState, "throttled">, number>>;
  readonly category_roles: Readonly<Record<TaskCategory, RoleName>>;
  readonly roles: Readonly<Record<RoleName, RoleSpec>>;
}

// ---------------------------------------------------------------------------
// Overrides (overrides.json + overrides.local.json), applied at route time
// ---------------------------------------------------------------------------

export interface FloorConstraint {
  readonly min_verifiability?: Verifiability;
  readonly allowed_categories?: readonly TaskCategory[];
  readonly max_blast_radius?: BlastRadius;
}

export interface EntryOverride {
  readonly exclude?: boolean;
  readonly max_floor?: Floor;
  readonly allowed_roles?: readonly RoleName[];
  readonly floor_constraints?: Readonly<Partial<Record<Floor, FloorConstraint>>>;
  /** Quality points added to role quality: a number (all roles) or per role. Main calibration knob. */
  readonly quality_bias?: number | Readonly<Record<RoleName, number>>;
  /** Multiplies estimated $ cost (e.g. plan pricing differs from API list price). */
  readonly cost_multiplier?: number;
  readonly notes?: string;
  /** Legacy names, still accepted. */
  readonly max_rung?: Floor;
  readonly rung_constraints?: Readonly<Partial<Record<Floor, FloorConstraint>>>;
}

/** Keys: "provider:*", "provider:model", or "provider:model:effort" (most specific wins per field). */
export interface OverridesFile {
  readonly schema_version: number;
  readonly overrides?: Readonly<Record<string, EntryOverride>>;
  /** Legacy split maps, still accepted. */
  readonly model_overrides?: Readonly<Record<string, EntryOverride>>;
  readonly entry_overrides?: Readonly<Record<string, EntryOverride>>;
}

// ---------------------------------------------------------------------------
// Quota (quota.json / quota.local.json)
// ---------------------------------------------------------------------------

export interface QuotaEntry {
  readonly state: QuotaState;
  readonly reserve_for_min_rung?: Floor;
  readonly resets_at?: string | null;
  readonly notes?: string;
}

export interface ProviderQuota extends QuotaEntry {
  readonly model_overrides?: Readonly<Record<string, QuotaEntry>>;
}

export interface QuotaFile {
  readonly schema_version: 1;
  readonly updated_at: string;
  readonly providers: Readonly<Record<string, ProviderQuota>>;
}

// ---------------------------------------------------------------------------
// Telemetry (outcomes.jsonl)
// ---------------------------------------------------------------------------

export interface OutcomeRecord {
  readonly ts: string;
  readonly category: TaskCategory;
  readonly role: RoleName;
  readonly floor: Floor;
  readonly verifiability: Verifiability;
  readonly entry_id: string;
  readonly quota_state: QuotaState;
  readonly p_pass_est: number;
  readonly cost_est_usd: number;
  readonly passed_first_try: boolean;
  readonly review_passed?: boolean | null;
  readonly escalated_to?: Floor | null;
  readonly duration_s?: number;
  readonly notes?: string;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isFloor(value: unknown): value is Floor {
  return typeof value === "string" && (FLOORS as readonly string[]).includes(value);
}
export const isRung = isFloor;

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export function isTaskCategory(value: unknown): value is TaskCategory {
  return typeof value === "string" && (TASK_CATEGORIES as readonly string[]).includes(value);
}

export function isVerifiability(value: unknown): value is Verifiability {
  return (
    typeof value === "string" && (VERIFIABILITY_LEVELS as readonly string[]).includes(value)
  );
}

export function isBlastRadius(value: unknown): value is BlastRadius {
  return typeof value === "string" && (BLAST_RADII as readonly string[]).includes(value);
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) {
    if (isFiniteNumber(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Accepts both the v1 mirror shape and the v2 cache shape (with evals/tokens/cache_hit). */
export function parseAAModelRecord(value: unknown): AAModelRecord | null {
  if (!isRecord(value)) return null;
  const v = value;
  if (
    !isNonEmptyString(v["id"]) ||
    !isNonEmptyString(v["name"]) ||
    !isNonEmptyString(v["slug"]) ||
    !isFiniteNumber(v["index"]) ||
    !isFiniteNumber(v["input"]) ||
    !isFiniteNumber(v["output"]) ||
    !isFiniteNumber(v["task"]) ||
    !isFiniteNumber(v["tps"]) ||
    !isFiniteNumber(v["ttft"])
  ) {
    return null;
  }
  const evals = numberRecord(v["evals"]);
  const tokens = numberRecord(v["tokens"]);
  return {
    id: v["id"],
    name: v["name"],
    slug: v["slug"],
    creator: isNonEmptyString(v["creator"]) ? v["creator"] : "Unknown",
    index: v["index"],
    input: v["input"],
    output: v["output"],
    ...(isFiniteNumber(v["cache_hit"]) ? { cache_hit: v["cache_hit"] } : {}),
    ...(isFiniteNumber(v["blended"]) ? { blended: v["blended"] } : {}),
    task: v["task"],
    tps: v["tps"],
    ttft: v["ttft"],
    ...(evals ? { evals } : {}),
    ...(tokens ? { tokens } : {}),
    ...(isNonEmptyString(v["url"]) ? { url: v["url"] } : {}),
  };
}
