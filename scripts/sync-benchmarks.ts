import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EFFORT_LEVELS,
  RUNGS,
  RUNG_ORDER,
  isEffortLevel,
  isFiniteNumber,
  isNonEmptyString,
  isRecord,
  parseAASnapshot,
  type AAModelRecord,
  type AASnapshot,
  type CachedBenchmarksFile,
  type CatalogModelSpec,
  type EffortLevel,
  type EntryOverride,
  type FrontierEntry,
  type FrontierFile,
  type OverridesFile,
  type ProviderFamily,
  type ProviderOptions,
  type Rung,
  type RungConstraint,
  type RungThreshold,
} from "./types.ts";

const MIRROR_URL =
  "https://raw.githubusercontent.com/terryds/bestvaluemodel/main/data/models.json";
const AA_API_URL = "https://artificialanalysis.ai/api/v2/language/models/free";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BENCHMARKS_PATH = resolve(ROOT_DIR, "benchmarks.json");
const FRONTIER_PATH = resolve(ROOT_DIR, "frontier.json");
const OVERRIDES_PATH = resolve(ROOT_DIR, "overrides.json");
const LOCAL_OVERRIDES_PATH = resolve(ROOT_DIR, "overrides.local.json");

const DEFAULT_RUNG_THRESHOLDS: Readonly<Record<Rung, RungThreshold>> = {
  R0: { min_index: 24, max_index_exclusive: 40, max_ttft_s: 30 },
  R1: { min_index: 40, max_index_exclusive: 50, max_ttft_s: 45 },
  R2: { min_index: 50, max_index_exclusive: 58, max_ttft_s: 65 },
  R3: { min_index: 58, max_index_exclusive: null, max_ttft_s: 150 },
};

const EFFORT_OPTION_KEYS = ["effort", "thought_level", "reasoning_effort"] as const;

const PROVIDER_DEFAULTS: Readonly<
  Record<string, { readonly option_key: string; readonly allowed_efforts: readonly EffortLevel[] }>
