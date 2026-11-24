import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nextEscalationRung, selectRoute, type BlastRadius } from "../scripts/route.ts";
import type {
  FrontierEntry,
  FrontierFile,
  QuotaFile,
  Rung,
  TaskCategory,
  Verifiability,
} from "../scripts/types.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontier = JSON.parse(
  readFileSync(resolve(ROOT, "frontier.json"), "utf8"),
) as FrontierFile;

interface SimTask {
  readonly required_rung: Rung;
  readonly category: TaskCategory;
  readonly verifiability: Verifiability;
  readonly blast_radius: BlastRadius;
  readonly difficulty: number;
}

interface PolicyMetrics {
  readonly name: string;
  readonly total_tasks: number;
  readonly first_pass_rate: number;
  readonly final_pass_rate: number;
  readonly rework_rate: number;
  readonly total_api_cost_usd: number;
  readonly primary_sub_cost_usd: number;
  readonly surplus_soak_share: number;
  readonly cost_per_passing_task_usd: number;
  readonly primary_cost_per_passing_usd: number;
  readonly mean_ttft_s: number;
  readonly provider_shares: Readonly<Record<string, number>>;
}

// Deterministic Mulberry32 PRNG for reproducible eval runs
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateWorkload(count: number, seed: number): readonly SimTask[] {
  const rng = createRng(seed);
  const uniform = (lo: number, hi: number): number => lo + rng() * (hi - lo);
  const tasks: SimTask[] = [];

  for (let i = 0; i < count; i += 1) {
    const r = rng();
    if (r < 0.30) {
      // 30% R0: scouting / log triage / doc summary
      tasks.push({
        required_rung: "R0",
        category: rng() < 0.6 ? "research" : "log_triage",
        verifiability: rng() < 0.5 ? "strict" : "moderate",
        blast_radius: "single_file",
        difficulty: uniform(18, 30),
      });
    } else if (r < 0.50) {
      // 20% R1 strict-gate: unit tests / mechanical refactors
      tasks.push({
        required_rung: "R1",
        category: rng() < 0.6 ? "test_gen" : "mechanical_refactor",
        verifiability: "strict",
        blast_radius: "isolated_module",
        difficulty: uniform(26, 36),
      });
    } else if (r < 0.68) {
      // 18% R1 general: localized bugfix / feature slice
      tasks.push({
        required_rung: "R1",
        category: rng() < 0.6 ? "bugfix" : "feature_slice",
        verifiability: "moderate",
        blast_radius: "isolated_module",
        difficulty: uniform(34, 43),
      });
    } else if (r < 0.90) {
      // 22% R2: cross-module debugging / feature / primary review
      tasks.push({
        required_rung: "R2",
        category: rng() < 0.5 ? "debugging" : "feature_slice",
        verifiability: rng() < 0.5 ? "strict" : "moderate",
        blast_radius: "multi_module",
        difficulty: uniform(44, 53),
      });
    } else {
      // 10% R3: architecture / subtle concurrency invariants
      tasks.push({
        required_rung: "R3",
        category: "architecture",
        verifiability: "subjective",
        blast_radius: "multi_module",
        difficulty: uniform(52, 60),
      });
    }
  }
  return tasks;
}

// Logistic IRT pass probability calibrated to AA Intelligence Index v5
function passProbability(modelIndex: number, difficulty: number, scale = 4.2): number {
  return 1 / (1 + Math.exp(-(modelIndex - difficulty) / scale));
}

function getEntryOrThrow(id: string): FrontierEntry {
  const found = frontier.entries.find((e) => e.id === id);
  if (!found) throw new Error(`Missing frontier entry: ${id}`);
  return found;
}

