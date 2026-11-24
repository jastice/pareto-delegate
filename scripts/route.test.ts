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
import { deflateRawSync } from "node:zlib";
import { extractRows, parseCsv, parseModelVersion, readZip } from "./epoch.ts";
import { agenticAnchors } from "./model.ts";
import { fitBias, type Row } from "./calibrate.ts";
import { seededRng } from "./route.ts";
import { buildFrontier, normalizeAAApiModel } from "./sync-benchmarks.ts";
import type {
  AAModelRecord,
  FrontierEntry,
  OverridesFile,
  QuotaFile,
  RolesFile,
} from "./types.ts";

// Tests pin the tracked mirror frontier so local API/Epoch data cannot change outcomes.
const frontier = loadFrontier(PATHS.frontier);
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

function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("Epoch ingestion", () => {
  test("zip reader, quoted CSV and model-version parsing", () => {
    const files = readZip(zip({ "a.csv": 'Model version,Score,Notes\n"m_x, y",1,"say ""hi""\nthere"\n' }));
    const rows = parseCsv(files.get("a.csv")?.toString("utf8") ?? "");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.["Model version"], "m_x, y");
    assert.equal(rows[0]?.["Notes"], 'say "hi"\nthere');
    assert.deepEqual(parseModelVersion("claude-opus-5-5_high"), { base: "claude-opus-5-5", effort: "high" });
    assert.deepEqual(parseModelVersion("grok-4.7_unknown"), { base: "grok-4-7", effort: null });
    assert.deepEqual(parseModelVersion("gemini-4-neon_xhigh"), { base: "gemini-4-neon", effort: "xhigh" });
  });

  test("keeps the best row per model/effort with its measurements", () => {
    const rows = extractRows(
      "Model version,Score,Cost per task,Tokens per task,Steps per task\nx_high,0.4,1,100,10\nx_high,0.5,2,200,20\nx_low,0.2,0.5,50,5\n",
      { file: "", score_column: "Score", cost_column: "Cost per task", tokens_column: "Tokens per task", steps_column: "Steps per task" },
    );
    assert.equal(rows.length, 2);
    const high = rows.find((r) => r.effort === "high");
    assert.equal(high?.score, 0.5);
    assert.equal(high?.cost, 2);
  });

  test("effort-level rows map per entry; model-level rows shift the AA effort gradient", () => {
    const models = [10, 20, 30, 40, 50, 60].flatMap((i) => [
      record(`m${i}-low`, i - 5, { name: `M${i} (Low)` }),
      record(`m${i}-high`, i, { name: `M${i} (High)` }),
    ]);
    const benchmarks = {
      fetched_at: "",
      source: "artificial_analysis_mirror" as const,
      source_url: "",
      intelligence_index_version: 5,
      attribution: "",
      models,
    };
    const epoch = {
      fetched_at: "",
      source_url: "",
      attribution: "",
      benchmarks: {
        cb: [10, 20, 30, 40, 50, 60].map((i) => ({ base: `m${i}`, effort: "high" as const, score: i / 100, cost: i / 10, tokens: i * 100, steps: i })),
        eci: [10, 20, 30, 40, 50, 60].map((i) => ({ base: `m${i}`, effort: null, score: 100 + (i === 30 ? 90 : i) })),
      },
    };
    const f = buildFrontier(
      [{ provider: "p", model: "m30", family: "other", option_key: "effort", allowed_efforts: ["low", "high"] }],
      benchmarks,
      3,
      epoch,
    );
    const high = f.entries.find((e) => e.effort === "high");
    const low = f.entries.find((e) => e.effort === "low");
    assert.equal(high?.metrics["epoch:cb"], 30);
    assert.equal(high?.agentic?.cost_per_task, 3);
    assert.equal(low?.metrics["epoch:cb"], undefined);
    // m30 ranks first on "eci" -> maps to the top base index (60); low keeps its -5 gradient.
    assert.equal(high?.metrics["epoch:eci"], 60);
    assert.equal(low?.metrics["epoch:eci"], 55);
  });
});