> = {
  claudeAgent: {
    option_key: "effort",
    allowed_efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  antigravity: {
    option_key: "thought_level",
    allowed_efforts: ["low", "medium", "high", "xhigh"],
  },
  cursor: {
    option_key: "reasoning_effort",
    allowed_efforts: ["low", "medium", "high", "xhigh"],
  },
  codex: {
    option_key: "reasoning_effort",
    allowed_efforts: ["low", "medium", "high", "xhigh"],
  },
  grok: {
    option_key: "reasoning_effort",
    allowed_efforts: ["low", "medium", "high", "xhigh"],
  },
};

const IGNORED_MODEL_PATTERNS: readonly RegExp[] = [
  /^default$/i,
  /^auto$/i,
  /orchestrator/i,
];

const SEED_CATALOG: readonly CatalogModelSpec[] = [
  buildCatalogSpec("claudeAgent", "claude-haiku-5-5"),
  buildCatalogSpec("claudeAgent", "claude-sonnet-5-5"),
  buildCatalogSpec("claudeAgent", "claude-opus-5-5"),
  buildCatalogSpec("claudeAgent", "claude-fable-5-2"),
  buildCatalogSpec("antigravity", "gemini-4-hydrogen"),
  buildCatalogSpec("antigravity", "gemini-4-neon"),
  buildCatalogSpec("antigravity", "gemini-4-carbon"),
  buildCatalogSpec("cursor", "grok-4.7"),
];

interface MappedCandidate {
  readonly id: string;
  readonly provider: string;
  readonly family: ProviderFamily;
  readonly model: string;
  readonly effort: EffortLevel;
  readonly options: ProviderOptions;
  readonly record: AAModelRecord;
  readonly source: "artificial_analysis_mirror" | "artificial_analysis_api";
}

interface CliArgs {
  readonly source: "auto" | "mirror" | "api";
  readonly refresh: boolean;
  readonly offline: boolean;
  readonly dryRun: boolean;
  readonly replaceCatalog: boolean;
  readonly modelsArg: readonly string[] | null;
  readonly capabilitiesPath: string | null;
  readonly checkModels: readonly string[] | null;
}

function inferFamily(model: string, provider: string): ProviderFamily {
  const lower = model.toLowerCase();
  if (lower.startsWith("claude")) return "claude";
  if (lower.startsWith("gemini")) return "gemini";
  if (lower.startsWith("grok")) return "grok";
  if (
    lower.startsWith("gpt") ||
    lower.startsWith("codex") ||
    /^o[134]($|-)/.test(lower)
  ) {
    return "openai";
  }
  const pLower = provider.toLowerCase();
  if (pLower.includes("claude")) return "claude";
  if (pLower.includes("antigravity") || pLower.includes("gemini")) return "gemini";
  if (pLower.includes("grok")) return "grok";
  if (pLower.includes("codex") || pLower.includes("openai")) return "openai";
  return "other";
}

function buildCatalogSpec(
  provider: string,
  model: string,
  optionKey?: string,
  allowedEfforts?: readonly EffortLevel[],
): CatalogModelSpec {
  const defaults = PROVIDER_DEFAULTS[provider] ?? {
    option_key: "effort",
    allowed_efforts: ["low", "medium", "high", "xhigh", "max"] as const,
  };
  return {
    provider,
    model,
    family: inferFamily(model, provider),
    option_key: optionKey ?? defaults.option_key,
    allowed_efforts:
      allowedEfforts && allowedEfforts.length > 0
        ? allowedEfforts
        : defaults.allowed_efforts,
  };
}

function isIgnoredModel(model: string): boolean {
  return IGNORED_MODEL_PATTERNS.some((re) => re.test(model.trim()));
}

function normalizeModelToAASlug(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/[._\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseArgs(argv: readonly string[]): CliArgs {
  let source: "auto" | "mirror" | "api" = "auto";
  let refresh = false;
  let offline = false;
  let dryRun = false;
  let replaceCatalog = false;
  let modelsArg: readonly string[] | null = null;
  let capabilitiesPath: string | null = null;
  let checkModels: readonly string[] | null = null;

  const takeValue = (index: number, flag: string): string => {
    const next = argv[index + 1];
    if (!next) throw new Error(`${flag} requires a value.`);
    return next;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--refresh") {
      refresh = true;
    } else if (arg === "--offline") {
      offline = true;
    } else if (arg === "--replace-catalog") {
      replaceCatalog = true;
    } else if (arg === "--source=mirror") {
      source = "mirror";
    } else if (arg === "--source=api") {
      source = "api";
    } else if (arg === "--models") {
      modelsArg = takeValue(i, "--models")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      i += 1;
    } else if (arg?.startsWith("--models=")) {
      modelsArg = arg
        .slice("--models=".length)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (arg === "--capabilities") {
      capabilitiesPath = takeValue(i, "--capabilities");
      i += 1;
    } else if (arg?.startsWith("--capabilities=")) {
      capabilitiesPath = arg.slice("--capabilities=".length);
    } else if (arg === "--check-models") {
      checkModels = takeValue(i, "--check-models")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      i += 1;
    } else if (arg?.startsWith("--check-models=")) {
      checkModels = arg
        .slice("--check-models=".length)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: bun run scripts/sync-benchmarks.ts [options]

Options:
  --models p:m[:opt],...  Auto-match live provider:model specs against cached benchmarks.json
                          (fetches full AA snapshot automatically if any model is missing)
  --capabilities <path|-> Parse raw T3 orchestrator_capabilities JSON (file path or '-' for stdin)
  --replace-catalog       Replace saved catalog instead of merging new models into it
  --refresh               Force fetching fresh full AA snapshot into benchmarks.json
  --offline               Never hit the network; recompute from cached benchmarks.json only
  --source=mirror         Force zero-key daily Artificial Analysis mirror
  --source=api            Force official AA API v2 (requires ARTIFICIAL_ANALYSIS_API_KEY)
  --dry-run               Print computed frontier without writing frontier.json
  --check-models a,b,c    Exit 2 if any model ID is uncalibrated in frontier.json (no network)
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown CLI argument: ${arg ?? ""}`);
    }
  }

  return {
    source,
    refresh,
    offline,
    dryRun,
    replaceCatalog,
    modelsArg,
    capabilitiesPath,
    checkModels,
  };
}

function parseModelArgSpecs(entries: readonly string[]): readonly CatalogModelSpec[] {
  const out: CatalogModelSpec[] = [];
  for (const raw of entries) {
    const parts = raw.split(":").map((s) => s.trim());
    const provider = parts[0];
    const model = parts[1];
    const optionKey = parts[2];
    if (!provider || !model) {
      throw new Error(
        `Invalid --models entry "${raw}". Expected "provider:model" or "provider:model:optionKey".`,
      );
    }
    if (isIgnoredModel(model)) continue;
    out.push(buildCatalogSpec(provider, model, optionKey || undefined));
  }
  return out;
}

async function readStdinText(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function parseCapabilitiesFile(pathArg: string): Promise<readonly CatalogModelSpec[]> {
  const rawText =
    pathArg === "-" ? await readStdinText() : await readFile(pathArg, "utf8");
  const parsed: unknown = JSON.parse(rawText);
  if (!isRecord(parsed) || !Array.isArray(parsed["providers"])) {
    throw new Error("Capabilities JSON must contain a 'providers' array.");
  }

  const specs: CatalogModelSpec[] = [];
  for (const prov of parsed["providers"]) {
    if (!isRecord(prov)) continue;
    if (prov["canRunChildTask"] !== true) continue;
    const providerId = prov["providerInstanceId"];
    if (!isNonEmptyString(providerId)) continue;
    const models = prov["models"];
    if (!Array.isArray(models)) continue;

    for (const m of models) {
      if (!isRecord(m)) continue;
      const modelId = m["id"];
      if (!isNonEmptyString(modelId) || isIgnoredModel(modelId)) continue;

      let optionKey: string | undefined;
      let allowedEfforts: EffortLevel[] | undefined;

      const options = m["options"];
      if (Array.isArray(options)) {
        for (const opt of options) {
          if (!isRecord(opt)) continue;
          const id = opt["id"];
          if (
            isNonEmptyString(id) &&
            (EFFORT_OPTION_KEYS as readonly string[]).includes(id)
          ) {
            optionKey = id;
            const values = opt["values"];
            if (Array.isArray(values)) {
              const filtered = values.filter(isEffortLevel);
              if (filtered.length > 0) allowedEfforts = filtered;
            }
            break;
          }
        }
      }

      specs.push(buildCatalogSpec(providerId, modelId, optionKey, allowedEfforts));
    }
  }
  return specs;
}

function matchSpecToAARecords(
  spec: CatalogModelSpec,
  models: readonly AAModelRecord[],
  source: "artificial_analysis_mirror" | "artificial_analysis_api",
): readonly MappedCandidate[] {
  const baseSlug = normalizeModelToAASlug(spec.model);
  const matched: MappedCandidate[] = [];
  const seenEffort = new Set<EffortLevel>();

  for (const record of models) {
    const slug = record.slug.toLowerCase();
    let effort: EffortLevel | null = null;

    if (slug === baseSlug) {
      const parenMatch = /\((low|medium|high|xhigh|max)\b/i.exec(record.name);
      const parsed = parenMatch?.[1]?.toLowerCase();
      if (parsed && isEffortLevel(parsed) && spec.allowed_efforts.includes(parsed)) {
        effort = parsed;
      } else {
        effort =
          spec.allowed_efforts[spec.allowed_efforts.length - 1] ?? "high";
      }
    } else if (slug.startsWith(`${baseSlug}-`)) {
      const suffix = slug.slice(baseSlug.length + 1);
      const normalizedSuffix = suffix === "med" ? "medium" : suffix;
      if (
        isEffortLevel(normalizedSuffix) &&
        spec.allowed_efforts.includes(normalizedSuffix)
      ) {
        effort = normalizedSuffix;
      }
    }

    if (effort === null || seenEffort.has(effort)) continue;
    seenEffort.add(effort);

    matched.push({
      id: `${spec.provider}:${spec.model}:${effort}`,
      provider: spec.provider,
      family: spec.family,
      model: spec.model,
      effort,
      options: { [spec.option_key]: effort },
      record,
      source,
    });
  }

  // Sort deterministically by effort order
  return matched.sort(
    (a, b) => EFFORT_LEVELS.indexOf(a.effort) - EFFORT_LEVELS.indexOf(b.effort),
  );
}

function normalizeAAApiPayload(raw: unknown): AASnapshot {
  if (!isRecord(raw) || !Array.isArray(raw["data"])) {
    throw new Error("Unexpected Artificial Analysis API v2 response shape.");
  }
  const models: AAModelRecord[] = [];
  for (const item of raw["data"]) {
    if (!isRecord(item)) continue;
    const evals = isRecord(item["evaluations"]) ? item["evaluations"] : {};
    const pricing = isRecord(item["pricing"]) ? item["pricing"] : {};
    const perf = isRecord(item["performance_v3"]) ? item["performance_v3"] : {};
    const creatorObj = isRecord(item["model_creator"]) ? item["model_creator"] : {};

    const idx = evals["artificial_analysis_intelligence_index"];
    const inputPrice = pricing["price_1m_input_tokens"];
    const outputPrice = pricing["price_1m_output_tokens"];
    const blendedPrice =
      pricing["price_1m_blended_3_to_1"] ??
      (isFiniteNumber(inputPrice) && isFiniteNumber(outputPrice)
        ? (3 * inputPrice + outputPrice) / 4
        : undefined);
    const taskCost = pricing["cost_per_task_usd"] ?? blendedPrice;
    const tps =
      perf["mean_output_tokens_per_second"] ??
      item["median_output_tokens_per_second"] ??
      0;
    const ttft =
      perf["median_time_to_first_answer_token"] ??
      item["median_time_to_first_token_seconds"] ??
      0;

    if (
      isNonEmptyString(item["id"]) &&
      isNonEmptyString(item["name"]) &&
      isNonEmptyString(item["slug"]) &&
      isFiniteNumber(idx) &&
      isFiniteNumber(inputPrice) &&
      isFiniteNumber(outputPrice) &&
      isFiniteNumber(blendedPrice) &&
      isFiniteNumber(taskCost) &&
      isFiniteNumber(tps) &&
      isFiniteNumber(ttft)
    ) {
      models.push({
        id: item["id"],
        name: item["name"],
        slug: item["slug"],
        creator: isNonEmptyString(creatorObj["name"]) ? creatorObj["name"] : "Unknown",
        index: idx,
        blended: blendedPrice,
        input: inputPrice,
        output: outputPrice,
        task: taskCost,
        tps,
        ttft,
      });
    }
  }
  if (models.length === 0) {
    throw new Error("Artificial Analysis API v2 returned zero usable models.");
  }
  return {
    fetched_at: new Date().toISOString(),
    source: "Artificial Analysis API v2",
    intelligence_index_version: 5,
    attribution: "Data provided by Artificial Analysis (https://artificialanalysis.ai/)",
    models,
  };
}

async function loadCachedBenchmarks(): Promise<CachedBenchmarksFile | null> {
  try {
    const text = await readFile(BENCHMARKS_PATH, "utf8");
    const raw: unknown = JSON.parse(text);
    const parsed = parseAASnapshot(raw);
    const rec = raw as Record<string, unknown>;
    const source =
      rec["source"] === "artificial_analysis_api"
        ? "artificial_analysis_api"
        : "artificial_analysis_mirror";
    const sourceUrl = isNonEmptyString(rec["source_url"])
      ? rec["source_url"]
      : MIRROR_URL;
    return {
      fetched_at: parsed.fetched_at,
      source,
      source_url: sourceUrl,
      intelligence_index_version: parsed.intelligence_index_version,
      attribution: parsed.attribution,
      models: parsed.models,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function fetchFullBenchmarks(
  sourceMode: "auto" | "mirror" | "api",
): Promise<CachedBenchmarksFile> {
  const apiKey = process.env["ARTIFICIAL_ANALYSIS_API_KEY"]?.trim();
  const useApi =
    sourceMode === "api" || (sourceMode === "auto" && Boolean(apiKey));

  if (useApi) {
    if (!apiKey) {
      throw new Error(
        "--source=api requires ARTIFICIAL_ANALYSIS_API_KEY in the environment.",
      );
    }
    const resp = await fetch(AA_API_URL, {
      headers: { "x-api-key": apiKey, accept: "application/json" },
    });
    if (!resp.ok) {
      throw new Error(`AA API request failed with HTTP ${resp.status}.`);
    }
    const raw: unknown = await resp.json();
    const snapshot = normalizeAAApiPayload(raw);
    return {
      fetched_at: snapshot.fetched_at,
      source: "artificial_analysis_api",
      source_url: AA_API_URL,
      intelligence_index_version: snapshot.intelligence_index_version,
      attribution: snapshot.attribution,
      models: snapshot.models,
    };
  }

  const resp = await fetch(MIRROR_URL, {
    headers: { accept: "application/json" },
  });
  if (!resp.ok) {
    throw new Error(`Benchmark mirror request failed with HTTP ${resp.status}.`);
  }
  const raw: unknown = await resp.json();
  const snapshot = parseAASnapshot(raw);
  return {
    fetched_at: snapshot.fetched_at,
    source: "artificial_analysis_mirror",
    source_url: MIRROR_URL,
    intelligence_index_version: snapshot.intelligence_index_version,
    attribution: snapshot.attribution,
    models: snapshot.models,
  };
}

async function loadExistingFrontier(): Promise<FrontierFile | null> {
  try {
    const rawText = await readFile(FRONTIER_PATH, "utf8");
    const parsed: unknown = JSON.parse(rawText);
    if (!isRecord(parsed)) return null;
    return parsed as unknown as FrontierFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function loadOptionalOverridesFile(path: string): Promise<OverridesFile | null> {
  try {
    const rawText = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(rawText);
    if (!isRecord(parsed)) {
      throw new Error(`${path} must be a JSON object.`);
    }
    return parsed as unknown as OverridesFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function mergeEntryOverrideMap(
  base: Readonly<Record<string, EntryOverride>> | undefined,
  local: Readonly<Record<string, EntryOverride>> | undefined,
): Readonly<Record<string, EntryOverride>> | undefined {
  if (!base && !local) return undefined;
  const out: Record<string, EntryOverride> = { ...(base ?? {}) };
  for (const [key, patch] of Object.entries(local ?? {})) {
    const prev = out[key];
    out[key] = prev
      ? {
          ...prev,
          ...patch,
          ...(prev.rung_constraints || patch.rung_constraints
            ? {
                rung_constraints: {
                  ...(prev.rung_constraints ?? {}),
                  ...(patch.rung_constraints ?? {}),
                },
              }
            : {}),
        }
      : patch;
  }
  return out;
}

async function loadOverrides(): Promise<OverridesFile> {
  const [base, local] = await Promise.all([
    loadOptionalOverridesFile(OVERRIDES_PATH),
    loadOptionalOverridesFile(LOCAL_OVERRIDES_PATH),
  ]);
  if (!base && !local) return { schema_version: 1 };
  if (!local) return base ?? { schema_version: 1 };
  if (!base) return local;

  const mergedThresholds: Partial<Record<Rung, Partial<RungThreshold>>> = {};
  for (const rung of RUNGS) {
    const b = base.rung_thresholds?.[rung];
    const l = local.rung_thresholds?.[rung];
    if (b || l) {
      mergedThresholds[rung] = { ...(b ?? {}), ...(l ?? {}) };
    }
  }

  const modelOverrides = mergeEntryOverrideMap(
    base.model_overrides,
    local.model_overrides,
  );
  const entryOverrides = mergeEntryOverrideMap(
    base.entry_overrides,
    local.entry_overrides,
  );
  const maxEntries =
    local.max_entries_per_provider_rung ?? base.max_entries_per_provider_rung;

  return {
    schema_version: 1,
    ...(Object.keys(mergedThresholds).length > 0
      ? { rung_thresholds: mergedThresholds }
      : {}),
    ...(maxEntries !== undefined
      ? { max_entries_per_provider_rung: maxEntries }
      : {}),
    ...(modelOverrides ? { model_overrides: modelOverrides } : {}),
    ...(entryOverrides ? { entry_overrides: entryOverrides } : {}),
  };
}

function mergeCatalogs(
  base: readonly CatalogModelSpec[],
  incoming: readonly CatalogModelSpec[],
  replace: boolean,
): readonly CatalogModelSpec[] {
  const byKey = new Map<string, CatalogModelSpec>();
  if (!replace) {
    for (const item of base) {
      byKey.set(`${item.provider}:${item.model}`, item);
    }
  }
  for (const item of incoming) {
    byKey.set(`${item.provider}:${item.model}`, item);
  }
  return [...byKey.values()].sort((a, b) =>
    `${a.provider}:${a.model}`.localeCompare(`${b.provider}:${b.model}`),
  );
}

function mergeThresholds(
  overrides: OverridesFile,
): Readonly<Record<Rung, RungThreshold>> {
  const out: Record<Rung, RungThreshold> = {
    R0: { ...DEFAULT_RUNG_THRESHOLDS.R0 },
    R1: { ...DEFAULT_RUNG_THRESHOLDS.R1 },
    R2: { ...DEFAULT_RUNG_THRESHOLDS.R2 },
    R3: { ...DEFAULT_RUNG_THRESHOLDS.R3 },
  };
  for (const rung of RUNGS) {
    const patch = overrides.rung_thresholds?.[rung];
    if (!patch) continue;
    out[rung] = {
      min_index: patch.min_index ?? out[rung].min_index,
      max_index_exclusive:
        patch.max_index_exclusive !== undefined
          ? patch.max_index_exclusive
          : out[rung].max_index_exclusive,
      max_ttft_s: patch.max_ttft_s ?? out[rung].max_ttft_s,
    };
  }
  return out;
}

function classifyRung(
  index: number,
  thresholds: Readonly<Record<Rung, RungThreshold>>,
): Rung | null {
  for (const rung of RUNGS) {
    const t = thresholds[rung];
    const aboveMin = index >= t.min_index;
    const belowMax =
      t.max_index_exclusive === null || index < t.max_index_exclusive;
    if (aboveMin && belowMax) return rung;
  }
  return null;
}

function computeParetoIds(candidates: readonly MappedCandidate[]): ReadonlySet<string> {
  const sorted = [...candidates].sort((a, b) => {
    if (a.record.task !== b.record.task) return a.record.task - b.record.task;
    return b.record.index - a.record.index;
  });
  const pareto = new Set<string>();
  let bestIndex = -Infinity;
  for (const item of sorted) {
    if (item.record.index > bestIndex) {
      pareto.add(item.id);
      bestIndex = item.record.index;
    }
  }
  return pareto;
}

function resolveOverride(
  candidate: MappedCandidate,
  overrides: OverridesFile,
): EntryOverride {
  const modelKey = `${candidate.provider}:${candidate.model}`;
  const byModel = overrides.model_overrides?.[modelKey];
  const byEntry = overrides.entry_overrides?.[candidate.id];

  const mergedConstraints: Partial<Record<Rung, RungConstraint>> = {
    ...(byModel?.rung_constraints ?? {}),
    ...(byEntry?.rung_constraints ?? {}),
  };

  const result: {
    exclude?: boolean;
    max_rung?: Rung;
    extra_rungs?: readonly Rung[];
    rung_constraints?: Readonly<Partial<Record<Rung, RungConstraint>>>;
    rank_bias?: number;
    notes?: string;
  } = {};

  const exclude = byEntry?.exclude ?? byModel?.exclude;
  if (exclude !== undefined) result.exclude = exclude;

  const maxRung = byEntry?.max_rung ?? byModel?.max_rung;
  if (maxRung !== undefined) result.max_rung = maxRung;

  const extraRungs = byEntry?.extra_rungs ?? byModel?.extra_rungs;
  if (extraRungs !== undefined) result.extra_rungs = extraRungs;

  if (Object.keys(mergedConstraints).length > 0) {
    result.rung_constraints = mergedConstraints;
  }

  const rankBias = (byModel?.rank_bias ?? 0) + (byEntry?.rank_bias ?? 0);
  if (rankBias !== 0) result.rank_bias = rankBias;

  const notes = byEntry?.notes ?? byModel?.notes;
  if (notes !== undefined) result.notes = notes;

  return result;
}

async function checkMissingModels(liveModels: readonly string[]): Promise<void> {
  const frontier = await loadExistingFrontier();
  if (!frontier) {
    console.log("frontier.json does not exist yet. Run sync-benchmarks.ts first.");
    process.exit(2);
  }
  const known = new Set([
    ...frontier.tracked_models,
    ...(frontier.unmatched_models ?? []),
  ]);
  const missing = liveModels.filter(
    (m) => !isIgnoredModel(m) && !known.has(m),
  );
  if (missing.length === 0) {
    console.log("All live models are already accounted for in frontier.json.");
    process.exit(0);
  }
  console.log(`New/uncalibrated models detected: ${missing.join(", ")}`);
  process.exit(2);
}

function mapCatalog(
  catalog: readonly CatalogModelSpec[],
  benchmarks: CachedBenchmarksFile,
  overrides: OverridesFile,
): {
  readonly candidates: readonly MappedCandidate[];
  readonly unmatched: readonly string[];
} {
  const candidates: MappedCandidate[] = [];
  const unmatched: string[] = [];
  const seenIds = new Set<string>();

  for (const spec of catalog) {
    const modelOverride = overrides.model_overrides?.[`${spec.provider}:${spec.model}`];
    if (modelOverride?.exclude) continue;

    const matches = matchSpecToAARecords(spec, benchmarks.models, benchmarks.source);
    if (matches.length === 0) {
      unmatched.push(spec.model);
      continue;
    }

    for (const candidate of matches) {
      if (seenIds.has(candidate.id)) continue;
      const ov = resolveOverride(candidate, overrides);
      if (ov.exclude) continue;
      seenIds.add(candidate.id);
      candidates.push(candidate);
    }
  }

  return {
    candidates,
    unmatched: [...new Set(unmatched)].sort(),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.checkModels !== null) {
    await checkMissingModels(args.checkModels);
    return;
  }

  const [existingFrontier, overrides] = await Promise.all([
    loadExistingFrontier(),
    loadOverrides(),
  ]);
  const thresholds = mergeThresholds(overrides);
  const maxPerProviderRung = overrides.max_entries_per_provider_rung ?? 2;

  const baseCatalog = existingFrontier?.catalog ?? SEED_CATALOG;
  const incomingSpecs: CatalogModelSpec[] = [];
  if (args.capabilitiesPath !== null) {
    incomingSpecs.push(...(await parseCapabilitiesFile(args.capabilitiesPath)));
  }
  if (args.modelsArg !== null) {
    incomingSpecs.push(...parseModelArgSpecs(args.modelsArg));
  }

  const hasIncoming = args.capabilitiesPath !== null || args.modelsArg !== null;
  const catalog = mergeCatalogs(baseCatalog, incomingSpecs, args.replaceCatalog);

  // Offline-first when matching incoming models against cached benchmarks.json;
  // automatically fetches full AA snapshot if cache is missing, a model isn't in cache,
  // or user ran a manual sync / --refresh.
  let benchmarks = await loadCachedBenchmarks();
  let fetchedFresh = false;

  const needsInitialFetch = benchmarks === null;
  const manualRefresh = !hasIncoming && !args.offline;
  let shouldFetch = args.refresh || needsInitialFetch || manualRefresh;

  if (!shouldFetch && benchmarks !== null && hasIncoming && !args.offline) {
    const probe = mapCatalog(catalog, benchmarks, overrides);
    if (probe.unmatched.length > 0) {
      shouldFetch = true;
    }
  }

  if (shouldFetch) {
    if (args.offline) {
      throw new Error(
        "No cached benchmarks.json found and --offline was specified.",
      );
    }
    benchmarks = await fetchFullBenchmarks(args.source);
    fetchedFresh = true;
    if (!args.dryRun) {
      await writeFile(
        BENCHMARKS_PATH,
        `${JSON.stringify(benchmarks, null, 2)}\n`,
        "utf8",
      );
    }
  }

  if (!benchmarks) {
    throw new Error("Unable to load Artificial Analysis benchmarks.");
  }

  const { candidates: mapped, unmatched } = mapCatalog(
    catalog,
    benchmarks,
    overrides,
  );

  // Apply rung TTFT guardrails before Pareto computation so 350s–740s thinking-loop
  // outliers cannot dominate practical points.
  const ttftEligible = mapped.filter((c) => {
    const rung = classifyRung(c.record.index, thresholds);
    if (rung === null) return false;
    return c.record.ttft <= thresholds[rung].max_ttft_s;
  });

  // Compute global and per-provider Pareto frontiers on (task cost, intelligence index)
  const globalParetoIds = computeParetoIds(ttftEligible);
  const providerParetoIds = new Set<string>();

  const byProvider = new Map<string, MappedCandidate[]>();
  for (const c of ttftEligible) {
    const list = byProvider.get(c.provider) ?? [];
    list.push(c);
    byProvider.set(c.provider, list);
  }
  for (const list of byProvider.values()) {
    for (const id of computeParetoIds(list)) {
      providerParetoIds.add(id);
    }
  }

  // Keep provider-Pareto entries, capped to top N per (provider, primary_rung)
  const frontierCandidates = ttftEligible.filter((c) => providerParetoIds.has(c.id));
  const byProviderRung = new Map<string, MappedCandidate[]>();
  for (const c of frontierCandidates) {
    const rung = classifyRung(c.record.index, thresholds);
    if (rung === null) continue;
    const key = `${c.provider}:${rung}`;
    const bucket = byProviderRung.get(key) ?? [];
    bucket.push(c);
    byProviderRung.set(key, bucket);
  }

  const kept: MappedCandidate[] = [];
  for (const bucket of byProviderRung.values()) {
    const sortedByIndex = [...bucket].sort(
      (a, b) => b.record.index - a.record.index || a.record.task - b.record.task,
    );
    if (sortedByIndex.length <= maxPerProviderRung) {
      kept.push(...sortedByIndex);
    } else {
      const top = sortedByIndex[0];
      const cheapest = [...bucket].sort(
        (a, b) => a.record.task - b.record.task || b.record.index - a.record.index,
      )[0];
      const selected: MappedCandidate[] = [];
      if (top) selected.push(top);
      if (cheapest && cheapest.id !== top?.id) selected.push(cheapest);
      for (const item of sortedByIndex) {
        if (selected.length >= maxPerProviderRung) break;
        if (!selected.some((s) => s.id === item.id)) selected.push(item);
      }
      kept.push(...selected);
    }
  }

  interface DraftEntry {
    readonly candidate: MappedCandidate;
    readonly primaryRung: Rung;
    readonly rungs: readonly Rung[];
    readonly maxRung: Rung;
    readonly constraints: Readonly<Partial<Record<Rung, RungConstraint>>> | undefined;
    readonly rankBias: number;
    readonly notes: string | undefined;
  }

  const drafts: DraftEntry[] = [];
  for (const candidate of kept) {
    const naturalRung = classifyRung(candidate.record.index, thresholds);
    if (naturalRung === null) continue;
    const ov = resolveOverride(candidate, overrides);

    const maxRung: Rung = ov.max_rung ?? naturalRung;
    const effectivePrimary: Rung =
      RUNG_ORDER[naturalRung] <= RUNG_ORDER[maxRung] ? naturalRung : maxRung;

    const rungSet = new Set<Rung>([effectivePrimary]);
    for (const extra of ov.extra_rungs ?? []) {
      if (RUNG_ORDER[extra] <= RUNG_ORDER[maxRung]) {
        rungSet.add(extra);
      }
    }

    const sortedRungs = [...rungSet].sort((a, b) => RUNG_ORDER[a] - RUNG_ORDER[b]);
    drafts.push({
      candidate,
      primaryRung: effectivePrimary,
      rungs: sortedRungs,
      maxRung,
      constraints: ov.rung_constraints,
      rankBias: ov.rank_bias ?? 0,
      notes: ov.notes,
    });
  }

  const rungRanksById = new Map<string, Partial<Record<Rung, number>>>();
  for (const d of drafts) {
    rungRanksById.set(d.candidate.id, {});
  }

  for (const rung of RUNGS) {
    const inRung = drafts
      .filter((d) => d.rungs.includes(rung))
      .sort((a, b) => {
        const aConstrained = a.constraints?.[rung] ? 1 : 0;
        const bConstrained = b.constraints?.[rung] ? 1 : 0;
        if (aConstrained !== bConstrained) return aConstrained - bConstrained;

        const aGlobal = globalParetoIds.has(a.candidate.id) ? 1 : 0;
        const bGlobal = globalParetoIds.has(b.candidate.id) ? 1 : 0;
        const costPenaltyWeight =
          rung === "R0" ? 6 : rung === "R1" ? 4 : rung === "R2" ? 1.5 : 0;

        const aScore =
          a.candidate.record.index +
          aGlobal * 4 -
          costPenaltyWeight * Math.log10(Math.max(a.candidate.record.task, 0.05)) +
          a.rankBias;
        const bScore =
          b.candidate.record.index +
          bGlobal * 4 -
          costPenaltyWeight * Math.log10(Math.max(b.candidate.record.task, 0.05)) +
          b.rankBias;

        if (bScore !== aScore) return bScore - aScore;
        return a.candidate.record.task - b.candidate.record.task;
      });

    inRung.forEach((d, idx) => {
      const map = rungRanksById.get(d.candidate.id);
      if (map) map[rung] = idx + 1;
    });
  }

  const entries: FrontierEntry[] = drafts
    .sort((a, b) => {
      if (RUNG_ORDER[a.primaryRung] !== RUNG_ORDER[b.primaryRung]) {
        return RUNG_ORDER[a.primaryRung] - RUNG_ORDER[b.primaryRung];
      }
      const aRank = rungRanksById.get(a.candidate.id)?.[a.primaryRung] ?? 99;
      const bRank = rungRanksById.get(b.candidate.id)?.[b.primaryRung] ?? 99;
      return aRank - bRank;
    })
    .map((d) => {
      const entry: FrontierEntry = {
        id: d.candidate.id,
        provider: d.candidate.provider,
        family: d.candidate.family,
        model: d.candidate.model,
        options: d.candidate.options,
        primary_rung: d.primaryRung,
        rungs: d.rungs,
        max_rung: d.maxRung,
        ...(d.constraints ? { rung_constraints: d.constraints } : {}),
        global_pareto: globalParetoIds.has(d.candidate.id),
        provider_pareto: true,
        rung_ranks: rungRanksById.get(d.candidate.id) ?? {},
        benchmarks: {
          source: d.candidate.source,
          aa_slug: d.candidate.record.slug,
          aa_name: d.candidate.record.name,
          intelligence_index: d.candidate.record.index,
          task_cost_usd: Number(d.candidate.record.task.toFixed(4)),
          blended_price_per_1m: d.candidate.record.blended,
          output_tps: d.candidate.record.tps,
          ttft_s: d.candidate.record.ttft,
        },
        ...(d.notes ? { notes: d.notes } : {}),
      };
      return entry;
    });

  const matchedModels = new Set(mapped.map((m) => m.model));
  const trackedModels = [...matchedModels].sort();

  const output: FrontierFile = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    benchmark_fetched_at: benchmarks.fetched_at,
    intelligence_index_version: benchmarks.intelligence_index_version,
    source_url: benchmarks.source_url,
    attribution: benchmarks.attribution,
    rung_thresholds: thresholds,
    catalog,
    entries,
    tracked_models: trackedModels,
    unmatched_models: unmatched,
  };

  if (args.dryRun) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  await writeFile(FRONTIER_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  const cacheNote = fetchedFresh
    ? `fetched ${benchmarks.models.length} AA models into benchmarks.json`
    : `matched offline against cached benchmarks.json (${benchmarks.models.length} AA models)`;
  console.log(
    `Wrote ${entries.length} frontier entries to frontier.json (AA v${benchmarks.intelligence_index_version}, ${cacheNote}).`,
  );
  if (unmatched.length > 0) {
    console.log(`Unmatched models (not yet in AA snapshot): ${unmatched.join(", ")}`);
  }

  for (const rung of RUNGS) {
    const rows = entries
      .filter((e) => e.rungs.includes(rung))
      .sort((a, b) => (a.rung_ranks[rung] ?? 99) - (b.rung_ranks[rung] ?? 99));
    console.log(`\n[${rung}]`);
    for (const r of rows) {
      const rank = r.rung_ranks[rung] ?? 99;
      const tag = r.global_pareto ? "global-pareto" : "provider-pareto";
      const constrained = r.rung_constraints?.[rung] ? " [constrained]" : "";
      console.log(
        `  #${rank} ${r.id.padEnd(36)} idx=${String(r.benchmarks.intelligence_index).padStart(4)}  task=$${r.benchmarks.task_cost_usd.toFixed(2).padStart(5)}  ttft=${String(r.benchmarks.ttft_s).padStart(5)}s  (${tag})${constrained}`,
      );
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
