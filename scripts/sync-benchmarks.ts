/**
 * Sync Artificial Analysis data into benchmarks.json and derive frontier.json.
 *
 * frontier.json is pure data: every matched (provider, model, effort) with AA prices, latency,
 * AA-suite output tokens and all metrics quantile-mapped onto the intelligence-index scale.
 * Overrides, quota and role tunables are applied at route time (scripts/route.ts), so editing
 * them never requires a resync.
 *
 * Sources (auto): AA API v2 free tier when ARTIFICIAL_ANALYSIS_API_KEY is set (adds coding and
 * agentic indices and cache-hit prices), else the zero-key daily mirror (intelligence index only).
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PATHS, loadOverrides, loadQuota, loadRoles } from "./config.ts";
import { aaOutputTokens, buildQuantileMapper, collectMetricNames, median } from "./model.ts";
import { renderTable } from "./route.ts";
import {
  BASE_METRIC,
  EFFORT_LEVELS,
  isEffortLevel,
  isFiniteNumber,
  isNonEmptyString,
  isRecord,
  parseAAModelRecord,
  type AAModelRecord,
  type AATokenCounts,
  type BenchmarkSource,
  type CachedBenchmarksFile,
  type CatalogModelSpec,
  type EffortLevel,
  type FrontierEntry,
  type FrontierFile,
  type ProviderFamily,
  type ProviderOptions,
} from "./types.ts";

const MIRROR_URL =
  "https://raw.githubusercontent.com/terryds/bestvaluemodel/main/data/models.json";
const AA_API_BASE = "https://artificialanalysis.ai/api/v2/language/models";
const ATTRIBUTION = "Data from Artificial Analysis (https://artificialanalysis.ai/). Attribution required.";

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
  readonly source: BenchmarkSource;
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
  --source=api            Force AA API v2 free tier (requires ARTIFICIAL_ANALYSIS_API_KEY)
  --dry-run               Print computed frontier without writing files
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
  source: BenchmarkSource,
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
      if (parsed && isEffortLevel(parsed)) {
        // An effort the provider does not expose (e.g. Max) is not that provider's top effort.
        effort = spec.allowed_efforts.includes(parsed) ? parsed : null;
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


// ---------------------------------------------------------------------------
// AA API v2 normalization
// ---------------------------------------------------------------------------

function num(obj: unknown, ...path: string[]): number | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return isFiniteNumber(cur) ? cur : undefined;
}

export function normalizeAAApiModel(item: unknown): AAModelRecord | null {
  if (!isRecord(item)) return null;
  const evalsRaw = isRecord(item["evaluations"]) ? item["evaluations"] : {};
  const evals: Record<string, number> = {};
  for (const [k, v] of Object.entries(evalsRaw)) {
    if (isFiniteNumber(v)) evals[k] = v;
  }
  const index = evals[BASE_METRIC];
  const input = num(item, "pricing", "price_1m_input_tokens");
  const output = num(item, "pricing", "price_1m_output_tokens");
  const cacheHit = num(item, "pricing", "price_1m_cache_hit_tokens");
  const cost = item["artificial_analysis_intelligence_index_cost"];
  const task =
    num(cost, "cost_per_task", "total_cost") ??
    num(cost, "cost_per_task") ??
    num(cost, "total_cost");
  const tps =
    num(item, "performance", "median_output_tokens_per_second") ??
    num(item, "performance_v3", "mean_output_tokens_per_second");
  const ttft =
    num(item, "performance", "median_time_to_first_answer_token_seconds") ??
    num(item, "performance_v3", "mean_time_to_first_answer_token_seconds") ??
    num(item, "performance", "median_time_to_first_token_seconds");
  const counts = item["artificial_analysis_intelligence_index_token_counts"];
  const tokens: Record<string, number> = {};
  for (const k of ["input_tokens", "output_tokens", "reasoning_tokens", "answer_tokens"] as const) {
    const v = num(counts, k);
    if (v !== undefined) tokens[k] = v;
  }
  const creator = isRecord(item["model_creator"]) ? item["model_creator"]["name"] : undefined;

  if (
    !isNonEmptyString(item["id"]) ||
    !isNonEmptyString(item["name"]) ||
    !isNonEmptyString(item["slug"]) ||
    index === undefined ||
    input === undefined ||
    output === undefined ||
    task === undefined ||
    tps === undefined ||
    ttft === undefined
  ) {
    return null;
  }
  return {
    id: item["id"],
    name: item["name"],
    slug: item["slug"],
    creator: isNonEmptyString(creator) ? creator : "Unknown",
    index,
    input,
    output,
    ...(cacheHit !== undefined ? { cache_hit: cacheHit } : {}),
    task,
    tps,
    ttft,
    evals,
    ...(Object.keys(tokens).length > 0 ? { tokens: tokens as AATokenCounts } : {}),
    url: `https://artificialanalysis.ai/models/${item["slug"]}`,
  };
}

async function fetchApiPages(
  url: string,
  apiKey: string,
): Promise<{ ok: true; items: unknown[]; version: number } | { ok: false; status: number }> {
  const items: unknown[] = [];
  let version = 5;
  for (let page = 1; page <= 50; page += 1) {
    const resp = await fetch(`${url}?page=${page}`, {
      headers: { "x-api-key": apiKey, accept: "application/json" },
    });
    if (!resp.ok) return { ok: false, status: resp.status };
    const raw: unknown = await resp.json();
    if (!isRecord(raw) || !Array.isArray(raw["data"])) {
      throw new Error(`Unexpected AA API response shape from ${url}`);
    }
    items.push(...raw["data"]);
    const v = raw["intelligence_index_version"];
    if (isFiniteNumber(v)) version = v;
    const hasMore = isRecord(raw["pagination"]) && raw["pagination"]["has_more"] === true;
    if (!hasMore) break;
  }
  return { ok: true, items, version };
}

async function fetchFromApi(apiKey: string): Promise<CachedBenchmarksFile> {
  const tier = "free" as const;
  const url = `${AA_API_BASE}/free`;
  const res = await fetchApiPages(url, apiKey);
  if (!res.ok) throw new Error(`AA API request failed with HTTP ${res.status} (${url}).`);
  const models = res.items.map(normalizeAAApiModel).filter((m): m is AAModelRecord => m !== null);
  if (models.length === 0) throw new Error("AA API returned zero usable models.");
  return {
    fetched_at: new Date().toISOString(),
    source: "artificial_analysis_api",
    source_url: url,
    api_tier: tier,
    intelligence_index_version: res.version,
    attribution: ATTRIBUTION,
    models,
  };
}

async function fetchFromMirror(): Promise<CachedBenchmarksFile> {
  const resp = await fetch(MIRROR_URL, { headers: { accept: "application/json" } });
  if (!resp.ok) throw new Error(`Benchmark mirror request failed with HTTP ${resp.status}.`);
  const raw: unknown = await resp.json();
  return parseBenchmarks(raw, "artificial_analysis_mirror", MIRROR_URL);
}

function parseBenchmarks(
  raw: unknown,
  fallbackSource: BenchmarkSource,
  fallbackUrl: string,
): CachedBenchmarksFile {
  if (!isRecord(raw) || !Array.isArray(raw["models"])) {
    throw new Error("Benchmark snapshot is missing a 'models' array.");
  }
  const models = raw["models"].map(parseAAModelRecord).filter((m): m is AAModelRecord => m !== null);
  if (models.length === 0) throw new Error("Benchmark snapshot contained zero valid models.");
  const source: BenchmarkSource =
    raw["source"] === "artificial_analysis_api" ? "artificial_analysis_api" : fallbackSource;
  const tier = raw["api_tier"];
  return {
    fetched_at: isNonEmptyString(raw["fetched_at"]) ? raw["fetched_at"] : new Date().toISOString(),
    source,
    source_url: isNonEmptyString(raw["source_url"]) ? raw["source_url"] : fallbackUrl,
    ...(tier === "pro" || tier === "free" ? { api_tier: tier } : {}),
    intelligence_index_version: isFiniteNumber(raw["intelligence_index_version"])
      ? raw["intelligence_index_version"]
      : 5,
    attribution: isNonEmptyString(raw["attribution"]) ? raw["attribution"] : ATTRIBUTION,
    models,
  };
}

async function fetchFullBenchmarks(mode: "auto" | "mirror" | "api"): Promise<CachedBenchmarksFile> {
  const apiKey = (process.env["ARTIFICIAL_ANALYSIS_API_KEY"] ?? process.env["AA_API_KEY"])?.trim();
  if (mode === "api" && !apiKey) {
    throw new Error("--source=api requires ARTIFICIAL_ANALYSIS_API_KEY in the environment.");
  }
  if (mode !== "mirror" && apiKey) return fetchFromApi(apiKey);
  return fetchFromMirror();
}

async function loadCachedBenchmarks(): Promise<CachedBenchmarksFile | null> {
  try {
    return parseBenchmarks(JSON.parse(await readFile(PATHS.benchmarks, "utf8")), "artificial_analysis_mirror", MIRROR_URL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Reads catalog/tracked lists from either a v1 or v2 frontier. */
