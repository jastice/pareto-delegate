# `pareto-delegate` Design

## Problem

T3 Code allows an orchestrating agent to delegate subtasks across multiple providers (e.g., Claude, Antigravity/Gemini, Cursor/Grok, Codex, etc.), each exposing multiple models and provider-specific effort knobs (`effort`, `thought_level`, `reasoning_effort`, `fastMode`, etc.).

In practice, this creates ~45+ `(provider, model, effort)` combinations where:
1. Most points are **Pareto-dominated** (e.g., a smaller model at `max` effort is often slower *and* weaker than a flagship model at `low`/`medium`).
2. Upfront complexity estimates are noisy—a "simple" fix can hide a subtle invariant bug, while a large refactor can be mechanical.
3. **Subscription quota economics** differ sharply from per-token API pricing:
   - Marginal cost on a subscription is `$0` until a rolling/weekly cap, then effectively infinite (throttled).
   - Unused quota expires (use-it-or-lose-it).
   - A weaker model on a plan with **excess quota** can be worth using *only* on tasks where it clears a hard **quality floor**—otherwise rework destroys more value than the free tokens save.

---

## Architecture

Separate stable routing policy from updatable calibration and quota state:

```text
pareto-delegate/
├── SKILL.md            # Runtime policy: classify, one route call, escalation, telemetry
├── roles.json          # Tunables: role metric weights, floors, token profiles, $/min, failure costs
├── overrides.json      # Universal safety caps (exclude, max_floor, constraints, quality_bias)
├── quota.json          # Provider pressure state (surplus / normal / scarce / throttled)
├── benchmarks.json     # Cached full AA snapshot (mirror or API)
├── frontier.json       # Pure AA-derived data per (provider, model, effort); no overrides baked in
├── routes.md           # Generated role × floor table: fallback when scripts cannot run
├── outcomes.jsonl      # Append-only telemetry (gitignored)
└── scripts/            # route.ts (CLI), sync-benchmarks.ts, calibrate.ts, model.ts
```

`*.local.json` variants of roles, overrides and quota are gitignored and merged at route time.

Cross-provider installation: keep one canonical directory (or symlink from this repo) linked into each provider's global skill directory (`~/.gemini/config/skills/`, `~/.claude/skills/`, `~/.agents/skills/`, etc.) so whichever provider runs as the parent orchestrator shares the same policy, frontier, and outcome log.

---

## Selection Model (v2)

The v1 design assigned each `(model, effort)` to exactly one rung by intelligence-index band and ranked within a rung with a hand-weighted `index − k·log(cost)` score. That made entries ineligible below their band, kept the extremes of each provider's front (dropping the knee), priced every role with AA's output-heavy eval mix, and required the agent to execute the filter by reading the frontier. v2 replaces the bands with:

1. **Role quality.** `roles.json` maps categories to roles. A role's quality is the weighted mean of the AA metrics it lists that exist in the snapshot. Each metric is first quantile-mapped onto the intelligence-index scale (equal percentile among snapshot models that report both), so mirror-only, free-tier and Pro data all yield quality in index points.
2. **Floors.** `R0`–`R3` are minimum role quality (defaults 24/40/50/57, matching the v1 band edges). Any entry above a floor is eligible for it; floors are hard and quota never lowers them. Verifiability/blast radius shift the floor (strict + single file −1, subjective +1). Per-floor TTFT caps stop max-effort thinking loops.
3. **Expected cost per attempt.**
   - Token cost: `input × (1 − cache_share) × p_in + input × cache_share × p_cache + output × verbosity × p_out`, with the role's token profile and `verbosity = (AA-suite output tokens / snapshot median)^exponent` (measured on Pro, else `task_cost / p_out`).
   - Effective cost: token cost × quota multiplier (surplus 0.1, normal 1, scarce 4) × override `cost_multiplier`.
   - Waiting: `$/min × (turns × TTFT × turn_latency_factor + output / tps)`, scaled down for `--background` tasks.
   - Failure: `(1 − P(pass)) × failure_cost[role][floor] × verifiability factor`, where `P(pass) = σ((q − floor)/s + logit(p_at_floor))`.
   The router picks the minimum; scarce providers below their reserve floor are used only when nothing else is eligible; review prefers a different family than the author.
