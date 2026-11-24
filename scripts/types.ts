export const RUNGS = ["R0", "R1", "R2", "R3"] as const;
export type Rung = (typeof RUNGS)[number];

export const RUNG_ORDER: Readonly<Record<Rung, number>> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
};

export const QUOTA_STATES = ["surplus", "normal", "scarce", "throttled"] as const;
export type QuotaState = (typeof QUOTA_STATES)[number];

export const VERIFIABILITY_LEVELS = ["strict", "moderate", "subjective"] as const;
export type Verifiability = (typeof VERIFIABILITY_LEVELS)[number];

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

export interface CatalogModelSpec {
  readonly provider: string;
  readonly model: string;
  readonly family: ProviderFamily;
  readonly option_key: string;
  readonly allowed_efforts: readonly EffortLevel[];
}

export interface RungConstraint {
  readonly min_verifiability?: Verifiability;
  readonly allowed_categories?: readonly TaskCategory[];
  readonly max_blast_radius?: "single_file" | "isolated_module" | "multi_module";
}

export interface BenchmarkMetrics {
  readonly source: "artificial_analysis_mirror" | "artificial_analysis_api";
  readonly aa_slug: string;
  readonly aa_name: string;
  readonly intelligence_index: number;
  readonly task_cost_usd: number;
  readonly blended_price_per_1m: number;
  readonly output_tps: number;
  readonly ttft_s: number;
}

export interface FrontierEntry {
  readonly id: string;
  readonly provider: string;
  readonly family: ProviderFamily;
  readonly model: string;
  readonly options: ProviderOptions;
  readonly primary_rung: Rung;
  readonly rungs: readonly Rung[];
  readonly max_rung: Rung;
  readonly rung_constraints?: Readonly<Partial<Record<Rung, RungConstraint>>>;
  readonly global_pareto: boolean;
  readonly provider_pareto: boolean;
  readonly rung_ranks: Readonly<Partial<Record<Rung, number>>>;
  readonly benchmarks: BenchmarkMetrics;
  readonly notes?: string;
}

export interface RungThreshold {
  readonly min_index: number;
  readonly max_index_exclusive: number | null;
  readonly max_ttft_s: number;
}

export interface FrontierFile {
  readonly schema_version: 1;
  readonly generated_at: string;
  readonly benchmark_fetched_at: string;
  readonly intelligence_index_version: number;
  readonly source_url: string;
  readonly attribution: string;
  readonly rung_thresholds: Readonly<Record<Rung, RungThreshold>>;
  readonly catalog: readonly CatalogModelSpec[];
  readonly entries: readonly FrontierEntry[];
  readonly tracked_models: readonly string[];
  readonly unmatched_models: readonly string[];
}

export interface EntryOverride {
  readonly exclude?: boolean;
  readonly max_rung?: Rung;
  readonly extra_rungs?: readonly Rung[];
  readonly rung_constraints?: Readonly<Partial<Record<Rung, RungConstraint>>>;
  readonly rank_bias?: number;
  readonly notes?: string;
}

export interface OverridesFile {
  readonly schema_version: 1;
  readonly rung_thresholds?: Readonly<Partial<Record<Rung, Partial<RungThreshold>>>>;
  readonly max_entries_per_provider_rung?: number;
  readonly model_overrides?: Readonly<Record<string, EntryOverride>>;
  readonly entry_overrides?: Readonly<Record<string, EntryOverride>>;
}

export interface QuotaEntry {
  readonly state: QuotaState;
  readonly reserve_for_min_rung?: Rung;
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

export interface OutcomeRecord {
  readonly ts: string;
  readonly task_type: TaskCategory;
  readonly estimated_rung: Rung;
  readonly verifiability: Verifiability;
  readonly provider: string;
  readonly model: string;
  readonly options: ProviderOptions;
  readonly quota_state: QuotaState;
  readonly passed_first_try: boolean;
  readonly review_passed: boolean | null;
  readonly escalated_to: Rung | null;
  readonly duration_s: number;
  readonly notes?: string;
}

export interface AAModelRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly creator: string;
  readonly index: number;
  readonly blended: number;
  readonly input: number;
  readonly output: number;
  readonly task: number;
  readonly tps: number;
  readonly ttft: number;
  readonly url?: string;
}

export interface CachedBenchmarksFile {
  readonly fetched_at: string;
  readonly source: "artificial_analysis_mirror" | "artificial_analysis_api";
  readonly source_url: string;
  readonly intelligence_index_version: number;
  readonly attribution: string;
  readonly models: readonly AAModelRecord[];
}

export interface AASnapshot {
  readonly fetched_at: string;
  readonly source: string;
  readonly intelligence_index_version: number;
  readonly attribution: string;
  readonly models: readonly AAModelRecord[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isRung(value: unknown): value is Rung {
  return typeof value === "string" && (RUNGS as readonly string[]).includes(value);
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return (
    typeof value === "string" &&
    (EFFORT_LEVELS as readonly string[]).includes(value)
  );
}

export function isAAModelRecord(value: unknown): value is AAModelRecord {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value["id"]) &&
    isNonEmptyString(value["name"]) &&
    isNonEmptyString(value["slug"]) &&
    isNonEmptyString(value["creator"]) &&
    isFiniteNumber(value["index"]) &&
    isFiniteNumber(value["blended"]) &&
    isFiniteNumber(value["input"]) &&
    isFiniteNumber(value["output"]) &&
    isFiniteNumber(value["task"]) &&
    isFiniteNumber(value["tps"]) &&
    isFiniteNumber(value["ttft"])
  );
}

export function parseAASnapshot(raw: unknown): AASnapshot {
  if (!isRecord(raw)) {
    throw new Error("Artificial Analysis snapshot must be a JSON object.");
  }
  const modelsRaw = raw["models"];
  if (!Array.isArray(modelsRaw)) {
    throw new Error("Artificial Analysis snapshot is missing 'models' array.");
  }
  const models: AAModelRecord[] = [];
  for (const item of modelsRaw) {
    if (isAAModelRecord(item)) {
      models.push(item);
    }
  }
  if (models.length === 0) {
    throw new Error("Artificial Analysis snapshot contained zero valid model records.");
  }
  const versionRaw = raw["intelligence_index_version"];
  const version = isFiniteNumber(versionRaw) ? versionRaw : 5;
  return {
    fetched_at: isNonEmptyString(raw["fetched_at"])
      ? raw["fetched_at"]
      : new Date().toISOString(),
    source: isNonEmptyString(raw["source"]) ? raw["source"] : "Artificial Analysis",
    intelligence_index_version: version,
    attribution: isNonEmptyString(raw["attribution"])
      ? raw["attribution"]
      : "Data provided by Artificial Analysis (https://artificialanalysis.ai/)",
    models,
  };
}
