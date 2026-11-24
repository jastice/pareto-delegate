/**
 * Runtime router. One call returns the expected-cost-optimal (provider, model, options) for a
 * delegated subtask, plus fallbacks, harness hints and a telemetry template.
 *
 *   bun run <skill-dir>/scripts/route.ts --category bugfix --floor R1 --verify strict --blast isolated_module
 *
 * Library use: selectRoute(...). Table: --table [--write] regenerates routes.md.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PATHS, loadFrontier, loadOverrides, loadQuota, loadRoles } from "./config.ts";
import {
  adjustFloor,
  estimateAttempt,
  floorValue,
  maxTtft,
  passProbability,
  resolveOverride,
  roleQuality,
  satisfiesConstraint,
} from "./model.ts";
import {
  FLOORS,
  FLOOR_ORDER,
  isBlastRadius,
  isFloor,
  isTaskCategory,
  isVerifiability,
  type BlastRadius,
  type Floor,
  type FrontierEntry,
  type FrontierFile,
  type OverridesFile,
  type ProviderFamily,
  type QuotaEntry,
  type QuotaFile,
  type QuotaState,
  type RolesFile,
  type TaskCategory,
  type Verifiability,
} from "./types.ts";

export interface RouteRequest {
  readonly category: TaskCategory;
  /** Overrides the category -> role mapping. */
  readonly role?: string;
  readonly floor: Floor;
  readonly verifiability: Verifiability;
  readonly blast_radius: BlastRadius;
  readonly author_family?: ProviderFamily;
  /** provider -> live model ids (T3 orchestrator_capabilities). Omit = all catalog models. */
  readonly live?: Readonly<Record<string, readonly string[]>>;
  /** Restrict to these providers (standalone single-provider mode). */
  readonly providers?: readonly string[];
  /** "provider" or "provider:model" marked throttled/unavailable this session. */
  readonly throttled?: readonly string[];
  /** Entry ids to skip (e.g. the attempt that just failed). */
  readonly exclude?: readonly string[];
  /** Nobody is waiting on the result (async sidecar): latency is mostly free. */
  readonly background?: boolean;
  /** Apply verifiability/blast-radius floor shifts (default true). */
  readonly adjust_floor?: boolean;
  readonly now?: Date;
}

export interface Candidate {
  readonly entry: FrontierEntry;
  readonly quality: number;
  readonly quality_bias: number;
  readonly p_pass: number;
  readonly token_cost_usd: number;
  readonly effective_cost_usd: number;
  readonly time_s: number;
  readonly expected_cost: number;
  readonly quota_state: QuotaState;
  readonly reserved: boolean;
}

export interface RouteResult {
  readonly role: string;
  readonly requested_floor: Floor;
  readonly floor: Floor;
  readonly floor_quality: number;
  readonly winner: Candidate | null;
  readonly fallbacks: readonly Candidate[];
  readonly ranked: readonly Candidate[];
  readonly rejected: Readonly<Record<string, number>>;
  readonly best_below_floor: Candidate | null;
}

export interface RouteContext {
  readonly frontier: FrontierFile;
  readonly roles: RolesFile;
  readonly overrides: OverridesFile;
  readonly quota: QuotaFile;
}

function quotaFor(
  entry: FrontierEntry,
  quota: QuotaFile,
  throttled: readonly string[],
  now: Date,
): { state: QuotaState; reserve: Floor } {
  if (throttled.includes(entry.provider) || throttled.includes(`${entry.provider}:${entry.model}`)) {
    return { state: "throttled", reserve: "R2" };
  }
  const p = quota.providers[entry.provider];
  if (!p) return { state: "normal", reserve: "R2" };
  const eff: QuotaEntry = p.model_overrides?.[entry.model] ?? p;
  let state = eff.state;
  if (state === "throttled" && eff.resets_at) {
    const t = new Date(eff.resets_at).getTime();
    if (!Number.isNaN(t) && t <= now.getTime()) state = "normal";
  }
  return { state, reserve: eff.reserve_for_min_rung ?? "R2" };
}

function isLive(entry: FrontierEntry, req: RouteRequest): boolean {
  if (req.providers && !req.providers.includes(entry.provider)) return false;
  if (!req.live) return true;
  return req.live[entry.provider]?.includes(entry.model) ?? false;
}

export function resolveRole(roles: RolesFile, req: Pick<RouteRequest, "category" | "role">): string {
  const role = req.role ?? roles.category_roles[req.category];
  if (!role || !roles.roles[role]) {
    throw new Error(`No role configured for category '${req.category}' (role '${role ?? ""}').`);
  }
  return role;
}

