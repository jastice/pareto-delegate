/**
 * Compare predicted first-try pass probabilities in outcomes.jsonl against what happened, and
 * suggest quality_bias overrides (in index points) per provider:model and role.
 *
 *   bun run <skill-dir>/scripts/calibrate.ts [--min-n 5] [--prior-sd 4] [--json]
 *
 * Model: P(pass) = sigmoid((quality - floor) / s + logit(p_at_floor)), so a quality shift of b
 * moves the logit by b / s. Each outcome logs the bias that was applied when it was routed, so
 * predictions are first de-biased to the prior: l_i = logit(p_i) - bias_i / s. The absolute bias b
 * is the MAP estimate under y_i ~ Bernoulli(sigmoid(l_i + b / s)) with prior b ~ N(0, prior_sd²),
 * fitted by Newton's method. This is exact for mixed floors/difficulties (no logit averaging) and
 * shrinks small samples toward the AA-derived prior. Suggestions replace existing biases.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PATHS, loadRoles } from "./config.ts";
import { isRecord, isFiniteNumber, isNonEmptyString } from "./types.ts";

export interface Row {
  readonly entry_id: string;
  readonly model_key: string;
  readonly role: string;
  readonly p: number;
  /** quality_bias applied when this attempt was routed (0 if not logged). */
  readonly bias: number;
  readonly passed: boolean;
}

const clamp = (p: number): number => Math.min(Math.max(p, 0.01), 0.99);
const logit = (p: number): number => Math.log(clamp(p) / (1 - clamp(p)));
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

function readRows(): { rows: Row[]; skipped: number } {
  if (!existsSync(PATHS.outcomes)) return { rows: [], skipped: 0 };
  const rows: Row[] = [];
  let skipped = 0;
  for (const line of readFileSync(PATHS.outcomes, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (
      !isRecord(rec) ||
      !isNonEmptyString(rec["entry_id"]) ||
      !isNonEmptyString(rec["role"]) ||
      !isFiniteNumber(rec["p_pass_est"]) ||
      typeof rec["passed_first_try"] !== "boolean"
    ) {
      skipped += 1;
      continue;
    }
    const id = rec["entry_id"];
    rows.push({
      entry_id: id,
      model_key: id.split(":").slice(0, 2).join(":"),
      role: rec["role"],
      p: rec["p_pass_est"],
      bias: isFiniteNumber(rec["quality_bias"]) ? rec["quality_bias"] : 0,
      passed: rec["passed_first_try"],
    });
  }
  return { rows, skipped };
}

export interface GroupStat {
  readonly key: string;
  readonly role: string;
  readonly n: number;
  readonly observed: number;
  readonly predicted: number;
  readonly implied_bias: number;
  readonly sd: number;
}

/** MAP estimate of the quality bias (index points) and its posterior sd. */
export function fitBias(
  rows: readonly Row[],
  scale: number,
  priorSd: number,
): { readonly bias: number; readonly sd: number } {
  const base = rows.map((r) => logit(r.p) - r.bias / scale);
  const inv = 1 / (priorSd * priorSd);
  let b = 0;
  let h = -inv;
  for (let iter = 0; iter < 50; iter += 1) {
    let g = -b * inv;
    h = -inv;
    for (let i = 0; i < rows.length; i += 1) {
      const p = sigmoid((base[i] ?? 0) + b / scale);
      g += ((rows[i]?.passed ? 1 : 0) - p) / scale;
      h -= (p * (1 - p)) / (scale * scale);
    }
    const step = g / h;
    b -= Math.max(Math.min(step, 10), -10);
    if (Math.abs(step) < 1e-6) break;
  }
  return { bias: b, sd: Math.sqrt(-1 / h) };
}

export function summarize(
  rows: readonly Row[],
  priorSd: number,
  scaleFor: (role: string) => number,
): GroupStat[] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.model_key}|${r.role}`;
    const g = groups.get(k) ?? [];
    g.push(r);
    groups.set(k, g);
  }
  const out: GroupStat[] = [];
  for (const [k, g] of groups) {
    const [key = "", role = ""] = k.split("|");
    const s0 = scaleFor(role);
    const fit = fitBias(g, s0, priorSd);
    const prior = g.reduce((s, r) => s + sigmoid(logit(r.p) - r.bias / s0), 0) / g.length;
    const observed = g.filter((r) => r.passed).length / g.length;
    out.push({ key, role, n: g.length, observed, predicted: prior, implied_bias: fit.bias, sd: fit.sd });
  }
  return out.sort((a, b) => b.n - a.n);
}

function main(argv: readonly string[]): void {
  const arg = (name: string, dflt: number): number => {
    const i = argv.indexOf(name);
    const v = i >= 0 ? Number(argv[i + 1]) : NaN;
    return Number.isFinite(v) ? v : dflt;
  };
  const minN = arg("--min-n", 5);
  const priorSd = arg("--prior-sd", 4);
  const roles = loadRoles();
  const scaleFor = (role: string): number =>
    roles.roles[role]?.logistic_scale ?? roles.defaults.logistic_scale;

  const { rows, skipped } = readRows();
  const stats = summarize(rows, priorSd, scaleFor);
  const brier = rows.length
    ? rows.reduce((s, r) => s + (r.p - (r.passed ? 1 : 0)) ** 2, 0) / rows.length
    : NaN;

  const suggestions: Record<string, { quality_bias: Record<string, number> }> = {};
  for (const s of stats) {
    if (s.n < minN || Math.abs(s.implied_bias) < Math.max(1, s.sd)) continue;
    const entry = (suggestions[s.key] ??= { quality_bias: {} });
    entry.quality_bias[s.role] = Math.round(s.implied_bias * 10) / 10;
  }

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ rows: rows.length, skipped, brier, stats, suggestions }, null, 2));
    return;
  }

  console.log(`${rows.length} usable outcomes (${skipped} skipped: legacy or incomplete lines).`);
  if (rows.length === 0) return;
  console.log(`Brier score: ${brier.toFixed(3)} (0.25 = coin flip)\n`);
  console.log(`${"provider:model".padEnd(34)} ${"role".padEnd(10)} ${"n".padStart(4)} ${"prior".padStart(6)} ${"obs".padStart(6)} ${"bias".padStart(6)} ${"±sd".padStart(5)}`);
  for (const s of stats) {
    console.log(
      `${s.key.padEnd(34)} ${s.role.padEnd(10)} ${String(s.n).padStart(4)} ${s.predicted.toFixed(2).padStart(6)} ${s.observed.toFixed(2).padStart(6)} ${s.implied_bias.toFixed(1).padStart(6)} ${s.sd.toFixed(1).padStart(5)}`,
    );
  }
  console.log(`\nprior = mean de-biased predicted pass rate; bias = MAP fit with prior sd ${priorSd} points.`);
  if (Object.keys(suggestions).length === 0) {
    console.log(`No suggestions yet (need n >= ${minN} and |bias| >= max(1 point, its sd)).`);
    return;
  }
  console.log("\nSuggested quality_bias for overrides.local.json (absolute values: replace existing biases for these keys):");
  console.log(JSON.stringify({ overrides: suggestions }, null, 2));
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main(process.argv.slice(2));