async function loadExistingFrontierLists(): Promise<{
  catalog: readonly CatalogModelSpec[];
  tracked: readonly string[];
  unmatched: readonly string[];
} | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(PATHS.frontier, "utf8"));
    if (!isRecord(raw)) return null;
    const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isNonEmptyString) : []);
    return {
      catalog: Array.isArray(raw["catalog"]) ? (raw["catalog"] as CatalogModelSpec[]) : [],
      tracked: strs(raw["tracked_models"]),
      unmatched: strs(raw["unmatched_models"]),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Frontier construction
// ---------------------------------------------------------------------------

function mergeCatalogs(
  base: readonly CatalogModelSpec[],
  incoming: readonly CatalogModelSpec[],
  replace: boolean,
): readonly CatalogModelSpec[] {
  const byKey = new Map<string, CatalogModelSpec>();
  if (!replace) for (const item of base) byKey.set(`${item.provider}:${item.model}`, item);
  for (const item of incoming) byKey.set(`${item.provider}:${item.model}`, item);
  return [...byKey.values()].sort((a, b) =>
    `${a.provider}:${a.model}`.localeCompare(`${b.provider}:${b.model}`),
  );
}

function mapCatalog(
  catalog: readonly CatalogModelSpec[],
  benchmarks: CachedBenchmarksFile,
): { candidates: readonly MappedCandidate[]; unmatched: readonly string[] } {
  const candidates: MappedCandidate[] = [];
  const unmatched = new Set<string>();
  const seen = new Set<string>();
  for (const spec of catalog) {
    const matches = matchSpecToAARecords(spec, benchmarks.models, benchmarks.source);
    if (matches.length === 0) {
      unmatched.add(spec.model);
      continue;
    }
    for (const c of matches) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      candidates.push(c);
    }
  }
  return { candidates, unmatched: [...unmatched].sort() };
}

