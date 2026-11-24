---
name: pareto-delegate
description: >-
  Expected-cost-optimal delegation policy for T3 Code and standalone coding harnesses (Claude
  Code, Antigravity, Codex, Cursor). Activate whenever delegating subtasks via T3's
  `delegate_task` OR a harness's native subagent tool (`Agent`, `invoke_subagent`,
  `spawn_agent`). One CLI call picks (provider, model, effort) per task role and capability floor
  from Artificial Analysis data, quota pressure and tunable cost/failure parameters, with
  cross-family review and 1-shot escalation.
---

# `pareto-delegate`

Pick who does a delegated subtask by **role** (scout, implement, debug, design, review) and **capability floor** (R0–R3), minimizing expected cost = token cost × quota pressure + waiting time + P(fail) × failure cost. Never route below the floor to save quota.

`<skill-dir>` is the directory containing this file. Run scripts with `bun run <skill-dir>/scripts/<name>.ts` (fallback: `node --experimental-strip-types <skill-dir>/scripts/<name>.ts`). **Do not read `frontier.json` or `benchmarks.json`**; the router reads them.

## Step 0: Once per thread

- **T3 Code:** call `orchestrator_capabilities` once; keep providers with `canRunChildTask: true`. Build `--live provider:model,...` from them for every route call. If you see model IDs you have not checked this thread, run `bun run <skill-dir>/scripts/sync-benchmarks.ts --check-models <ids>`; on exit 2 run `... sync-benchmarks.ts --models <provider:model,...>`. If sync cannot write (sandbox), continue: unknown models just aren't routable.
- **Standalone:** use `--provider claudeAgent` (Claude Code), `--provider codex`, or `--provider antigravity` / `cursor` in every route call. No sync check needed.

## Step 1: Classify and write the acceptance gate

- `--category`: `research` | `log_triage` | `doc_summary` (→ scout) · `test_gen` | `mechanical_refactor` | `bugfix` | `feature_slice` (→ implement) · `debugging` (→ debug) · `architecture` (→ design) · `primary_review` | `second_opinion_review` (→ review).
- `--floor`:
  - **R0** read-only search, triage, summaries, tiny verified edits.
  - **R1** clear spec, isolated blast radius, automated or partial checks.
  - **R2** multi-file / shared-contract changes, ambiguous root cause, stateful debugging, primary diff review.
  - **R3** escalations, concurrency/security invariants, subtle architecture tradeoffs, high-stakes review.
- `--verify strict|moderate|subjective` and `--blast single_file|isolated_module|multi_module`. Pass them honestly; the router itself shifts the floor (strict + single file −1, subjective +1).
- **Every delegated brief states an explicit acceptance gate** (exact command or concrete checklist).

## Step 2: Route (one call)

```bash
bun run <skill-dir>/scripts/route.ts --category bugfix --floor R1 --verify strict --blast isolated_module \
  [--live ...|--provider ...] [--author-family claude] [--throttled p|p:m,...] [--background]
```

Output (JSON): `target` `{providerInstanceId, model, options}` for `delegate_task`; `harness` hints for standalone tools (e.g. `claude_code_agent: {model: "opus", effort: "medium"}` → `Agent` `model` + `effort`; `codex_spawn_agent` → `model` + `reasoning_effort`); `est`; `fallbacks`; `outcome_template`.

- Antigravity `invoke_subagent` has no exact model parameter: map the target to the nearest native tier by price class (cheap/fast models such as `*-hydrogen` → `flash`; flagship-class such as `*-neon`/`*-carbon` → `pro`; `inherit` when the target is the current model).
- `target: null` (exit 3): nothing live clears the floor. Do the task in this thread or ask the user. Never pick something below the floor.
- `--author-family <family of the implementer>` for `primary_review`: the router prefers another family when one is eligible.
- `--background` for async sidecars nobody waits on (strictly test-gated leaf slices, parallel `second_opinion_review`, pre-flight R0 scouting): latency then costs ~nothing, which is how surplus quota on slower models gets used safely.
- No `bun`/`node` available: use the table in `<skill-dir>/routes.md` (same model, default quota, no session state).

## Step 3: Escalation (1-shot rule)

- **Gate failed, hedged, or out of scope:** spawn a **fresh** delegate from `route.ts --floor <floor+1> --exclude <failed entry id>` (jump to R3 if the spec was already unambiguous). Pass goal, diff/state and exact failure output. Do not iterate at the same floor.
- **Review found substantive issues:** rework at implementer floor + 1 with the findings verbatim; patch nitpicks yourself.
- **Overrun:** in T3, R0 tasks may use `mode: "wait"` with `timeoutMs` ≤ 45000; stop runaway/superseded children (`task_cancel` or the harness's cancel).
- **Rate limit:** add the provider to `--throttled` for the rest of the session and use `fallbacks` or re-route. **Plan/extra-credit error:** add `provider:model` to `--throttled`, and suggest `{"overrides": {"<provider>:<model>": {"exclude": true}}}` in `<skill-dir>/overrides.local.json`.

## Step 4: Telemetry

After each delegated attempt, append the `outcome_template` as one JSON line to `<skill-dir>/outcomes.jsonl` with `ts`, `passed_first_try`, `duration_s` (from `t3_thread_read` timestamps in T3, wall time otherwise) and `escalated_to` filled in. `p_pass_est` must stay as emitted: `scripts/calibrate.ts` compares it with what happened.

## Tuning (for the user, not per task)

- `roles.json` / `roles.local.json`: per-role metric weights, floors, token profiles, $/minute, failure costs, quota multipliers. Local file deep-merges over the tracked one.
- `overrides.json` / `overrides.local.json`: `exclude`, `max_floor`, `floor_constraints`, `quality_bias`, `cost_multiplier` per `provider:*`, `provider:model` or `provider:model:effort`. Applied at route time; no resync.
- `quota.local.json`: `surplus` / `normal` / `scarce` (+ `reserve_for_min_rung`) / `throttled` (+ `resets_at`).
- `bun run <skill-dir>/scripts/calibrate.ts`: learned `quality_bias` suggestions from `outcomes.jsonl`.
- `ARTIFICIAL_ANALYSIS_API_KEY` (free tier) + `sync-benchmarks.ts --refresh`: adds AA coding/agentic indices and cache-hit prices to role quality and cost.