function runPolicy(
  name: string,
  tasks: readonly SimTask[],
  quota: QuotaFile,
  pickAttempt1: (task: SimTask) => FrontierEntry,
  pickEscalation: (task: SimTask, attempt1: FrontierEntry) => FrontierEntry | null,
  seed: number,
): PolicyMetrics {
  const rng = createRng(seed);
  let firstPasses = 0;
  let finalPasses = 0;
  let reworks = 0;
  let totalApiCost = 0;
  let primarySubCost = 0;
  let totalTtft = 0;
  let totalAttempts = 0;
  let surplusAttempts = 0;
  const providerCounts: Record<string, number> = {};

  const isSurplusProvider = (provider: string): boolean =>
    quota.providers[provider]?.state === "surplus";

  const recordAttempt = (entry: FrontierEntry): void => {
    totalAttempts += 1;
    totalApiCost += entry.benchmarks.task_cost_usd;
    totalTtft += entry.benchmarks.ttft_s;
    providerCounts[entry.provider] = (providerCounts[entry.provider] ?? 0) + 1;
    if (isSurplusProvider(entry.provider)) {
      surplusAttempts += 1;
    } else {
      primarySubCost += entry.benchmarks.task_cost_usd;
    }
  };

  for (const task of tasks) {
    const attempt1 = pickAttempt1(task);
    recordAttempt(attempt1);

    const passed1 = rng() < passProbability(attempt1.benchmarks.intelligence_index, task.difficulty);
    if (passed1) {
      firstPasses += 1;
      finalPasses += 1;
      continue;
    }

    // Attempt 1 failed -> pay small triage latency (5s) + escalate once
    reworks += 1;
    totalTtft += 5;
    const attempt2 = pickEscalation(task, attempt1);
    if (!attempt2) continue;

    recordAttempt(attempt2);
    // Escalated delegate receives failure diagnostics (+2 index effective boost)
    const passed2 =
      rng() < passProbability(attempt2.benchmarks.intelligence_index + 2, task.difficulty);
    if (passed2) {
      finalPasses += 1;
    }
  }

  const shares: Record<string, number> = {};
  for (const [prov, cnt] of Object.entries(providerCounts)) {
    shares[prov] = Number(((cnt / totalAttempts) * 100).toFixed(1));
  }

  return {
    name,
    total_tasks: tasks.length,
    first_pass_rate: Number(((firstPasses / tasks.length) * 100).toFixed(1)),
    final_pass_rate: Number(((finalPasses / tasks.length) * 100).toFixed(1)),
    rework_rate: Number(((reworks / tasks.length) * 100).toFixed(1)),
    total_api_cost_usd: Number(totalApiCost.toFixed(2)),
    primary_sub_cost_usd: Number(primarySubCost.toFixed(2)),
    surplus_soak_share: Number(((surplusAttempts / totalAttempts) * 100).toFixed(1)),
    cost_per_passing_task_usd: Number((totalApiCost / Math.max(finalPasses, 1)).toFixed(2)),
    primary_cost_per_passing_usd: Number((primarySubCost / Math.max(finalPasses, 1)).toFixed(2)),
    mean_ttft_s: Number((totalTtft / tasks.length).toFixed(1)),
    provider_shares: shares,
  };
}