export function buildFrontier(
  catalog: readonly CatalogModelSpec[],
  benchmarks: CachedBenchmarksFile,
  minCoverage: number,
): FrontierFile {
  const { candidates, unmatched } = mapCatalog(catalog, benchmarks);

  const coverage: Record<string, number> = {};
  const mappers = new Map<string, (x: number) => number>();
  for (const metric of collectMetricNames(benchmarks.models)) {
    const m = buildQuantileMapper(benchmarks.models, metric);
    if (!m) continue;
    coverage[metric] = m.n;
    if (m.n >= minCoverage || metric === BASE_METRIC) mappers.set(metric, m.map);
  }

  const verbosityRef = median(benchmarks.models.map((m) => aaOutputTokens(m).tokens));
  const r2 = (n: number): number => Math.round(n * 100) / 100;

  const entries: FrontierEntry[] = candidates.map((c) => {
    const metrics: Record<string, number> = {};
    for (const [metric, map] of mappers) {
      const raw = metric === BASE_METRIC ? c.record.index : c.record.evals?.[metric];
      if (raw === undefined) continue;
      metrics[metric] = r2(map(raw));
    }
    const out = aaOutputTokens(c.record);
    return {
      id: c.id,
      provider: c.provider,
      family: c.family,
      model: c.model,
      effort: c.effort,
      options: c.options,
      aa: {
        slug: c.record.slug,
        name: c.record.name,
        index: c.record.index,
        input: c.record.input,
        output: c.record.output,
        cache_hit: c.record.cache_hit ?? null,
        task: c.record.task,
        tps: c.record.tps,
        ttft: c.record.ttft,
        output_tokens: Math.round(out.tokens),
        output_tokens_measured: out.measured,
      },
      metrics,
    };
  });

  entries.sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model) ||
      EFFORT_LEVELS.indexOf(a.effort) - EFFORT_LEVELS.indexOf(b.effort),
  );

  return {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    benchmark_fetched_at: benchmarks.fetched_at,
    source: benchmarks.source,
    source_url: benchmarks.source_url,
    ...(benchmarks.api_tier ? { api_tier: benchmarks.api_tier } : {}),
    intelligence_index_version: benchmarks.intelligence_index_version,
    attribution: benchmarks.attribution,
    verbosity_reference_tokens: Math.round(verbosityRef),
    metric_coverage: coverage,
    catalog,
    entries,
    tracked_models: [...new Set(candidates.map((c) => c.model))].sort(),
    unmatched_models: unmatched,
  };
}

