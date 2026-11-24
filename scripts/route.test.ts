import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { selectRoute } from "./route.ts";
import type { FrontierFile, QuotaFile } from "./types.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontier = JSON.parse(
  readFileSync(resolve(ROOT, "frontier.json"), "utf8"),
) as FrontierFile;

const BASE_QUOTA: QuotaFile = {
  schema_version: 1,
  updated_at: "2026-11-24T00:00:00Z",
  providers: {
    cursor: { state: "surplus", resets_at: null },
    claudeAgent: { state: "normal", resets_at: null },
    antigravity: { state: "normal", resets_at: null },
  },
};

describe("pareto-delegate routing policy", () => {
  test("surplus cursor wins R0 scouting", () => {
    const decision = selectRoute(frontier, BASE_QUOTA, {
      required_rung: "R0",
      category: "research",
      verifiability: "moderate",
      blast_radius: "single_file",
    });
    assert.ok(decision);
    assert.equal(decision.entry.provider, "cursor");
    assert.equal(decision.quota_state, "surplus");
  });

  test("surplus cursor wins strictly verified R1 test_gen", () => {
    const decision = selectRoute(frontier, BASE_QUOTA, {
      required_rung: "R1",
      category: "test_gen",
      verifiability: "strict",
      blast_radius: "isolated_module",
    });
    assert.ok(decision);
    assert.equal(decision.entry.provider, "cursor");
    assert.equal(decision.effective_rung, "R1");
  });

  test("hard quality floor blocks surplus cursor on R1 ambiguous bugfix", () => {
    const decision = selectRoute(frontier, BASE_QUOTA, {
      required_rung: "R1",
      category: "bugfix",
      verifiability: "moderate",
      blast_radius: "isolated_module",
    });
    assert.ok(decision);
    assert.notEqual(decision.entry.provider, "cursor");
    assert.equal(decision.entry.model, "gemini-4-neon");
  });

  test("hard quality floor blocks surplus cursor on R2 and R3", () => {
    for (const rung of ["R2", "R3"] as const) {
      const decision = selectRoute(frontier, BASE_QUOTA, {
        required_rung: rung,
        category: "feature_slice",
        verifiability: "strict",
        blast_radius: "multi_module",
      });
      assert.ok(decision);
      assert.notEqual(decision.entry.provider, "cursor");
    }
  });

  test("scarce provider is preserved for R2/R3 when normal provider exists for R1", () => {
    const scarceAntigravity: QuotaFile = {
      ...BASE_QUOTA,
      providers: {
        cursor: { state: "normal" },
        antigravity: { state: "scarce", reserve_for_min_rung: "R2" },
        claudeAgent: { state: "normal" },
      },
    };
    const r1 = selectRoute(frontier, scarceAntigravity, {
      required_rung: "R1",
      category: "bugfix",
      verifiability: "strict",
      blast_radius: "single_file",
    });
    assert.equal(r1?.entry.provider, "claudeAgent");
  });

  test("throttled provider skips before resets_at and recovers after resets_at", () => {
    const throttledQuota: QuotaFile = {
      ...BASE_QUOTA,
      providers: {
        cursor: { state: "throttled", resets_at: "2026-11-25T00:00:00Z" },
        antigravity: { state: "normal" },
        claudeAgent: { state: "normal" },
      },
    };
    const before = selectRoute(frontier, throttledQuota, {
      required_rung: "R0",
      category: "research",
      verifiability: "moderate",
      blast_radius: "single_file",
      now: new Date("2026-11-24T12:00:00Z"),
    });
    assert.notEqual(before?.entry.provider, "cursor");

    const after = selectRoute(frontier, throttledQuota, {
      required_rung: "R0",
      category: "research",
      verifiability: "moderate",
      blast_radius: "single_file",
      now: new Date("2026-11-25T01:00:00Z"),
    });
    assert.ok(after);
  });

  test("primary_review enforces cross-provider family separation", () => {
    const reviewOfGemini = selectRoute(frontier, BASE_QUOTA, {
      required_rung: "R2",
      category: "primary_review",
      verifiability: "subjective",
      blast_radius: "multi_module",
      author_family: "gemini",
    });
    assert.equal(reviewOfGemini?.entry.family, "claude");

    const reviewOfClaude = selectRoute(frontier, BASE_QUOTA, {
      required_rung: "R2",
      category: "primary_review",
      verifiability: "subjective",
      blast_radius: "multi_module",
      author_family: "claude",
    });
    assert.equal(reviewOfClaude?.entry.family, "gemini");
  });

  test("single-provider Antigravity covers R0-R3 and falls back on primary_review", () => {
    const live = { antigravity: ["gemini-4-hydrogen", "gemini-4-neon"] };
    const normalQuota: QuotaFile = {
      schema_version: 1,
      updated_at: "2026-11-24T00:00:00Z",
      providers: { antigravity: { state: "normal", resets_at: null } },
    };

    const r0 = selectRoute(frontier, normalQuota, {
      required_rung: "R0",
      category: "research",
      verifiability: "moderate",
      blast_radius: "single_file",
      live_models: live,
    });
    assert.equal(r0?.entry.model, "gemini-4-hydrogen");

    const r1 = selectRoute(frontier, normalQuota, {
      required_rung: "R1",
      category: "bugfix",
      verifiability: "strict",
      blast_radius: "isolated_module",
      live_models: live,
    });
    assert.equal(r1?.entry.model, "gemini-4-neon");
    assert.equal(r1?.entry.options.thought_level, "low");

    const review = selectRoute(frontier, normalQuota, {
      required_rung: "R2",
      category: "primary_review",
      verifiability: "subjective",
      blast_radius: "multi_module",
      author_family: "gemini",
      live_models: live,
    });
    assert.equal(review?.entry.provider, "antigravity");
    assert.equal(review?.effective_rung, "R2");

    const r3 = selectRoute(frontier, normalQuota, {
      required_rung: "R3",
      category: "architecture",
      verifiability: "subjective",
      blast_radius: "multi_module",
      live_models: live,
    });
    assert.equal(r3?.entry.model, "gemini-4-neon");
    assert.equal(r3?.effective_rung, "R3");
  });

  test("single-provider Claude respects per-model quota overrides across R0-R3", () => {
    const live = {
      claudeAgent: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
    };
    const scarceOpusQuota: QuotaFile = {
      schema_version: 1,
      updated_at: "2026-11-24T00:00:00Z",
      providers: {
        claudeAgent: {
          state: "normal",
          resets_at: null,
          model_overrides: {
            "claude-opus-5-5": {
              state: "scarce",
              reserve_for_min_rung: "R2",
            },
          },
        },
      },
    };

    const r0 = selectRoute(frontier, scarceOpusQuota, {
      required_rung: "R0",
      category: "research",
      verifiability: "moderate",
      blast_radius: "single_file",
      live_models: live,
    });
    assert.equal(r0?.entry.model, "claude-haiku-5-5");

    const r1 = selectRoute(frontier, scarceOpusQuota, {
      required_rung: "R1",
      category: "bugfix",
      verifiability: "strict",
      blast_radius: "isolated_module",
      live_models: live,
    });
    assert.equal(r1?.entry.model, "claude-sonnet-5-5");

    const r2 = selectRoute(frontier, scarceOpusQuota, {
      required_rung: "R2",
      category: "feature_slice",
      verifiability: "moderate",
      blast_radius: "multi_module",
      live_models: live,
    });
    assert.equal(r2?.entry.model, "claude-opus-5-5");
    assert.equal(r2?.quota_state, "scarce");
  });
});