4. **Calibration.** Outcomes log the predicted `P(pass)`. Since a quality shift of `b` moves the logit by `b/s`, `calibrate.ts` estimates per `provider:model × role` bias as `s × (logit(observed) − mean logit(predicted))`, shrinking the observed rate toward the prediction with a Beta prior. `eval:sim` injects hidden per-family biases and checks the loop recovers them.

Known limitations:
- **No exploration.** Calibration only learns about models that receive traffic. A model the router never picks keeps its AA-derived quality, however wrong.
- **Token profiles and dollar values are priors**, not measurements. `failure_cost_usd` and `value_per_minute_usd` dominate many decisions; tune them first.
- **Quantile mapping drifts slightly** as AA adds models with different metric profiles; the base index itself is identity-mapped and unaffected.
- **AA per-eval scores need the Pro tier**; free tier contributes coding/agentic indices; the mirror only the intelligence index, in which case all roles share one quality signal and differ only in cost/latency/failure parameters.

## 1. Capability Floors & Provider Normalization

*(v1 rung bands are superseded by floors on role quality; see Selection Model above. The descriptions below still define what each floor means.)*

Collapse the full provider/model/effort matrix into 4 ordered capability rungs plus cross-provider review, normalizing provider option schemas (`effort`, `thought_level`, `reasoning_effort`).

| Rung | Purpose | Typical Work |
|---|---|---|
| **R0 — Scout** | Cheap, fast context & trivial verified edits | Codebase search, log triage, file mapping, mechanical summaries, tiny edits with instant check |
| **R1 — Workhorse** | Well-specified, self-verifying implementation | Localized bug fixes with repro, unit tests, isolated UI/CRUD slices, mechanical refactors |
| **R2 — Heavy** | Non-trivial implementation & debugging | Cross-module changes, ambiguous requirements, multi-layer debugging, schema/state changes |
| **R3 — Apex / Escalation** | Hardest reasoning & recovery from failures | Escalated R1/R2 failures, concurrency/security invariants, architecture decisions |
| **Review (Cross-Provider)** | Independent correctness & edge-case verification | Non-trivial diff reviews run on **R2/R3 from a different provider family** than the author |

### Live Capability Filtering
At the start of a thread (once per thread, per T3 rules), the orchestrator calls `orchestrator_capabilities`, filters `frontier.json` to providers with `canRunChildTask: true` and currently listed models, and ignores disabled providers automatically.

### Initial Enabled Providers Snapshot (2026-11-23)
- **`claudeAgent`**: `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-fable-5-2`, `claude-opus-5-5` (`effort`: `low | medium | high | xhigh | max | ultrathink`, plus `fastMode`, `ultracode`)
- **`antigravity`**: `gemini-4-hydrogen`, `gemini-4-carbon`, `gemini-4-neon`, `gpt-oss-120b-medium`, orchestrator variants (`thought_level`: `low | medium | high | xhigh`)
- **`cursor`**: `grok-4.7` (`reasoning_effort`: `low | medium | high | xhigh`, `contextWindow`: `256k | 500k`, `fastMode`), `default`

---

## 2. Subscription Quota Economics (`quota.json`)

Instead of optimizing static token price, route using **effective marginal cost + hard quality floor**:

### Hard Quality Floor (Prevents Negative-Value Rework)
Every `(provider, model, options)` entry declares the **highest rung** (and optionally task categories) where it reliably passes without causing net-negative rework.
- Example: if Grok currently underperforms Claude/Gemini on complex edits, its cap might be `max_rung: R0` (plus narrow verifiable `R1` categories like log triage, boilerplate, or extra-eyes review), regardless of how much excess quota is available.
- **Rule:** Never route a task to a model whose calibrated capability is below the task's required rung, even at `surplus` quota.

### Quota Pressure States
Each provider instance has a simple pressure state in `quota.json` (updated manually, via external quota scripts if available, or transiently in-session when a rate limit is hit):