describe("agentic cost and exploration", () => {
  const withAgentic: typeof frontier = {
    ...frontier,
    agentic_reference: { tokens_per_task: 50000, steps_per_task: 50 },
    entries: frontier.entries.map((e, i) =>
      e.provider === "claudeAgent" && i % 2 === 0
        ? { ...e, agentic: { source: "test", cost_per_task: 3, tokens_per_task: 40000, steps_per_task: 40 } }
        : e,
    ),
  };

  test("measured entries use agent-run cost; profile-only entries are anchored to them", () => {
    const role = { ...(roles.roles["implement"] as NonNullable<RolesFile["roles"][string]>), use_agentic_measurements: true, agentic_task_scale: 2 };
    const anchors = agenticAnchors(withAgentic, role, roles);
    assert.ok(anchors.cost > 0 && anchors.cost !== 1);
    const measured = withAgentic.entries.find((e) => e.agentic);
    assert.ok(measured);
    assert.equal(estimateAttempt(measured, role, roles, withAgentic, anchors).token_cost_usd, 6);
    const plain = withAgentic.entries.find((e) => !e.agentic) as FrontierEntry;
    const raw = estimateAttempt(plain, role, roles, withAgentic);
    const anchored = estimateAttempt(plain, role, roles, withAgentic, anchors);
    assert.ok(Math.abs(anchored.token_cost_usd - raw.token_cost_usd * anchors.cost) < 1e-9);
  });

  const exploring = (): RolesFile => ({
    ...roles,
    defaults: { ...roles.defaults, exploration: { enabled: true, band: 0.5, temperature: 0.1, novelty_bonus: 1 } },
  });

  test("exploration stays inside the band and above the floor, preferring closer candidates", () => {
    const c: RouteContext = { frontier, roles: exploring(), overrides, quota: quota({}) };
    const req: RouteRequest = { ...base, floor: "R2", adjust_floor: false, explore: true };
    const det = selectRoute(c, { ...req, explore: false });
    assert.ok(det.best);
    const counts = new Map<string, number>();
    const rng = seededRng(7);
    for (let i = 0; i < 400; i += 1) {
      const r = selectRoute(c, { ...req, rng });
      assert.ok(r.winner && r.best);
      assert.ok(r.winner.expected_cost <= r.best.expected_cost * 1.5 + 1e-9);
      assert.ok(r.winner.quality >= r.floor_quality);
      counts.set(r.winner.entry.id, (counts.get(r.winner.entry.id) ?? 0) + 1);
    }
    const pool = selectRoute(c, { ...req, rng: seededRng(1) }).explore_pool;
    assert.ok(pool.length > 1);
    const probs = [...pool].sort((a, b) => b.probability - a.probability);
    assert.equal(probs[0]?.id, det.best.entry.id);
    assert.ok((counts.get(det.best.entry.id) ?? 0) > 400 * 0.3);
  });

  test("novelty bonus favours candidates without logged outcomes", () => {
    const c: RouteContext = { frontier, roles: exploring(), overrides, quota: quota({}) };
    const req: RouteRequest = { ...base, floor: "R2", adjust_floor: false, explore: true, rng: seededRng(1) };
    const first = selectRoute(c, req).explore_pool;
    const top = first[0];
    assert.ok(top);
    const key = `${top.id.split(":").slice(0, 2).join(":")}|implement`;
    const seen = selectRoute({ ...c, observations: new Map([[key, 1000]]) }, req).explore_pool;
    const after = seen.find((p) => p.id === top.id);
    assert.ok(after && after.probability < top.probability);
  });

  test("library default is deterministic", () => {
    const a = selectRoute(ctx(), base);
    assert.equal(a.explored, false);
    assert.equal(a.winner, a.best);
  });
});

describe("calibration", () => {
  test("MAP bias fit recovers a known shift across mixed difficulties and applied biases", () => {
    const rng = seededRng(3);
    const scale = 4;
    const trueBias = 3;
    const rows: Row[] = [];
    for (let i = 0; i < 4000; i += 1) {
      const priorLogit = -1 + 5 * rng(); // mixed floors: P from ~0.27 to ~0.98
      const applied = i % 2 === 0 ? 0 : 1.5; // half routed after an earlier calibration
      const pLogged = 1 / (1 + Math.exp(-(priorLogit + applied / scale)));
      const pTrue = 1 / (1 + Math.exp(-(priorLogit + trueBias / scale)));
      rows.push({ entry_id: "p:m:high", model_key: "p:m", role: "implement", p: pLogged, bias: applied, passed: rng() < pTrue });
    }
    const fit = fitBias(rows, scale, 4);
    assert.ok(Math.abs(fit.bias - trueBias) < 0.6, `fit ${fit.bias}`);
    assert.ok(fit.sd < 0.6);
    const small = fitBias(rows.slice(0, 10), scale, 4);
    assert.ok(Math.abs(small.bias) < Math.abs(fit.bias) + 3, "small samples are shrunk toward 0");
  });
});
