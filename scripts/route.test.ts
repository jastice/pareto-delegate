import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { PATHS, loadFrontier } from "./config.ts";
import {
  adjustFloor,
  buildQuantileMapper,
  estimateAttempt,
  passProbability,
  resolveOverride,
} from "./model.ts";
import { selectRoute, type RouteContext, type RouteRequest } from "./route.ts";
import { normalizeAAApiModel } from "./sync-benchmarks.ts";
import type {
  AAModelRecord,
  FrontierEntry,
  OverridesFile,
  QuotaFile,
  RolesFile,
} from "./types.ts";

const frontier = loadFrontier();
const roles = JSON.parse(readFileSync(PATHS.roles, "utf8")) as RolesFile;
const overrides = JSON.parse(readFileSync(PATHS.overrides, "utf8")) as OverridesFile;

function quota(states: Record<string, Partial<QuotaFile["providers"][string]>>): QuotaFile {
  const providers: Record<string, QuotaFile["providers"][string]> = {};
  for (const p of ["claudeAgent", "antigravity", "cursor"]) {
    providers[p] = { state: "normal", resets_at: null, ...(states[p] ?? {}) };
  }
  return { schema_version: 1, updated_at: "2026-11-24T00:00:00Z", providers };
}

const ctx = (q: QuotaFile = quota({})): RouteContext => ({ frontier, roles, overrides, quota: q });

const base: RouteRequest = {
  category: "bugfix",
  floor: "R1",
  verifiability: "moderate",
  blast_radius: "isolated_module",
};

const CLAUDE_ONLY = { providers: ["claudeAgent"] } as const;

function record(slug: string, index: number, extra: Partial<AAModelRecord> = {}): AAModelRecord {
  return {
    id: slug,
    name: slug,
    slug,
    creator: "x",
    index,
    input: 1,
    output: 5,
    task: 1,
    tps: 100,
    ttft: 5,
    ...extra,
  };
}

describe("model", () => {
  test("quantile mapper is identity for the base index and scale-free for other metrics", () => {
    const recs = [10, 20, 30, 40, 50].map((i) => record(`m${i}`, i, { evals: { tb: i / 100 } }));
    const baseMap = buildQuantileMapper(recs, "artificial_analysis_intelligence_index");
    assert.equal(baseMap?.map(33), 33);
    const tb = buildQuantileMapper(recs, "tb");
    assert.ok(tb);
    assert.equal(tb.n, 5);
    assert.equal(tb.map(0.3), 30);
    assert.equal(tb.map(0.5), 50);
  });

  test("pass probability is pinned at the floor and monotone in quality", () => {
    assert.ok(Math.abs(passProbability(40, 40, 0.75, 4) - 0.75) < 1e-9);
    assert.ok(passProbability(50, 40, 0.75, 4) > 0.95);
    assert.ok(passProbability(35, 40, 0.75, 4) < 0.5);
  });

  test("cache share and verbosity drive attempt cost", () => {
    const entry = frontier.entries.find((e) => e.id === "claudeAgent:claude-opus-5-5:medium");
    assert.ok(entry);
    const role = roles.roles["implement"];
    assert.ok(role);
    const cached = estimateAttempt(entry, role, roles, frontier);
    const uncached = estimateAttempt(
      entry,
      { ...role, tokens: { ...role.tokens, cache_hit_share: 0 } },
      roles,
      frontier,
    );
    assert.ok(uncached.token_cost_usd > cached.token_cost_usd * 2);
    const verbose = estimateAttempt(
      { ...entry, aa: { ...entry.aa, output_tokens: entry.aa.output_tokens * 4 } },
      role,
      roles,
      frontier,
    );
    assert.ok(verbose.token_cost_usd > cached.token_cost_usd);
  });

  test("overrides layer provider:* < provider:model < entry and accept legacy names", () => {
    const entry = frontier.entries.find((e) => e.id === "claudeAgent:claude-opus-5-5:high") as FrontierEntry;
    const ov = resolveOverride(entry, {
      schema_version: 2,
      overrides: {
        "claudeAgent:*": { quality_bias: { implement: 2 }, max_floor: "R1" },
        "claudeAgent:claude-opus-5-5": { quality_bias: 1 },
      },
      entry_overrides: { "claudeAgent:claude-opus-5-5:high": { max_rung: "R3" } },
    });
    assert.equal(ov.quality_bias("implement"), 3);
    assert.equal(ov.quality_bias("scout"), 1);
    assert.equal(ov.max_floor, "R3");
  });

  test("floor adjustment follows verifiability and blast radius", () => {
    assert.equal(adjustFloor("R1", "strict", "single_file", roles), "R0");
    assert.equal(adjustFloor("R1", "strict", "isolated_module", roles), "R1");
    assert.equal(adjustFloor("R2", "subjective", "multi_module", roles), "R3");
    assert.equal(adjustFloor("R3", "subjective", "multi_module", roles), "R3");
  });
});