export function selectRoute(ctx: RouteContext, req: RouteRequest): RouteResult {
  const { frontier, roles, overrides, quota } = ctx;
  const now = req.now ?? new Date();
  const roleName = resolveRole(roles, req);
  const role = roles.roles[roleName];
  if (!role) throw new Error(`Unknown role ${roleName}`);

  const floor =
    req.adjust_floor === false
      ? req.floor
      : adjustFloor(req.floor, req.verifiability, req.blast_radius, roles);
  const floorQ = floorValue(roles, role, floor);
  const pAt = role.p_pass_at_floor ?? roles.defaults.p_pass_at_floor;
  const scale = role.logistic_scale ?? roles.defaults.logistic_scale;
  const ttftCap = maxTtft(roles, role, floor);
  const throttled = req.throttled ?? [];
  const excluded = new Set(req.exclude ?? []);
  const latencyFactor = req.background ? roles.defaults.background_latency_factor : 1;

  const rejected: Record<string, number> = {};
  const reject = (why: string): void => {
    rejected[why] = (rejected[why] ?? 0) + 1;
  };

  const eligible: Candidate[] = [];
  let bestBelow: Candidate | null = null;

  for (const entry of frontier.entries) {
    if (!isLive(entry, req)) continue;
    if (excluded.has(entry.id)) {
      reject("excluded_by_request");
      continue;
    }
    const ov = resolveOverride(entry, overrides);
    if (ov.exclude) {
      reject("excluded_by_override");
      continue;
    }
    if (ov.allowed_roles && !ov.allowed_roles.includes(roleName)) {
      reject("role_not_allowed");
      continue;
    }
    if (ov.max_floor && FLOOR_ORDER[floor] > FLOOR_ORDER[ov.max_floor]) {
      reject("above_max_floor");
      continue;
    }
    if (!satisfiesConstraint(ov.floor_constraints[floor], req)) {
      reject("floor_constraint");
      continue;
    }
    if (entry.aa.ttft > ttftCap) {
      reject("ttft_cap");
      continue;
    }
    const q = quotaFor(entry, quota, throttled, now);
    if (q.state === "throttled") {
      reject("throttled");
      continue;
    }

    const bias = ov.quality_bias(roleName);
    const quality = roleQuality(entry, role).quality + bias;
    const est = estimateAttempt(entry, role, roles, frontier);
    const pPass = passProbability(quality, floorQ, pAt, scale);
    const mult = roles.quota_cost_multipliers[q.state] * ov.cost_multiplier;
    const effectiveCost = est.token_cost_usd * mult;
    const expected =
      effectiveCost +
      (role.value_per_minute_usd * latencyFactor * est.time_s) / 60 +
      (1 - pPass) *
        role.failure_cost_usd[floor] *
        (roles.defaults.failure_cost_by_verifiability[req.verifiability] ?? 1);

    const cand: Candidate = {
      entry,
      quality,
      quality_bias: bias,
      p_pass: pPass,
      token_cost_usd: est.token_cost_usd,
      effective_cost_usd: effectiveCost,
      time_s: est.time_s,
      expected_cost: expected,
      quota_state: q.state,
      reserved: q.state === "scarce" && FLOOR_ORDER[floor] < FLOOR_ORDER[q.reserve],
    };

    if (quality < floorQ) {
      reject("below_floor");
      if (!bestBelow || quality > bestBelow.quality) bestBelow = cand;
      continue;
    }
    eligible.push(cand);
  }

  let pool = eligible;
  if (role.cross_family && req.author_family) {
    const other = pool.filter((c) => c.entry.family !== req.author_family);
    if (other.length > 0) pool = other;
  }
  const unreserved = pool.filter((c) => !c.reserved);
  if (unreserved.length > 0) pool = unreserved;

  const ranked = [...pool].sort(
    (a, b) => a.expected_cost - b.expected_cost || a.effective_cost_usd - b.effective_cost_usd,
  );
  const winner = ranked[0] ?? null;
  const fallbacks: Candidate[] = [];
  const seenModels = new Set<string>(winner ? [`${winner.entry.provider}:${winner.entry.model}`] : []);
  for (const c of ranked.slice(1)) {
    const key = `${c.entry.provider}:${c.entry.model}`;
    if (seenModels.has(key)) continue;
    seenModels.add(key);
    fallbacks.push(c);
    if (fallbacks.length >= 3) break;
  }

  return {
    role: roleName,
    requested_floor: req.floor,
    floor,
    floor_quality: floorQ,
    winner,
    fallbacks,
    ranked,
    rejected,
    best_below_floor: bestBelow,
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const CLAUDE_ALIASES = ["haiku", "sonnet", "opus", "fable", "mythos"] as const;

export function harnessHint(entry: FrontierEntry): Record<string, unknown> | undefined {
  if (entry.provider === "claudeAgent") {
    const alias = CLAUDE_ALIASES.find((a) => entry.model.includes(a));
    return { claude_code_agent: { model: alias ?? entry.model, effort: entry.effort } };
  }
  if (entry.provider === "codex") {
    return { codex_spawn_agent: { model: entry.model, reasoning_effort: entry.effort } };
  }
  return undefined;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

function candidateSummary(c: Candidate): Record<string, unknown> {
  return {
    id: c.entry.id,
    expected_cost: r3(c.expected_cost),
    p_pass: r2(c.p_pass),
    cost_usd: r3(c.token_cost_usd),
    time_s: Math.round(c.time_s),
    quality: r2(c.quality),
    quota: c.quota_state,
  };
}

export function decisionJson(
  res: RouteResult,
  req: RouteRequest,
  explain: boolean,
): Record<string, unknown> {
  const w = res.winner;
  const base: Record<string, unknown> = {
    role: res.role,
    floor: res.floor,
    ...(res.floor !== res.requested_floor ? { requested_floor: res.requested_floor } : {}),
    floor_quality: res.floor_quality,
  };
  if (!w) {
    return {
      ...base,
      target: null,
      action: "do_in_thread",
      reason:
        "No live candidate clears this floor (see rejected). Do the task in the orchestrator thread or ask the user; never route below the floor.",
      rejected: res.rejected,
      ...(res.best_below_floor ? { best_below_floor: candidateSummary(res.best_below_floor) } : {}),
    };
  }
  const hint = harnessHint(w.entry);
  return {
    ...base,
    target: {
      providerInstanceId: w.entry.provider,
      model: w.entry.model,
      options: w.entry.options,
    },
    ...(hint ? { harness: hint } : {}),
    est: candidateSummary(w),
    fallbacks: res.fallbacks.map((c) => ({
      id: c.entry.id,
      p_pass: r2(c.p_pass),
      expected_cost: r3(c.expected_cost),
      quota: c.quota_state,
    })),
    outcome_template: {
      ts: "<iso>",
      category: req.category,
      role: res.role,
      floor: res.floor,
      verifiability: req.verifiability,
      entry_id: w.entry.id,
      quota_state: w.quota_state,
      p_pass_est: r2(w.p_pass),
      cost_est_usd: r3(w.token_cost_usd),
      passed_first_try: "<bool>",
      escalated_to: null,
      duration_s: "<int>",
    },
    ...(explain ? { ranked: res.ranked.slice(0, 10).map(candidateSummary), rejected: res.rejected } : {}),
  };
}

export function renderTable(ctx: RouteContext): string {
  const providers = [...new Set(ctx.frontier.entries.map((e) => e.provider))].sort();
  const lines: string[] = [];
  lines.push("# pareto-delegate routes (generated)");
  lines.push("");
  lines.push(
    "Fallback for when `scripts/route.ts` cannot be run. Prefer the CLI: it applies live models, session throttling, author family and verifiability adjustments. Floors already include no verifiability shift here. Regenerate: `bun run scripts/route.ts --table --write`.",
  );
  lines.push("");
  const quotaDesc = providers
    .map((p) => `${p}=${ctx.quota.providers[p]?.state ?? "normal"}`)
    .join(", ");
  lines.push(`Quota at generation: ${quotaDesc}. Cells: \`model:effort\` (P(pass), est $).`);
  lines.push("");
  lines.push(`| role | floor | best overall | ${providers.join(" | ")} |`);
  lines.push(`|---|---|---|${providers.map(() => "---").join("|")}|`);
  const cell = (c: Candidate | null): string =>
    c ? `${c.entry.model}:${c.entry.effort} (${c.p_pass.toFixed(2)}, $${c.token_cost_usd.toFixed(2)})` : "—";
  for (const roleName of Object.keys(ctx.roles.roles)) {
    const category = (Object.entries(ctx.roles.category_roles).find(([, r]) => r === roleName)?.[0] ??
      "research") as TaskCategory;
    for (const floor of FLOORS) {
      const req: RouteRequest = {
        category,
        role: roleName,
        floor,
        verifiability: "moderate",
        blast_radius: "isolated_module",
        adjust_floor: false,
      };
      const all = selectRoute(ctx, req);
      const perProvider = providers.map((p) => cell(selectRoute(ctx, { ...req, providers: [p] }).winner));
      lines.push(`| ${roleName} | ${floor} | ${cell(all.winner)} | ${perProvider.join(" | ")} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseList(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseLive(v: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const item of parseList(v)) {
    const idx = item.indexOf(":");
    if (idx <= 0) throw new Error(`--live expects provider:model pairs, got '${item}'`);
    const p = item.slice(0, idx);
    (out[p] ??= []).push(item.slice(idx + 1));
  }
  return out;
}

const USAGE = `Usage: bun run scripts/route.ts --category <cat> --floor <R0..R3> [options]

  --category <cat>        research|log_triage|doc_summary|test_gen|mechanical_refactor|bugfix|
                          feature_slice|architecture|debugging|primary_review|second_opinion_review
  --role <role>           Override the category->role mapping (see roles.json)
  --floor <R0..R3>        Capability floor before verifiability adjustment
  --verify <v>            strict|moderate|subjective (default moderate)
  --blast <b>             single_file|isolated_module|multi_module (default isolated_module)
  --author-family <f>     claude|gemini|grok|openai (for cross-family review)
  --live p:m,p:m          Live models (T3 orchestrator_capabilities); default: whole catalog
  --provider p[,p]        Restrict to provider(s) (standalone single-provider harness)
  --throttled p|p:m,...   Providers/models rate-limited or unavailable this session
  --exclude id,...        Entry ids to skip (e.g. the attempt that just failed)
  --background            Async sidecar nobody waits on: latency weighted by background_latency_factor
  --no-adjust             Do not shift the floor for verifiability/blast radius
  --explain               Include top-10 ranking and rejection counts
  --table [--write]       Print (or write routes.md) the role x floor summary table

Exit codes: 0 = routed, 3 = no candidate (do the task in-thread), 1 = error.`;

function main(argv: readonly string[]): number {
  const args = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) throw new Error(`Unexpected argument '${a}'`);
    const eq = a.indexOf("=");
    if (eq > 0) {
      args.set(a.slice(2, eq), a.slice(eq + 1));
    } else if (["--explain", "--table", "--write", "--no-adjust", "--background", "--help"].includes(a)) {
      flags.add(a.slice(2));
    } else {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} requires a value`);
      args.set(a.slice(2), v);
      i += 1;
    }
  }
  if (flags.has("help")) {
    console.log(USAGE);
    return 0;
  }

  const ctx: RouteContext = {
    frontier: loadFrontier(),
    roles: loadRoles(),
    overrides: loadOverrides(),
    quota: loadQuota(),
  };

  if (flags.has("table")) {
    const table = renderTable(ctx);
    if (flags.has("write")) {
      writeFileSync(PATHS.routesTable, table, "utf8");
      console.log(`Wrote ${PATHS.routesTable}`);
    } else {
      console.log(table);
    }
    return 0;
  }

  const category = args.get("category");
  const floor = args.get("floor");
  const verify = args.get("verify") ?? "moderate";
  const blast = args.get("blast") ?? "isolated_module";
  if (!isTaskCategory(category)) throw new Error(`--category is required and must be valid.\n\n${USAGE}`);
  if (!isFloor(floor)) throw new Error(`--floor must be R0..R3.\n\n${USAGE}`);
  if (!isVerifiability(verify)) throw new Error("--verify must be strict|moderate|subjective");
  if (!isBlastRadius(blast)) throw new Error("--blast must be single_file|isolated_module|multi_module");

  const role = args.get("role");
  const fam = args.get("author-family");
  const live = args.get("live");
  const prov = args.get("provider");
  const thr = args.get("throttled");
  const exc = args.get("exclude");
  const req: RouteRequest = {
    category,
    floor,
    verifiability: verify,
    blast_radius: blast,
    ...(role ? { role } : {}),
    ...(fam ? { author_family: fam as ProviderFamily } : {}),
    ...(live ? { live: parseLive(live) } : {}),
    ...(prov ? { providers: parseList(prov) } : {}),
    ...(thr ? { throttled: parseList(thr) } : {}),
    ...(exc ? { exclude: parseList(exc) } : {}),
    ...(flags.has("no-adjust") ? { adjust_floor: false } : {}),
    ...(flags.has("background") ? { background: true } : {}),
  };
  const res = selectRoute(ctx, req);
  console.log(JSON.stringify(decisionJson(res, req, flags.has("explain")), null, 2));
  return res.winner ? 0 : 3;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