function main(): void {
  const N = 1000;
  const tasks = generateWorkload(N, 20261124);

  const quotaSurplusCursorScarceClaude: QuotaFile = {
    schema_version: 1,
    updated_at: "2026-11-24T00:00:00Z",
    providers: {
      cursor: { state: "surplus", resets_at: null },
      claudeAgent: { state: "scarce", reserve_for_min_rung: "R3", resets_at: null },
      antigravity: { state: "normal", resets_at: null },
    },
  };

  const normalQuota: QuotaFile = {
    schema_version: 1,
    updated_at: "2026-11-24T00:00:00Z",
    providers: {
      cursor: { state: "normal", resets_at: null },
      claudeAgent: { state: "normal", resets_at: null },
      antigravity: { state: "normal", resets_at: null },
    },
  };

  const claudeTop = [...frontier.entries]
    .filter((e) => e.provider === "claudeAgent")
    .sort((a, b) => b.benchmarks.intelligence_index - a.benchmarks.intelligence_index)[0];
  if (!claudeTop) throw new Error("Missing claudeAgent entry in frontier.json");
  const fableMax = claudeTop;
  const neonHigh = getEntryOrThrow("antigravity:gemini-4-neon:high");
  const grokHigh = getEntryOrThrow("cursor:grok-4.7:high");

  const results: PolicyMetrics[] = [
    // 1. Always-Flagship (top available Claude model)
    runPolicy(
      `Always Flagship (${fableMax.model} ${String(Object.values(fableMax.options)[0] ?? "")})`,
      tasks,
      quotaSurplusCursorScarceClaude,
      () => fableMax,
      () => fableMax,
      42,
    ),
    // 2. Single Default Workhorse (Gemini 4 Neon high)
    runPolicy(
      "Single Model (Gemini 4 Neon high)",
      tasks,
      quotaSurplusCursorScarceClaude,
      () => neonHigh,
      () => fableMax,
      42,
    ),
    // 3. Naive Always-Surplus (burn Cursor Grok 4.7 everywhere, escalate to Fable on failure)
    runPolicy(
      "Naive Always-Surplus (Grok 4.7 everywhere)",
      tasks,
      quotaSurplusCursorScarceClaude,
      () => grokHigh,
      () => fableMax,
      42,
    ),
    // 4. Static Pareto (cost-optimal rungs, ignores Cursor surplus & Claude scarcity)
    runPolicy(
      "Pareto Static (ignores quota)",
      tasks,
      quotaSurplusCursorScarceClaude,
      (task) => {
        const d = selectRoute(frontier, normalQuota, task);
        return d?.entry ?? neonHigh;
      },
      (task) => {
        const next = nextEscalationRung(task.required_rung) ?? "R3";
        const d = selectRoute(frontier, normalQuota, { ...task, required_rung: next });
        return d?.entry ?? fableMax;
      },
      42,
    ),
    // 5. pareto-delegate (hard quality floors + quota pressure + 1-shot escalation)
    runPolicy(
      "pareto-delegate (floors + quota + 1-shot)",
      tasks,
      quotaSurplusCursorScarceClaude,
      (task) => {
        const d = selectRoute(frontier, quotaSurplusCursorScarceClaude, task);
        return d?.entry ?? neonHigh;
      },
      (task) => {
        const next = nextEscalationRung(task.required_rung) ?? "R3";
        const d = selectRoute(frontier, quotaSurplusCursorScarceClaude, {
          ...task,
          required_rung: next,
        });
        return d?.entry ?? fableMax;
      },
      42,
    ),
  ];

  const jsonFlag = process.argv.includes("--json");
  if (jsonFlag) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log(
    `Simulated ${N} tasks (30% R0, 20% R1-strict, 18% R1-mod, 22% R2, 10% R3)`,
  );
  console.log(
    `Quota regime: cursor=surplus, antigravity=normal, claudeAgent=scarce (R3)\n`,
  );
  console.log(
    `${"Policy".padEnd(44)} ${"1st%".padStart(5)} ${"Fin%".padStart(5)} ${"Prim$/ok".padStart(9)} ${"Tot$/ok".padStart(8)} ${"TTFT".padStart(6)}  Shares`,
  );
  console.log("-".repeat(106));
  for (const r of results) {
    const shares = Object.entries(r.provider_shares)
      .map(([k, v]) => `${k}:${v}%`)
      .join(" ");
    console.log(
      `${r.name.padEnd(44)} ${String(r.first_pass_rate).padStart(5)} ${String(r.final_pass_rate).padStart(5)} ${("$" + r.primary_cost_per_passing_usd.toFixed(2)).padStart(9)} ${("$" + r.cost_per_passing_task_usd.toFixed(2)).padStart(8)} ${(r.mean_ttft_s + "s").padStart(6)}  ${shares}`,
    );
  }
}

main();