describe("routing", () => {
  test("Claude-only scouting does not burn Opus", () => {
    const res = selectRoute(ctx(), { ...base, category: "research", floor: "R0", ...CLAUDE_ONLY });
    assert.ok(res.winner);
    assert.equal(res.role, "scout");
    assert.doesNotMatch(res.winner.entry.model, /opus|fable/);
  });

  test("every winner clears the floor, with or without surplus", () => {
    for (const q of [quota({}), quota({ cursor: { state: "surplus" } })]) {
      for (const floor of ["R0", "R1", "R2", "R3"] as const) {
        const res = selectRoute(ctx(q), { ...base, floor, adjust_floor: false });
        assert.ok(res.winner, floor);
        assert.ok(res.winner.quality >= res.floor_quality, `${floor} ${res.winner.entry.id}`);
      }
    }
  });

  test("surplus Grok soaks strict scouting-grade work but never general R1 bugfix", () => {
    const q = quota({ cursor: { state: "surplus" } });
    const testGen = selectRoute(ctx(q), {
      ...base,
      category: "test_gen",
      verifiability: "strict",
      blast_radius: "single_file",
      providers: ["cursor", "antigravity"],
      background: true,
    });
    assert.equal(testGen.floor, "R0");
    assert.equal(testGen.winner?.entry.provider, "cursor");
    const normal = selectRoute(ctx(), {
      ...base,
      category: "test_gen",
      verifiability: "strict",
      blast_radius: "single_file",
      providers: ["cursor", "antigravity"],
      background: true,
    });
    assert.equal(normal.winner?.entry.provider, "antigravity");
    const bugfix = selectRoute(ctx(q), base);
    assert.notEqual(bugfix.winner?.entry.provider, "cursor");
  });

  test("throttled providers are skipped; nothing live means do it in-thread", () => {
    const res = selectRoute(ctx(), { ...base, throttled: ["antigravity"] });
    assert.notEqual(res.winner?.entry.provider, "antigravity");
    const none = selectRoute(ctx(), { ...base, ...CLAUDE_ONLY, throttled: ["claudeAgent"] });
    assert.equal(none.winner, null);
    assert.ok((none.rejected["throttled"] ?? 0) > 0);
  });

  test("expired throttle resets to normal", () => {
    const q = quota({ claudeAgent: { state: "throttled", resets_at: "2026-01-01T00:00:00Z" } });
    const res = selectRoute(ctx(q), { ...base, ...CLAUDE_ONLY });
    assert.ok(res.winner);
  });

  test("review prefers another family, falls back cleanly in single-provider mode", () => {
    const req: RouteRequest = {
      ...base,
      category: "primary_review",
      floor: "R2",
      author_family: "gemini",
      adjust_floor: false,
    };
    assert.notEqual(selectRoute(ctx(), req).winner?.entry.family, "gemini");
    const claudeOnly = selectRoute(ctx(), { ...req, author_family: "claude", ...CLAUDE_ONLY });
    assert.equal(claudeOnly.winner?.entry.family, "claude");
  });

  test("scarce reserve keeps a provider for high floors unless it is the only option", () => {
    const q = quota({ claudeAgent: { state: "scarce", reserve_for_min_rung: "R2" } });
    const r0 = selectRoute(ctx(q), { ...base, category: "research", floor: "R0" });
    assert.notEqual(r0.winner?.entry.provider, "claudeAgent");
    const only = selectRoute(ctx(q), { ...base, category: "research", floor: "R0", ...CLAUDE_ONLY });
    assert.equal(only.winner?.entry.provider, "claudeAgent");
  });

  test("escalation via --exclude picks a different entry", () => {
    const first = selectRoute(ctx(), { ...base, ...CLAUDE_ONLY });
    assert.ok(first.winner);
    const second = selectRoute(ctx(), {
      ...base,
      ...CLAUDE_ONLY,
      floor: "R2",
      exclude: [first.winner.entry.id],
    });
    assert.ok(second.winner);
    assert.notEqual(second.winner.entry.id, first.winner.entry.id);
  });

  test("quality_bias shifts the choice without touching the frontier", () => {
    const biased: RouteContext = {
      ...ctx(),
      overrides: { schema_version: 2, overrides: { "antigravity:*": { quality_bias: -30 } } },
    };
    const res = selectRoute(biased, { ...base, floor: "R2", adjust_floor: false });
    assert.notEqual(res.winner?.entry.provider, "antigravity");
  });
});

describe("AA API normalization", () => {
  test("parses free and pro shaped records", () => {
    const rec = normalizeAAApiModel({
      id: "x",
      name: "Model X (High)",
      slug: "model-x-high",
      model_creator: { id: "c", name: "Lab" },
      evaluations: {
        artificial_analysis_intelligence_index: 55.1,
        artificial_analysis_coding_index: 60.2,
        terminalbench_hard: 0.41,
        ifbench: null,
      },
      pricing: { price_1m_input_tokens: 3, price_1m_output_tokens: 15, price_1m_cache_hit_tokens: 0.3 },
      performance: {
        median_output_tokens_per_second: 120,
        median_time_to_first_answer_token_seconds: 30.5,
        median_time_to_first_token_seconds: 0.8,
      },
      artificial_analysis_intelligence_index_cost: { total_cost: 900, cost_per_task: { total_cost: 1.9 } },
      artificial_analysis_intelligence_index_token_counts: { output_tokens: 40_000_000 },
    });
    assert.ok(rec);
    assert.equal(rec.index, 55.1);
    assert.equal(rec.cache_hit, 0.3);
    assert.equal(rec.task, 1.9);
    assert.equal(rec.ttft, 30.5);
    assert.equal(rec.evals?.["terminalbench_hard"], 0.41);
    assert.equal(rec.evals?.["ifbench"], undefined);
    assert.equal(rec.tokens?.output_tokens, 40_000_000);
  });
});
