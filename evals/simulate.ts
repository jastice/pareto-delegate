/**
 * Feedback-loop simulation. Unlike a plain benchmark replay (which would only confirm that the
 * router agrees with AA), this injects a hidden per-family "true bias" — how far real agentic
 * performance deviates from the AA-derived role quality — and checks that:
 *   1. the uncalibrated router pays for the mismatch,
 *   2. scripts/calibrate.ts recovers the bias from outcomes alone,
 *   3. routing with the recovered quality_bias closes most of the gap,
 *   4. exploration jitter during learning widens what gets calibrated (models the deterministic
 *      router never picks keep their prior otherwise).
 *
 *   bun run evals/simulate.ts [--n 3000] [--truth claude=4,gemini=-4,grok=-3] [--providers a,b]
 */
import { loadFrontier, loadOverrides, loadQuota, loadRoles } from "../scripts/config.ts";
import { passProbability } from "../scripts/model.ts";
import { seededRng, selectRoute, type Candidate, type RouteContext, type RouteRequest } from "../scripts/route.ts";
import { summarize, type Row } from "../scripts/calibrate.ts";
import {
  FLOORS,
  FLOOR_ORDER,
  type BlastRadius,
  type EntryOverride,
  type Floor,
  type TaskCategory,
  type Verifiability,
} from "../scripts/types.ts";

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Task {
  readonly category: TaskCategory;
  readonly floor: Floor;
  readonly verifiability: Verifiability;
  readonly blast_radius: BlastRadius;
}

const MIX: ReadonlyArray<readonly [number, Task]> = [
  [0.25, { category: "research", floor: "R0", verifiability: "moderate", blast_radius: "single_file" }],
  [0.15, { category: "test_gen", floor: "R1", verifiability: "strict", blast_radius: "isolated_module" }],
  [0.2, { category: "bugfix", floor: "R1", verifiability: "moderate", blast_radius: "isolated_module" }],
  [0.15, { category: "debugging", floor: "R2", verifiability: "moderate", blast_radius: "multi_module" }],
  [0.15, { category: "primary_review", floor: "R2", verifiability: "moderate", blast_radius: "multi_module" }],
  [0.1, { category: "architecture", floor: "R2", verifiability: "subjective", blast_radius: "multi_module" }],
];

function parseArgs(argv: readonly string[]): { n: number; truth: Record<string, number>; providers?: string[] } {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const truth: Record<string, number> = { claude: 4, gemini: -4, grok: -3, openai: 0 };
  for (const pair of (get("--truth") ?? "").split(",").filter(Boolean)) {
    const [k, v] = pair.split("=");
    if (k && v !== undefined) truth[k] = Number(v);
  }
  const prov = get("--providers");
  return { n: Number(get("--n") ?? 3000), truth, ...(prov ? { providers: prov.split(",") } : {}) };
}

interface Metrics {
  first_pass: number;
  final_pass: number;
  cost: number;
  failure_cost: number;
  minutes: number;
  shares: Record<string, number>;
  rows: Row[];
}

function run(
  baseCtx: RouteContext,
  tasks: readonly Task[],
  truth: Record<string, number>,
  seed: number,
  providers?: string[],
  explore = false,
): Metrics {
  const rand = rng(seed);
  const pick = seededRng(seed * 7919);
  const observations = new Map<string, number>();
  const ctx: RouteContext = { ...baseCtx, observations };
  const m: Metrics = { first_pass: 0, final_pass: 0, cost: 0, failure_cost: 0, minutes: 0, shares: {}, rows: [] };
  const truePass = (c: Candidate, res: { role: string; floor_quality: number }): number => {
    const role = ctx.roles.roles[res.role];
    const pAt = role?.p_pass_at_floor ?? ctx.roles.defaults.p_pass_at_floor;
    const s = role?.logistic_scale ?? ctx.roles.defaults.logistic_scale;
    // Strip any routing bias: truth is AA quality + hidden family bias.
    const q = c.quality - c.quality_bias + (truth[c.entry.family] ?? 0);
    return passProbability(q, res.floor_quality, pAt, s);
  };

  for (const task of tasks) {
    const req: RouteRequest = { ...task, ...(providers ? { providers } : {}) };
    const res = selectRoute(ctx, { ...req, explore, rng: pick });
    const c = res.winner;
    if (!c) continue;
    const obsKey = `${c.entry.provider}:${c.entry.model}|${res.role}`;
    observations.set(obsKey, (observations.get(obsKey) ?? 0) + 1);
    m.cost += c.token_cost_usd;
    m.minutes += c.time_s / 60;
    m.shares[c.entry.provider] = (m.shares[c.entry.provider] ?? 0) + 1;
    const passed = rand() < truePass(c, res);
    m.rows.push({
      entry_id: c.entry.id,
      model_key: `${c.entry.provider}:${c.entry.model}`,
      role: res.role,
      p: c.p_pass,
      bias: c.quality_bias,
      passed,
    });
    if (passed) {
      m.first_pass += 1;
      m.final_pass += 1;
      continue;
    }
    const role = ctx.roles.roles[res.role];
    m.failure_cost += role?.failure_cost_usd[res.floor] ?? 0;
    // 1-shot escalation: fresh delegate one floor up, excluding the failed entry.
    const next = FLOORS[Math.min(FLOOR_ORDER[res.floor] + 1, 3)] ?? "R3";
    const esc = selectRoute(ctx, { ...req, floor: next, adjust_floor: false, exclude: [c.entry.id] });
    const c2 = esc.winner;
    if (!c2) continue;
    m.cost += c2.token_cost_usd;
    m.minutes += c2.time_s / 60;
    if (rand() < truePass(c2, esc)) m.final_pass += 1;
  }
  return m;
}

