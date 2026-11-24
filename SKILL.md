---
name: pareto-delegate
description: >-
  Quota-aware, Pareto-frontier delegation policy for T3 Code and standalone
  coding harnesses (Claude Code, Antigravity, Codex, Cursor). Activate whenever
  delegating subtasks via T3's `delegate_task` OR a harness's native subagent
  tool (`Agent`, `invoke_subagent`, `spawn_agent`). Routes across providers (in
  T3) or across a single provider's models and effort levels (standalone or
  single-provider T3) using calibrated Artificial Analysis benchmarks, hard
  quality floors, quota pressure, cross-provider review when available, and
  1-shot escalation.
---

# `pareto-delegate`

Route delegated subtasks onto the calibrated `(provider, model, options)` Pareto frontier while respecting quota pressure and hard quality floors. Works both **across providers in T3 Code** and **within a single provider** (either T3 Code with one provider enabled, or standalone CLI/IDE harnesses via native subagent tools).

Let `<skill-dir>` denote the directory containing this `SKILL.md` file. All scripts and data files resolve relative to `<skill-dir>`, so the skill works unchanged regardless of where it is installed or which workspace repo is active.

## Files in `<skill-dir>`

- `<skill-dir>/frontier.json` — Calibrated Pareto entries (`R0`–`R3`), option schemas, TTFT guardrails, and tracked/unmatched models.
- `<skill-dir>/benchmarks.json` — Cached full Artificial Analysis v5 snapshot (130+ models) for instant offline matching when models change.
- `<skill-dir>/quota.local.json` (optional, gitignored) or `<skill-dir>/quota.json` (tracked default: all `"normal"`) — Current subscription quota pressure (`surplus` | `normal` | `scarce` | `throttled`). **Always prefer `quota.local.json` if it exists.**
- `<skill-dir>/overrides.json` (tracked universal safety floors) + `<skill-dir>/overrides.local.json` (optional, gitignored account/machine overrides such as excluding extra-credit models) — Merged automatically by `sync-benchmarks.ts`.
- `<skill-dir>/outcomes.jsonl` (gitignored) — Append-only local delegation telemetry for empirical recalibration.
- `<skill-dir>/scripts/sync-benchmarks.ts` — Strictly typed, zero-dependency TypeScript sync helper (runs via `bun run` or `node`).
- `<skill-dir>/scripts/route.ts` — Pure TypeScript reference implementation of the 4-step selection policy.

---

## Zero-Eval Setup on a New Machine

No benchmarks or evals need to be run when installing this skill elsewhere:

1. **Works out of the box (pure API-cost mode):** With default `quota.json` (all providers `"normal"`), the skill routes strictly onto the global cost-vs-intelligence Pareto frontier and avoids slow/high-API-cost models like Grok 4.7 unless marked `surplus`.
2. **Automatic model calibration:** On first delegation on a new machine, Step 0 compares live `orchestrator_capabilities` against `frontier.json` and auto-matches any new models against cached `benchmarks.json` (fetching a fresh zero-key AA snapshot only if missing).
3. **Optional subscription tuning (`quota.local.json`):** Copy `quota.json` → `quota.local.json` and set:
   - `"surplus"` on plans with unused/expiring weekly headroom,
   - `"scarce"` (with optional `"reserve_for_min_rung": "R2"` or `"R3"`) on plans nearing weekly caps,
   - `"throttled"` (with optional `"resets_at"` ISO timestamp) on exhausted plans.
4. **Optional account/plan exclusions (`overrides.local.json`):** Exclude models not included in a local subscription (e.g., models requiring extra usage credits), then recompute locally with zero network calls:
   ```bash
   bun run <skill-dir>/scripts/sync-benchmarks.ts --offline
   ```
   If not configured upfront, Step 3.4 catches credit/rate-limit failures at runtime and falls back automatically.

---

## Runtime Adapter (T3 Code vs. Standalone Single-Provider)

Detect which delegation surface is available in this session:

- **T3 Code mode** (`orchestrator_capabilities` and `delegate_task` are available):
  - Discover live providers and models via `orchestrator_capabilities`.
  - Dispatch with `delegate_task` passing exact `target: { providerInstanceId, model, options }`.
  - Cancel runaway/superseded children with `task_cancel`.
  - Works identically whether multiple providers or only a single provider is enabled.
