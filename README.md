# pareto-delegate

A relocatable skill for routing delegated agent tasks across providers, models and reasoning effort levels. Works in **T3 Code** (multi- or single-provider via `delegate_task`) and in **standalone harnesses** (Claude Code `Agent`, Antigravity `invoke_subagent`, Codex `spawn_agent`).

## How it works

- **One call per delegation.** `scripts/route.ts` takes a task's category, capability floor (R0–R3), verifiability and blast radius and prints the chosen `(provider, model, options)`, harness hints, fallbacks and a telemetry template. The agent never reads the data files.
- **Roles, not one index.** Categories map to roles (scout, implement, debug, design, review). Each role has its own quality composite, cost basis, latency value and failure cost ([roles.json](./roles.json)).
- **Comparable quality scale.** Every metric (AA indices, Epoch's CursorBench, APEX-Agents, SciCode, FrontierCode, ECI, …) is quantile-mapped onto the AA intelligence-index scale, so floors stay in familiar index points whichever metrics exist for an entry. Model-level metrics (no effort reported) shift a model's AA effort curve instead of flattening it.
- **Measured agent cost.** For agentic roles, cost and time come from CursorBench runs (cost, tokens and steps per task for each model × effort, via Epoch) scaled by the role's `agentic_task_scale`. Entries without measurements are priced from the role's token profile and AA prices, anchored to the measured ones by the median ratio.
- **Expected cost, not a weighted score.** Among live candidates that clear the floor:
  `E = $cost × quota multiplier × cost_multiplier + $/min × wait + (1 − P(pass)) × failure cost`, with `P(pass)` logistic in quality − floor.
- **Exploration jitter.** The CLI samples among candidates within `band` of the best expected cost, with weight `exp(−ΔE / (temperature·E_best)) × (1 + novelty_bonus / (1 + n))`: near-ties and rarely observed models are tried more often. Never below the floor; `--no-explore` disables it.
- **Runtime-applied tunables.** Overrides ([overrides.json](./overrides.json) + `overrides.local.json`), quota ([quota.json](./quota.json) / `quota.local.json`) and roles (`roles.local.json`) apply at route time; no resync needed.
- **Learning loop.** `outcomes.jsonl` records predicted P(pass) and the bias applied; [scripts/calibrate.ts](./scripts/calibrate.ts) fits absolute per-model×role `quality_bias` by penalized maximum likelihood.

## Data sources

| Source | Needs | Adds | Stored in |
|---|---|---|---|
| AA daily mirror | nothing | Intelligence index, prices, task cost, speed, TTFT | `benchmarks.json`, `frontier.json` (tracked) |
| AA API, free tier | free key in `aa-api-key.local` or `ARTIFICIAL_ANALYSIS_API_KEY` | Fresher prices/latency, cache-hit prices, AA domain indices | `benchmarks.local.json` |
| [Epoch AI hub](https://epoch.ai/benchmarks) | nothing | CursorBench (agentic coding + measured cost/tokens/steps per effort), APEX-Agents, SciCode, FrontierCode, ECI | `epoch.local.json` |

When API or Epoch data is present, sync writes `frontier.local.json` and `routes.local.md`, which the router prefers. These stay out of git: AA's redistribution terms for API data are unclear, and Epoch's external benchmarks keep their original licences. The AA Pro tier is not used. As of this writing the free endpoint returns the intelligence index and domain indices, but not the coding or agentic indices its docs show; role weights for those simply have no effect until they appear.

## Usage (any working directory)

Runs with `bun` or `node --experimental-strip-types` (Node 22.6+; Node 23.6+ needs no flag).

```bash
# Route a task
bun run <skill-dir>/scripts/route.ts --category bugfix --floor R1 --verify strict --blast isolated_module
bun run <skill-dir>/scripts/route.ts --category research --floor R0 --provider claudeAgent      # standalone Claude Code
bun run <skill-dir>/scripts/route.ts --category primary_review --floor R2 --author-family gemini --explain

# Refresh AA (free API if a key is configured, else mirror) and Epoch data, regenerate the frontier
echo "<your free AA key>" > <skill-dir>/aa-api-key.local     # optional, gitignored
bun run <skill-dir>/scripts/sync-benchmarks.ts --refresh
bun run <skill-dir>/scripts/sync-benchmarks.ts --offline --no-epoch --source=mirror   # rebuild tracked mirror frontier

# Add newly enabled models (offline-first; fetches if not in the cached snapshot)
bun run <skill-dir>/scripts/sync-benchmarks.ts --models codex:gpt-6.2-astra,cursor:grok-4.7
bun run <skill-dir>/scripts/sync-benchmarks.ts --capabilities capabilities.json

# Check live model IDs (no network; exits 2 if any are unknown)
bun run <skill-dir>/scripts/sync-benchmarks.ts --check-models claude-opus-5-5,gemini-4-neon

# Regenerate the no-CLI fallback table after editing tunables
bun run <skill-dir>/scripts/route.ts --table --write

# Deterministic pick / reproducible exploration
bun run <skill-dir>/scripts/route.ts --category bugfix --floor R1 --no-explore
bun run <skill-dir>/scripts/route.ts --category bugfix --floor R1 --seed 42 --explain

# Calibration report from outcomes.jsonl
bun run <skill-dir>/scripts/calibrate.ts
```

## Tuning on a new machine (no evals required)

1. **Nothing**: defaults route on API list prices with all providers `normal`.
2. **Subscription headroom**: copy [quota.json](./quota.json) to `quota.local.json` and set `surplus` / `scarce` (+ `reserve_for_min_rung`) / `throttled` (+ `resets_at`). Multipliers live in `roles.json` → `quota_cost_multipliers`.
3. **Plan exclusions / trust adjustments**: `overrides.local.json`, e.g.
   ```json
   {
     "schema_version": 2,
     "overrides": {
       "claudeAgent:claude-fable-5-2": { "exclude": true },
       "claudeAgent:*": { "quality_bias": { "implement": 3, "debug": 3 } }
     }
   }
   ```
4. **Workload shape**: `roles.local.json` to change token profiles, $/minute, failure costs, floors or metric weights for a role.

Parameters worth revisiting first, in order of leverage: `failure_cost_usd` per role, `value_per_minute_usd`, `agentic_task_scale` (how big your tasks are relative to a CursorBench task), `quota_cost_multipliers`, then `quality_bias` once `calibrate.ts` has data.

## Installation

- **Antigravity (T3 Code or standalone):**
  ```bash
  mkdir -p ~/.t3/userdata/providers/antigravity/<profile-hash>/config/skills
  ln -s /path/to/pareto-delegate ~/.t3/userdata/providers/antigravity/<profile-hash>/config/skills/pareto-delegate
  ln -s /path/to/pareto-delegate ~/.gemini/config/skills/pareto-delegate   # standalone
  ```
- **Claude / Cursor / Codex:** symlink into `~/.claude/skills/pareto-delegate`, `~/.cursor/skills/pareto-delegate` and/or `~/.codex/skills/pareto-delegate`.

## Development & evals

```bash
bun install
bun run typecheck       # strict tsc --noEmit
bun run test            # unit + routing tests
bun run eval:sim        # online feedback-loop simulation: hidden per-family bias, recovery, exploration
bun run eval:setup      # prepare isolated live canary workdirs
bun run eval:grade      # grade live canary arms
```

See [DESIGN.md](./DESIGN.md) for the rationale and [SKILL.md](./SKILL.md) for the runtime policy. Data from [Artificial Analysis](https://artificialanalysis.ai/) and [Epoch AI](https://epoch.ai/benchmarks) (CC-BY 4.0; external benchmarks such as CursorBench retain their original licences); attribution required.