function main(): void {
  const { n, truth, providers } = parseArgs(process.argv.slice(2));
  const r = rng(20261124);
  const tasks: Task[] = [];
  for (let i = 0; i < n; i += 1) {
    let x = r();
    for (const [w, t] of MIX) {
      if ((x -= w) <= 0) {
        tasks.push(t);
        break;
      }
    }
  }

  const base: RouteContext = {
    frontier: loadFrontier(),
    roles: loadRoles(),
    overrides: loadOverrides(),
    quota: loadQuota(),
  };

  const scaleFor = (role: string): number =>
    base.roles.roles[role]?.logistic_scale ?? base.roles.defaults.logistic_scale;
  const learn = (m: Metrics): { ctx: RouteContext; stats: ReturnType<typeof summarize> } => {
    const stats = summarize(m.rows, 4, scaleFor);
    const learned: Record<string, EntryOverride> = { ...(base.overrides.overrides ?? {}) };
    for (const s of stats) {
      if (s.n < 5) continue;
      const prev = learned[s.key] ?? {};
      const qb = typeof prev.quality_bias === "object" ? { ...prev.quality_bias } : {};
      qb[s.role] = Math.round(s.implied_bias * 10) / 10;
      learned[s.key] = { ...prev, quality_bias: qb };
    }
    return { ctx: { ...base, overrides: { ...base.overrides, overrides: learned } }, stats };
  };

  // Online learning: route a batch, recalibrate on all outcomes so far, repeat.
  const rounds = 6;
  const online = (explore: boolean): { totals: Metrics; final: ReturnType<typeof learn> } => {
    const batch = Math.ceil(tasks.length / rounds);
    let ctx = base;
    const allRows: Row[] = [];
    const totals: Metrics = { first_pass: 0, final_pass: 0, cost: 0, failure_cost: 0, minutes: 0, shares: {}, rows: [] };
    for (let r = 0; r < rounds; r += 1) {
      const m = run(ctx, tasks.slice(r * batch, (r + 1) * batch), truth, 100 + r, providers, explore);
      totals.first_pass += m.first_pass;
      totals.final_pass += m.final_pass;
      totals.cost += m.cost;
      totals.failure_cost += m.failure_cost;
      totals.minutes += m.minutes;
      for (const [k, v] of Object.entries(m.shares)) totals.shares[k] = (totals.shares[k] ?? 0) + v;
      allRows.push(...m.rows);
      ctx = learn({ ...m, rows: allRows }).ctx;
    }
    return { totals: { ...totals, rows: allRows }, final: learn({ ...totals, rows: allRows }) };
  };

  const before = run(base, tasks, truth, 1, providers, false);
  const det = online(false);
  const exp = online(true);
  const stats = exp.final.stats;

  const fmt = (label: string, x: Metrics): string => {
    const shares = Object.entries(x.shares)
      .map(([k, v]) => `${k}:${((v / tasks.length) * 100).toFixed(0)}%`)
      .join(" ");
    const total = x.cost + x.failure_cost;
    return `${label.padEnd(22)} ${((x.first_pass / tasks.length) * 100).toFixed(1).padStart(6)} ${((x.final_pass / tasks.length) * 100).toFixed(1).padStart(6)} ${("$" + (x.cost / tasks.length).toFixed(3)).padStart(8)} ${("$" + (total / tasks.length).toFixed(3)).padStart(9)} ${(x.minutes / tasks.length).toFixed(1).padStart(6)}  ${shares}`;
  };

  console.log(`Simulated ${tasks.length} tasks; hidden true bias (index points): ${JSON.stringify(truth)}${providers ? `; providers: ${providers.join(",")}` : ""}\n`);
  console.log(`${"policy".padEnd(22)} ${"1st%".padStart(6)} ${"fin%".padStart(6)} ${"$tok/t".padStart(8)} ${"$+fail/t".padStart(9)} ${"min/t".padStart(6)}  shares`);
  console.log(fmt("prior only (static)", before));
  console.log(fmt(`online, ${rounds} rounds`, det.totals));
  console.log(fmt(`online + exploration`, exp.totals));
  const pairs = (st: ReturnType<typeof summarize>): number => st.filter((x) => x.n >= 20).length;
  console.log(`\n(model, role) pairs with n >= 20: online ${pairs(det.final.stats)}, online + exploration ${pairs(stats)}`);
  console.log("\nBias estimates after online + exploration (n >= 20):");
  for (const s of stats.filter((s) => s.n >= 20)) {
    const fam = base.frontier.entries.find((e) => `${e.provider}:${e.model}` === s.key)?.family ?? "?";
    console.log(`  ${`${s.key}|${s.role}`.padEnd(44)} n=${String(s.n).padStart(4)}  learned ${s.implied_bias.toFixed(1).padStart(5)}  true ${(truth[fam] ?? 0).toFixed(1)}`);
  }
}

main();
