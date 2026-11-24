# pareto-delegate

A relocatable skill for routing delegated agent tasks across providers, models and reasoning effort levels. Works in **T3 Code** (multi- or single-provider via `delegate_task`) and in **standalone harnesses** (Claude Code `Agent`, Antigravity `invoke_subagent`, Codex `spawn_agent`).

## How it works

- **One call per delegation.** `scripts/route.ts` takes a task's category, capability floor (R0–R3), verifiability and blast radius and prints the chosen `(provider, model, options)`, harness hints, fallbacks and a telemetry template. The agent never reads the data files.
- **Roles, not one index.** Categories map to roles (scout, implement, debug, design, review). Each role has its own quality composite over Artificial Analysis metrics, token profile, latency value and failure cost ([roles.json](./roles.json)).
- **Comparable quality scale.** Every AA metric (coding/agentic indices, Terminal-Bench, LCR, IFBench, …) is quantile-mapped onto the intelligence-index scale, so floors stay in familiar index points whichever metrics are available.
- **Expected cost, not a weighted score.** Among live candidates that clear the floor:
  `E = $tokens × quota multiplier × cost_multiplier + $/min × wait + (1 − P(pass)) × failure cost`.
  `$tokens` uses the role's input/cache/output mix with AA's input, cache-hit and output prices, and output scaled by each model/effort's AA-measured verbosity. `P(pass)` is logistic in quality − floor.
- **Runtime-applied tunables.** Overrides ([overrides.json](./overrides.json) + `overrides.local.json`), quota ([quota.json](./quota.json) / `quota.local.json`) and roles (`roles.local.json`) apply at route time, so editing them never needs a resync and nothing machine-specific is baked into `frontier.json`.
- **Learning loop.** `outcomes.jsonl` records predicted P(pass) and the actual result; [scripts/calibrate.ts](./scripts/calibrate.ts) turns the gap into suggested `quality_bias` overrides.

## Data sources

| Source | How | Metrics |
|---|---|---|
| Daily mirror (default, no key) | `sync-benchmarks.ts` | Intelligence index, prices, task cost, speed, TTFT |
| AA API free tier | `ARTIFICIAL_ANALYSIS_API_KEY` set | + coding index, agentic index, cache-hit price |
| AA API Pro tier | same key, Pro subscription | + per-eval scores (Terminal-Bench, AA-LCR, IFBench, SciCode, …), measured token counts |

The sync tries the Pro endpoint first and falls back to the free endpoint on 401/403. Metrics reported by fewer than `min_metric_coverage` snapshot models are ignored.

## Usage (any working directory)

Runs with `bun` or `node --experimental-strip-types` (Node 22.6+; Node 23.6+ needs no flag).

```bash
# Route a task
bun run <skill-dir>/scripts/route.ts --category bugfix --floor R1 --verify strict --blast isolated_module
bun run <skill-dir>/scripts/route.ts --category research --floor R0 --provider claudeAgent      # standalone Claude Code
bun run <skill-dir>/scripts/route.ts --category primary_review --floor R2 --author-family gemini --explain

# Refresh AA data (mirror, or API when the key is set) and regenerate frontier.json + routes.md
bun run <skill-dir>/scripts/sync-benchmarks.ts
ARTIFICIAL_ANALYSIS_API_KEY=... bun run <skill-dir>/scripts/sync-benchmarks.ts --refresh

# Add newly enabled models (offline-first; fetches if not in the cached snapshot)
bun run <skill-dir>/scripts/sync-benchmarks.ts --models codex:gpt-6.2-astra,cursor:grok-4.7
bun run <skill-dir>/scripts/sync-benchmarks.ts --capabilities capabilities.json

# Check live model IDs (no network; exits 2 if any are unknown)
bun run <skill-dir>/scripts/sync-benchmarks.ts --check-models claude-opus-5-5,gemini-4-neon

# Regenerate the no-CLI fallback table after editing tunables
bun run <skill-dir>/scripts/route.ts --table --write

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

Parameters worth revisiting first, in order of leverage: `failure_cost_usd` per role, `value_per_minute_usd`, `quota_cost_multipliers`, then per-family `quality_bias` once `calibrate.ts` has data.

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
bun run eval:sim        # feedback-loop simulation: hidden per-family bias, recovery via calibrate
bun run eval:setup      # prepare isolated live canary workdirs
bun run eval:grade      # grade live canary arms
```

See [DESIGN.md](./DESIGN.md) for the rationale and [SKILL.md](./SKILL.md) for the runtime policy. Data from [Artificial Analysis](https://artificialanalysis.ai/); attribution required.