- **Standalone mode** (no T3 MCP tools; native subagent tool available):
  - Scope `frontier.json` to your own provider (`claudeAgent` | `antigravity` | `codex` | `cursor`) and the models your harness can spawn.
  - Skip `orchestrator_capabilities` and dispatch with your native subagent tool, mapping the selected `(model, options)` to the closest supported parameters:
    - **Claude Code (`Agent`)**: pass `model` (e.g., `haiku`, `sonnet`, `opus`, or full model ID) and `effort` if supported; if per-call effort isn't exposed, pick the model matching the target rung (`R0` → Haiku/fast, `R1` → Sonnet or Opus-medium, `R2`/`R3` → Opus/Fable).
    - **Antigravity (`invoke_subagent`)**: map the chosen rung onto the native `Model` tier (`R0` → `flash_lite` or `flash`, `R1` → `flash` or `inherit`, `R2`/`R3` → `pro` or `inherit` when already on a flagship model).
    - **Codex (`spawn_agent`)**: pass `model` and `reasoning_effort` directly.
    - **Other harnesses**: pass the closest supported model/effort parameter. If the harness has no subagent tool at all, do not use this skill.

---

## Step 0: Live Capability Intersection & Sync Check (Once Per Thread)

1. Read `<skill-dir>/frontier.json` and `<skill-dir>/quota.local.json` (falling back to `<skill-dir>/quota.json`).
2. **Discover live models:**
   - **T3 Code mode:** Call `orchestrator_capabilities` once per thread before the first `delegate_task`, keeping only providers with `canRunChildTask: true`.
   - **Standalone mode:** Filter `frontier.json` to your current provider and the models/tiers available in your harness.
3. **Sync only when out of sync:** Check whether any enabled live model ID (ignoring meta aliases like `default`, `auto`, or `*orchestrator*`) is in **neither** `frontier.json`'s `tracked_models` **nor** `unmatched_models`.
   - If all enabled models are already accounted for: **do not fetch anything** — proceed directly to Step 1.
   - If new enabled models appeared: run the sync helper from any working directory, passing the new `provider:model` pairs (matches offline against cached `benchmarks.json` first; fetches a fresh full AA snapshot automatically only if a model is missing from cache):
     ```bash
     bun run <skill-dir>/scripts/sync-benchmarks.ts --models <provider1:model1,provider2:model2>
     ```
     *(Fallback if `bun` is unavailable: `node <skill-dir>/scripts/sync-benchmarks.ts --models ...`.)*
   - Re-read `<skill-dir>/frontier.json` after syncing.
4. Intersect `frontier.json` entries to keep only entries whose `provider` and `model` are live in this session.

---

## Step 1: Classify the Subtask & Define an Acceptance Gate

Before calling `delegate_task`, assign:
- **`category`**: `research` | `log_triage` | `doc_summary` | `test_gen` | `mechanical_refactor` | `bugfix` | `feature_slice` | `architecture` | `debugging` | `primary_review` | `second_opinion_review`
- **`verifiability`**:
  - `strict`: objective pass/fail command (unit tests, repro script, strict typecheck/lint).
  - `moderate`: partial automated checks + small manual inspection.
  - `subjective`: design, concurrency/security invariants, UX judgment, ambiguous specs.
- **`blast_radius`**: `single_file` | `isolated_module` | `multi_module`
- **`required_rung`**:
  - **R0 (Scout):** Read-only search, log triage, file/symbol mapping, summaries, or tiny verified edits.
  - **R1 (Workhorse):** Clear spec, isolated blast radius, `strict` or `moderate` verification (localized bugfix with repro, unit tests, small CRUD/UI slice, mechanical refactor).
  - **R2 (Heavy):** Multi-file/shared-contract changes, ambiguous root cause, stateful debugging, schema/API changes, or primary diff review.
  - **R3 (Apex / Escalation):** Escalated R1/R2 failures, concurrency/security invariants, subtle architecture tradeoffs, or high-stakes final review.

Adjust starting rung by verifiability:
- `strict` automated gate + `single_file` → bias down (`-1`, floor `R0`).
- `subjective` verification or unknown root cause → bias up (`+1`, ceiling `R3`).

**Mandatory Brief Rule:** Every delegated `task` prompt must state an explicit **acceptance gate** (exact verification command or concrete review checklist) so pass/fail is objective.

---

## Step 2: Select `(provider, model, options)`

Run this deterministic 4-step filter:

1. **Hard Quality Floor Gate (Non-Negotiable):**
   Keep only live entries where:
   - Effective quota state is not `throttled` (if `resets_at` is in the past, treat `throttled` as `normal`; if a provider or model hit a rate-limit or extra-credits error earlier in this session, treat it as `throttled`).
   - `required_rung` is in `entry.rungs` and `required_rung <= entry.max_rung`.
   - Any `entry.rung_constraints[required_rung]` is satisfied (`verifiability` at least `min_verifiability`, `category` in `allowed_categories`, `blast_radius` within `max_blast_radius`).
   - *Never* drop below the hard quality floor to soak surplus quota. If no entry passes at `required_rung`, bump to `required_rung + 1` and re-run Step 1.

2. **Quota Pressure Buckets:**
   Resolve each candidate's quota entry from `providers[provider].model_overrides[model]` if present, else `providers[provider]`. Partition eligible candidates into buckets in priority order:
   1. **`surplus`** — Use expiring subscription capacity first (safe because Step 1 enforced the quality floor).
   2. **`normal`** — Standard Pareto pool (also acts as pure API-cost mode when all providers are `normal`).
   3. **`scarce`** — Eligible only if `required_rung >= (reserve_for_min_rung ?? "R2")` **or** buckets 1–2 are empty.

3. **Pareto Tie-Break & Cross-Provider Review:**
   - For `primary_review`, exclude entries matching the implementer's `family` (`claude` | `gemini` | `grok` | `openai`) whenever another family is eligible. In single-provider mode (no other family available), fall back cleanly to a fresh subagent on the same provider at the review rung (`R2`/`R3`).
   - Pick the lowest `rung_ranks[required_rung]` in the highest non-empty bucket.

4. **Surplus-Soak Offload (Zero-Blast-Radius Sidecars):**
   When an `R2`/`R3` task runs and a weaker provider (`max_rung <= R1`) is in `surplus`, do **not** downgrade the main task. Instead, optionally offload zero-blast-radius sub-work to it:
   - **Pre-flight `R0` scouting** (`research` / log triage / symbol map) so the `R2`/`R3` delegate starts with compact context.
   - **Async/background strictly test-gated leaf slices** (`verifiability: "strict"`, isolated files) where tests immediately reject bad output and higher wall-clock latency is acceptable.
   - **Parallel `second_opinion_review`** alongside the primary cross-provider review when wall-clock time is free.

---

## Step 3: Escalation Protocol (1-Shot Rule)

Spawn a **fresh** delegate (`delegate_task` in T3 Code, or a new native subagent in standalone mode) on escalation instead of steering a struggling child:

1. **Verification Failure:** If the child fails its acceptance gate, hedges, or edits out of scope, spawn a **fresh** delegate at `rung + 1` (or jump straight to `R3` if the spec was already unambiguous). Pass the goal, relevant diff/state, and exact failure output.
2. **Poor Review:** Patch tiny nitpicks yourself. For substantive correctness, edge-case, or design findings, escalate rework to `implementer_rung + 1` with the review findings verbatim.
3. **Time / Scope Overrun:**
   - For quick `R0` tasks in T3 Code, `mode: "wait"` with a tight `timeoutMs` (up to `45000`) catches misestimated complexity early.
   - For async `R1`/`R2` tasks, enforce a **1-shot rule per rung**: escalate on substantial rework rather than iterating at the same rung. Stop runaway or superseded delegates (`task_cancel` in T3 Code, or your harness's cancel/kill tool).
4. **Rate-Limit & Extra-Credits Reaction:**
   - If a delegate fails due to a provider rate limit, mark that provider `throttled` for the rest of the session and re-route to the next eligible candidate.
   - If a specific model fails because it requires extra usage credits or is unavailable on the user's plan, mark that model unavailable for the rest of the session, re-route to the next eligible candidate, and optionally suggest adding `{ "model_overrides": { "<provider>:<model>": { "exclude": true } } }` to `<skill-dir>/overrides.local.json` followed by `bun run <skill-dir>/scripts/sync-benchmarks.ts --offline`.

---

## Step 4: Telemetry (`outcomes.jsonl`)

After a delegated task completes, append one compact JSON line to `<skill-dir>/outcomes.jsonl` (using `startedAt`/`completedAt` from `t3_thread_read` in T3 Code, or elapsed wall time in standalone mode, for `duration_s`):

```json
{"ts":"2026-11-24T00:35:00Z","task_type":"bugfix","estimated_rung":"R1","verifiability":"strict","provider":"antigravity","model":"gemini-4-neon","options":{"thought_level":"low"},"quota_state":"normal","passed_first_try":true,"review_passed":true,"escalated_to":null,"duration_s":52}
```
