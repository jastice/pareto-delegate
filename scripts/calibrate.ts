/**
 * Compare predicted first-try pass probabilities in outcomes.jsonl against what happened, and
 * suggest quality_bias overrides (in index points) per provider:model and role.
 *
 *   bun run <skill-dir>/scripts/calibrate.ts [--min-n 5] [--prior 5] [--json]
 *
 * Model: P(pass) = sigmoid((quality - floor) / s + logit(p_at_floor)), so a quality shift of b
 * moves the logit by b / s. Implied bias = s * (logit(observed) - mean logit(predicted)), with the
 * observed rate shrunk toward the prediction by a Beta prior of strength --prior.
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
}

export function summarize(rows: readonly Row[], prior: number, scaleFor: (role: string) => number): GroupStat[] {
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
    const n = g.length;
    const meanLogit = g.reduce((s, r) => s + logit(r.p), 0) / n;
    const predicted = sigmoid(meanLogit);
    const passes = g.filter((r) => r.passed).length;
    const observed = (passes + prior * predicted) / (n + prior);
    out.push({
      key,
      role,
      n,
      observed,
      predicted,
      implied_bias: scaleFor(role) * (logit(observed) - meanLogit),
    });
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
  const prior = arg("--prior", 5);
  const roles = loadRoles();
  const scaleFor = (role: string): number =>
    roles.roles[role]?.logistic_scale ?? roles.defaults.logistic_scale;

  const { rows, skipped } = readRows();
  const stats = summarize(rows, prior, scaleFor);
  const brier = rows.length
    ? rows.reduce((s, r) => s + (r.p - (r.passed ? 1 : 0)) ** 2, 0) / rows.length
    : NaN;

  const suggestions: Record<string, { quality_bias: Record<string, number> }> = {};
  for (const s of stats) {
    if (s.n < minN || Math.abs(s.implied_bias) < 1) continue;
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
  console.log(`${"provider:model".padEnd(34)} ${"role".padEnd(10)} ${"n".padStart(4)} ${"pred".padStart(6)} ${"obs*".padStart(6)} ${"bias".padStart(6)}`);
  for (const s of stats) {
    console.log(
      `${s.key.padEnd(34)} ${s.role.padEnd(10)} ${String(s.n).padStart(4)} ${s.predicted.toFixed(2).padStart(6)} ${s.observed.toFixed(2).padStart(6)} ${s.implied_bias.toFixed(1).padStart(6)}`,
    );
  }
  console.log(`\n* observed rate shrunk toward prediction with prior strength ${prior}.`);
  if (Object.keys(suggestions).length === 0) {
    console.log(`No suggestions yet (need n >= ${minN} and |bias| >= 1 point).`);
    return;
  }
  console.log("\nSuggested additions to overrides.local.json (merge into \"overrides\"; biases add to existing ones):");
  console.log(JSON.stringify({ overrides: suggestions }, null, 2));
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main(process.argv.slice(2));