async function checkMissingModels(liveModels: readonly string[]): Promise<number> {
  const lists = await loadExistingFrontierLists();
  if (!lists) {
    console.log("frontier.json does not exist yet. Run sync-benchmarks.ts first.");
    return 2;
  }
  const known = new Set([...lists.tracked, ...lists.unmatched]);
  const missing = liveModels.filter((m) => !isIgnoredModel(m) && !known.has(m));
  if (missing.length === 0) {
    console.log("All live models are already accounted for in frontier.json.");
    return 0;
  }
  console.log(`New/uncalibrated models detected: ${missing.join(", ")}`);
  return 2;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.checkModels !== null) return checkMissingModels(args.checkModels);

  const roles = loadRoles();
  const existing = await loadExistingFrontierLists();
  const incoming: CatalogModelSpec[] = [];
  if (args.capabilitiesPath !== null) incoming.push(...(await parseCapabilitiesFile(args.capabilitiesPath)));
  if (args.modelsArg !== null) incoming.push(...parseModelArgSpecs(args.modelsArg));
  const hasIncoming = incoming.length > 0;
  const baseCatalog = existing && existing.catalog.length > 0 ? existing.catalog : SEED_CATALOG;
  const catalog = mergeCatalogs(baseCatalog, incoming, args.replaceCatalog);

  let benchmarks = await loadCachedBenchmarks();
  let shouldFetch = args.refresh || benchmarks === null || (!hasIncoming && !args.offline);
  if (!shouldFetch && benchmarks && hasIncoming && !args.offline) {
    shouldFetch = mapCatalog(catalog, benchmarks).unmatched.length > 0;
  }
  let fetched = false;
  if (shouldFetch) {
    if (args.offline) throw new Error("No cached benchmarks.json found and --offline was specified.");
    benchmarks = await fetchFullBenchmarks(args.source);
    fetched = true;
  }
  if (!benchmarks) throw new Error("Unable to load Artificial Analysis benchmarks.");

  const frontier = buildFrontier(catalog, benchmarks, roles.defaults.min_metric_coverage);
  if (args.dryRun) {
    console.log(JSON.stringify(frontier, null, 2));
    return 0;
  }
  if (fetched) await writeFile(PATHS.benchmarks, `${JSON.stringify(benchmarks, null, 2)}\n`, "utf8");
  await writeFile(PATHS.frontier, `${JSON.stringify(frontier, null, 2)}\n`, "utf8");

  const table = renderTable({ frontier, roles, overrides: loadOverrides(), quota: loadQuota() });
  await writeFile(PATHS.routesTable, table, "utf8");

  const usable = Object.entries(frontier.metric_coverage)
    .filter(([m, n]) => n >= roles.defaults.min_metric_coverage || m === BASE_METRIC)
    .map(([m]) => m);
  console.log(
    `Wrote ${frontier.entries.length} entries to frontier.json and routes.md (${benchmarks.source}${benchmarks.api_tier ? `/${benchmarks.api_tier}` : ""}, ${fetched ? "fetched" : "cached"} ${benchmarks.models.length} AA models, ${usable.length} usable metrics).`,
  );
  if (frontier.unmatched_models.length > 0) {
    console.log(`Unmatched models (not in AA snapshot): ${frontier.unmatched_models.join(", ")}`);
  }
  console.log(table);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