| State | Meaning | Routing Effect |
|---|---|---|
| `surplus` | Excess/expiring subscription capacity | Prefer this provider among candidates **that meet the task's quality floor** (and optionally use for low-risk offload / parallel speculative checks). |
| `normal` | Healthy headroom | Standard Pareto preference (quality-per-latency + provider strengths). |
| `scarce` | Approaching rolling/weekly cap | Reserve for **R2/R3** or tasks where no alternative meets the quality floor; shift R0/R1 elsewhere. |
| `throttled` | Rate-limited / exhausted | Exclude for remainder of session/window; fall back to next frontier candidate. |

### Surplus-Soak Patterns (Getting Value from Weaker Plans Safely)
When a weaker provider is in `surplus`, route only work where bad output has ~0 blast radius:
1. **Read-only scouting (`research`):** Searching large codebases, summarizing git history, extracting API signatures, triaging CI logs.
2. **Strictly test-gated tasks:** Writing or expanding tests / mechanical transforms where an automated compiler/test suite acts as an immediate pass/fail filter.
3. **Free extra-eyes / speculative draft:** Running a parallel second opinion or draft alongside a stronger agent when waiting anyway (discard cheaply if low signal).

---

## 3. Initial Complexity Estimation Rubric (`SKILL.md`)

Before calling `delegate_task`, the delegator estimates the starting rung using three concrete axes:

1. **Verifiability**
   - Strong automated gate (unit test, repro script, strict typecheck): favors lower rung (`-1`).
   - Weak/subjective verification (concurrency, UX judgment, security, architecture): requires higher rung (`+1`).
2. **Blast Radius / Coupling**
   - Single file or pure helper: `R0`–`R1`.
   - Multi-file / shared contracts / stateful flows: `R2`–`R3`.
3. **Ambiguity / Diagnosis Depth**
   - Clear spec + exact files known: `R0`–`R1`.
   - Unknown root cause or open design tradeoffs: `R2`–`R3`.

Every delegated brief **must** include an explicit acceptance gate (exact verification command or concrete checklist) so failure is objective.

---

## 4. Escalation Protocol

Aligned with T3 Code's delegation rules (no polling loops; fresh `delegate_task` on escalation rather than iterating repeatedly on a struggling child):

1. **Verification Failure Trigger**
   - Child fails its verification command, returns an incomplete/hedged result, or edits out of scope.
   - **Action:** Do not run multi-turn retries on the same rung. Spawn a fresh `delegate_task` at `rung + 1` (or jump straight to `R3` if the spec was already unambiguous), passing the original goal, relevant diff/state, and exact failure output.
2. **Poor Review Trigger**
   - Cross-provider review identifies substantive correctness, edge-case, or design flaws (trivial nitpicks are patched directly by the parent).
   - **Action:** Escalate rework to `implementer_rung + 1` with the review findings verbatim.
3. **Time / Complexity Overrun Trigger**
   - For **R0** tasks expected to return quickly, optionally use `mode: "wait"` with a tight `timeoutMs` (up to 45s) — timeout signals misestimated complexity.
   - For async **R1/R2** tasks, enforce a **1-shot rule per rung**: if the returned work requires substantial follow-up, escalate immediately instead of issuing a second round at the same rung. Log wall-clock overruns in `outcomes.jsonl` to recalibrate future estimates.
   - If a child is superseded or clearly runaway, stop it with `task_cancel`.

---

## 5. Calibration & Feedback Loop

1. **Outcome Ledger (`outcomes.jsonl`)**
   Record a compact line per delegated task:
   ```json
   {"ts":"2026-11-23T23:45:00Z","task_type":"bugfix","estimated_rung":"R1","provider":"claudeAgent","model":"claude-sonnet-5-5","options":{"effort":"medium"},"quota_state":"normal","passed_first_try":true,"review_passed":true,"escalated_to":null,"duration_s":48}
   ```
2. **Periodic Recalibration**
   - Compute first-pass success rate, escalation rate, and median duration per `(model, effort, task_type)`.
   - Prune empirically dominated `(model, effort)` pairs from `frontier.json`.
   - Promote/demote model `max_rung` caps as models improve or regress.
3. **Optional Canary Suite**
   - Maintain 5–6 small, self-verifying benchmark tasks (1 scout, 1 localized fix, 1 multi-file refactor, 1 tricky bug, 1 seeded-bug review) to quickly calibrate newly added models or effort levels before trusting them in live work.
